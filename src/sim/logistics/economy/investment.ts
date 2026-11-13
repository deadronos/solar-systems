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
}

function startProject(world: LogisticsWorld, s: Settlement): void {
  const idle = s.idleWorkers ?? 0;
  if (idle < 1) return;
  const funds = availableFunds(s) - survivalReserve(world, s);
  let best: Option | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const id of sortedIds(world.recipes)) {
    const option = evaluate(world, s, world.recipes.get(id)!, idle);
    if (!option) continue;
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
): Option | null {
  const c = world.constants.industry;
  const wpu = recipe.workersPerUnitPerDay;
  if (!(wpu > 0)) return null;
  const existing = s.facilities.find((f) => f.recipeId === recipe.id);
  let addRatePerDay: number;
  if (existing) {
    // Expanding only helps a facility that is limited by its capacity.
    if ((existing.utilisation ?? 0) < c.minUtilisation) return null;
    addRatePerDay = Math.min(existing.maxRatePerDay * c.expansionFraction, idle / wpu);
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
    value += o.qty * outputValue(world, s, o.good);
    const e = s.market[o.good];
    const survival = world.goods.get(o.good)?.category === 'survival';
    if (survival && e.productionPerDay < e.consumptionPerDay * c.survivalMargin) {
      urgentGood ??= o.good;
    }
  }
  // Inputs local output can't cover must be imported: price them at import cost.
  let importsInputs = false;
  for (const i of recipe.inputs) {
    const e = s.market[i.good];
    const local = e.productionPerDay >= e.consumptionPerDay + addRatePerDay * i.qty;
    if (!local) importsInputs = true;
    value -= i.qty * (local ? e.price : importPrice(world, s, i.good));
  }
  // Urgent life support must run on local inputs, or it only moves the shortage into imports.
  if (importsInputs) urgentGood = null;
  const maintenance = workers * c.maintenancePerWorkerDay * importPrice(world, s, 'machinery');
  const marginPerDay = addRatePerDay * value - maintenance;
  const kit = c.kitPerWorker.map((k) => ({ good: k.good, qty: Math.ceil(k.qty * workers) }));
  if (!urgentGood) {
    if (!(marginPerDay > 0)) return null;
    if (kitCost(world, s, kit) / marginPerDay > c.maxPaybackDays) return null;
  }
  return { recipe, addRatePerDay, isNew: !existing, kit, marginPerDay, urgentGood };
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
 * Value of one more tonne of output: the local price while local use exceeds local output,
 * otherwise what exporting it to Earth would net after hauling.
 */
function outputValue(world: LogisticsWorld, s: Settlement, good: GoodId): number {
  const e = s.market[good];
  if (e.productionPerDay < e.consumptionPerDay) return e.price;
  return earthPrice(world, good) * world.constants.industry.exportNetback;
}

/** Cost of bringing a good in: the dearer of the local price and Earth's. */
const importPrice = (world: LogisticsWorld, s: Settlement, good: GoodId): number =>
  Math.max(s.market[good].price, earthPrice(world, good));

function kitCost(world: LogisticsWorld, s: Settlement, kit: RecipeLine[]): number {
  return kit.reduce((a, k) => a + k.qty * importPrice(world, s, k.good), 0);
}
