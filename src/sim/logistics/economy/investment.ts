import { sortedIds } from '../core/sortedIds.ts';
import { TICK_DAYS } from '../core/time.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { fmtMoney } from '../format.ts';
import { survivalReserve } from './contracts.ts';
import { availableFunds } from './treasury.ts';
import type { GoodId, InvestmentProject, Recipe, RecipeLine, Settlement } from './types.ts';

/**
 * Settlements invest in industry (#14). Every `industry.reviewDays` a settlement without a
 * project picks the facility to expand or build that adds the most margin per day, given its
 * idle workers, its local prices and Earth's prices for output nobody here uses. Short life
 * support jumps the queue. The project then waits for its build kit (machinery and steel),
 * which the settlement imports through ordinary buy orders, and completes when the kit is in
 * stock.
 */
export function runInvestment(world: LogisticsWorld, dtDays: number): void {
  const c = world.constants.industry;
  const tick = Math.round((world.jd - world.config.startJd) / TICK_DAYS);
  const review = tick % Math.round(c.reviewDays / TICK_DAYS) === 0;
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.isDeepMarket) continue;
    if (s.project) advanceProject(world, s, s.project, dtDays);
    else if (review) startProject(world, s);
  }
}

function advanceProject(
  world: LogisticsWorld,
  s: Settlement,
  p: InvestmentProject,
  dtDays: number,
): void {
  const c = world.constants.industry;
  if (p.kit.every((k) => s.market[k.good].stock >= k.qty)) {
    for (const k of p.kit) s.market[k.good].stock -= k.qty;
    const existing = s.facilities.find((f) => f.recipeId === p.recipeId);
    if (existing) existing.maxRatePerDay += p.addRatePerDay;
    else s.facilities.push({ recipeId: p.recipeId, maxRatePerDay: p.addRatePerDay });
    s.project = null;
    world.events.append(world.jd, {
      type: 'FacilityBuilt',
      settlementId: s.id,
      recipeId: p.recipeId,
      ratePerDay: existing?.maxRatePerDay ?? p.addRatePerDay,
      isNew: !existing,
    });
    return;
  }
  if (world.jd - p.startedJd > c.projectTimeoutDays) {
    s.project = null;
    world.events.append(world.jd, {
      type: 'InvestmentAbandoned',
      settlementId: s.id,
      recipeId: p.recipeId,
    });
    return;
  }
  // Spread kit demand like housing materials, so imports are ordered steadily.
  for (const k of p.kit) {
    const flows = s.flows.demand;
    flows[k.good] = (flows[k.good] ?? 0) + (k.qty * dtDays) / c.kitDemandDays;
  }
}

interface Option {
  recipe: Recipe;
  addRatePerDay: number;
  isNew: boolean;
  kit: RecipeLine[];
  marginPerDay: number;
  urgentGood: GoodId | null;
  /** Locally made inputs that kept urgent life support from counting as urgent (imports). */
  blockedBy: GoodId[];
  /** False when the option only reports `blockedBy` (it doesn't pay and isn't urgent). */
  viable: boolean;
}

/** Share of the workforce urgent life support may claim from industry. */
const LIFE_SUPPORT_WORKER_SHARE = 0.05;

const producesSurvival = (world: LogisticsWorld, recipe: Recipe): boolean =>
  recipe.outputs.some((o) => world.goods.get(o.good)?.category === 'survival');

function startProject(world: LogisticsWorld, s: Settlement): void {
  // Life support is staffed first (production runs it before industry), so urgent life
  // support may be sized from the whole workforce, taking workers from industry. Without
  // this, Vesta's mines took every worker and its food farm could never grow (#20).
  const idle = Math.max(
    s.idleWorkers ?? 0,
    s.population * world.constants.population.workforceFraction * LIFE_SUPPORT_WORKER_SHARE,
  );
  if (idle < 1) return;
  const funds = availableFunds(s) - survivalReserve(world, s);
  // Urgent life support that would run on imported survival inputs (a food farm short of
  // local water) makes the facilities producing those inputs urgent instead.
  // Followed up to three links (food ← water ← ice).
  const upstream = new Set<GoodId>();
  for (let pass = 0; pass < 3; pass++) {
    const before = upstream.size;
    for (const id of sortedIds(world.recipes)) {
      for (const g of evaluate(world, s, world.recipes.get(id)!, idle, upstream)?.blockedBy ?? [])
        upstream.add(g);
    }
    if (upstream.size === before) break;
  }
  let best: Option | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const id of sortedIds(world.recipes)) {
    const recipe = world.recipes.get(id)!;
    let option = evaluate(world, s, recipe, idle, upstream);
    // Only urgent life support may claim employed workers; size anything else from idle ones.
    const spare = s.idleWorkers ?? 0;
    if (option && !option.urgentGood && option.addRatePerDay * recipe.workersPerUnitPerDay > spare)
      option = spare >= 1 ? evaluate(world, s, recipe, spare, upstream) : null;
    if (!option?.viable) continue;
    if (kitCost(world, s, option.kit) > funds) continue;
    // Life support for a short good comes first, whatever its margin.
    const score = option.urgentGood ? 1e15 + option.marginPerDay : option.marginPerDay;
    if (score > bestScore) {
      best = option;
      bestScore = score;
    }
  }
  if (!best) return;
  s.project = {
    recipeId: best.recipe.id,
    addRatePerDay: best.addRatePerDay,
    isNew: best.isNew,
    kit: best.kit,
    startedJd: world.jd,
  };
  const payback = kitCost(world, s, best.kit) / best.marginPerDay;
  world.events.append(world.jd, {
    type: 'InvestmentDecision',
    settlementId: s.id,
    recipeId: best.recipe.id,
    ratePerDay: best.addRatePerDay,
    isNew: best.isNew,
    reason: best.urgentGood
      ? `life support: ${best.urgentGood} production is short`
      : `+${fmtMoney(best.marginPerDay)}/day, pays back in ${Math.round(payback)} days`,
  });
}

/** What expanding or building `recipe` here would add, or null if it can't or shouldn't. */
function evaluate(
  world: LogisticsWorld,
  s: Settlement,
  recipe: Recipe,
  idle: number,
  upstream: ReadonlySet<GoodId> = new Set(),
): Option | null {
  const c = world.constants.industry;
  const wpu = recipe.workersPerUnitPerDay;
  if (!(wpu > 0)) return null;
  // Only life support may draw on the workers industry already employs (see startProject).
  if (!producesSurvival(world, recipe)) idle = Math.min(idle, s.idleWorkers ?? 0);
  const existing = s.facilities.find((f) => f.recipeId === recipe.id);
  let addRatePerDay: number;
  if (existing) {
    // Expanding only helps a facility that is limited by its capacity.
    if ((existing.utilisation ?? 0) < c.minUtilisation) return null;
    // At least one worker's worth: 10% of a small farm is less than one person's work.
    addRatePerDay = Math.min(
      Math.max(existing.maxRatePerDay * c.expansionFraction, 1 / wpu),
      idle / wpu,
    );
  } else {
    const extraction = recipe.inputs.length === 0;
    if (extraction && !s.deposits?.includes(recipe.id)) return null;
    addRatePerDay = Math.min(c.newFacilityWorkers, idle) / wpu;
  }
  const workers = addRatePerDay * wpu;
  if (workers < 1) return null;

  let value = 0;
  let urgentGood: GoodId | null = null;
  for (const o of recipe.outputs) {
    value += o.qty * outputValue(world, s, o.good, addRatePerDay * o.qty);
    const e = s.market[o.good];
    const survival = world.goods.get(o.good)?.category === 'survival';
    if (
      (survival && e.productionPerDay < e.consumptionPerDay * c.survivalMargin) ||
      upstream.has(o.good)
    ) {
      urgentGood ??= o.good;
    }
  }
  // Inputs local output can't cover must be imported: price them at import cost.
  let importsInputs = false;
  const blockedBy: GoodId[] = [];
  for (const i of recipe.inputs) {
    const e = s.market[i.good];
    const local = e.productionPerDay >= e.consumptionPerDay + addRatePerDay * i.qty;
    if (!local) {
      importsInputs = true;
      if (e.productionPerDay > 0) blockedBy.push(i.good);
    }
    value -= i.qty * (local ? e.price : importPrice(world, s, i.good));
  }
  // Urgent life support must run on local inputs, or it only moves the shortage into imports.
  const wasUrgent = urgentGood !== null;
  if (importsInputs) urgentGood = null;
  if (!wasUrgent) blockedBy.length = 0;
  const maintenance = workers * c.maintenancePerWorkerDay * importPrice(world, s, 'machinery');
  const marginPerDay = addRatePerDay * value - maintenance;
  const kit = c.kitPerWorker.map((k) => ({ good: k.good, qty: Math.ceil(k.qty * workers) }));
  const viable =
    urgentGood !== null ||
    (marginPerDay > 0 && kitCost(world, s, kit) / marginPerDay <= c.maxPaybackDays);
  if (!viable && blockedBy.length === 0) return null;
  return {
    recipe,
    addRatePerDay,
    isNew: !existing,
    kit,
    marginPerDay,
    urgentGood,
    blockedBy,
    viable,
  };
}

/** Earth's price for a good, if the scenario has a deep market. */
function earthPrice(world: LogisticsWorld, good: GoodId): number {
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.isDeepMarket) return s.market[good].price;
  }
  return world.goods.get(good)?.basePrice ?? 0;
}

/**
 * Average value per tonne of `addPerDay` more output: the local price for the part that
 * fills the gap between local use and local output, and what exporting the rest to Earth
 * would net after hauling. Pricing all of a big plant's output at a scarce local price made
 * a 195 t/day fuel plant look like it paid back in weeks at a station using a few tonnes a
 * day; it then bankrupted the station importing water to feed it.
 */
export function outputValue(
  world: LogisticsWorld,
  s: Settlement,
  good: GoodId,
  addPerDay: number,
): number {
  const e = s.market[good];
  const netback = earthPrice(world, good) * world.constants.industry.exportNetback;
  if (!(addPerDay > 0)) return e.productionPerDay < e.consumptionPerDay ? e.price : netback;
  // Capacity counts as supply even while idle (short of inputs), or a second plant looks
  // as needed as the first.
  const supply = Math.max(e.productionPerDay, outputCapacity(world, s, good));
  const local = Math.min(addPerDay, Math.max(0, e.consumptionPerDay - supply));
  return (local * e.price + (addPerDay - local) * netback) / addPerDay;
}

/** Tonnes per day of `good` the settlement's facilities can make at full rate. */
function outputCapacity(world: LogisticsWorld, s: Settlement, good: GoodId): number {
  let t = 0;
  for (const f of s.facilities) {
    for (const o of world.recipes.get(f.recipeId)?.outputs ?? []) {
      if (o.good === good) t += f.maxRatePerDay * o.qty;
    }
  }
  return t;
}

/** Cost of bringing a good in: the dearer of the local price and Earth's. */
const importPrice = (world: LogisticsWorld, s: Settlement, good: GoodId): number =>
  Math.max(s.market[good].price, earthPrice(world, good));

function kitCost(world: LogisticsWorld, s: Settlement, kit: RecipeLine[]): number {
  return kit.reduce((a, k) => a + k.qty * importPrice(world, s, k.good), 0);
}
