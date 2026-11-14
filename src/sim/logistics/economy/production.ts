import type { LogisticsWorld } from '../core/world.ts';
import { sortedIds } from '../core/sortedIds.ts';
import { addDemand, addSupply, askPrice, bidPrice } from './markets.ts';
import type { Facility, GoodId, Recipe, Settlement } from './types.ts';

const producesSurvival = (world: LogisticsWorld, recipeId: string): boolean =>
  world.recipes
    .get(recipeId)
    ?.outputs.some((o) => world.goods.get(o.good)?.category === 'survival') ?? false;

/**
 * Survival-first facility order per world and facilities array (rebuilt when investment adds
 * a facility, which changes the array's length).
 * Keyed by world too: settlements share their scenario's array, but recipes are per world.
 */
const orderCache = new WeakMap<LogisticsWorld, WeakMap<readonly Facility[], readonly Facility[]>>();

function survivalFirstOrder(s: Settlement, world: LogisticsWorld): readonly Facility[] {
  let cache = orderCache.get(world);
  if (!cache) orderCache.set(world, (cache = new WeakMap()));
  const cached = cache.get(s.facilities);
  if (cached && cached.length === s.facilities.length) return cached;
  const order = s.facilities.toSorted(
    (a, b) =>
      Number(producesSurvival(world, b.recipeId)) - Number(producesSurvival(world, a.recipeId)),
  );
  cache.set(s.facilities, order);
  return order;
}

/**
 * Run facilities (life support first, otherwise in declared order). Output is limited by
 * capacity, available workers and input stock. Nominal input demand is recorded even when
 * inputs are missing, so shortages show up as high prices. Employed workers wear out
 * machinery; without it, every facility slowly loses capacity (#14).
 */
export function runProduction(s: Settlement, world: LogisticsWorld, dtDays: number): void {
  if (s.isDeepMarket) return;
  const workforce = s.population * world.constants.population.workforceFraction;
  const k = Math.min(1, dtDays / world.constants.population.satisfactionEmaDays);
  let workers = workforce;
  const reserve = lifeSupportReserve(s, world);
  const prices = unitPrices(s, world);
  const surplus = survivalSurplus(s, world);
  // Life support first: recipes that output survival goods get workers and inputs first.
  for (const f of survivalFirstOrder(s, world)) {
    const recipe = world.recipes.get(f.recipeId);
    if (!recipe) continue;
    // Industry may only use what life support doesn't need (water → fuel, ice → fuel).
    const lifeSupport = producesSurvival(world, f.recipeId);
    // Industry idles, and stops asking for inputs, while its output is worth less than them.
    if (!lifeSupport && !pays(recipe, prices)) {
      f.utilisation = f.utilisation === undefined ? 0 : f.utilisation * (1 - k);
      continue;
    }
    const usable = (good: GoodId) =>
      lifeSupport
        ? s.market[good].stock
        : Math.max(0, s.market[good].stock - (reserve.get(good) ?? 0));
    let rate = f.maxRatePerDay;
    if (recipe.workersPerUnitPerDay > 0)
      rate = Math.min(rate, workers / recipe.workersPerUnitPerDay);
    const nominal = rate;
    for (const i of recipe.inputs) {
      rate = Math.min(rate, usable(i.good) / (i.qty * dtDays));
      // Industry runs on the local surplus of survival goods, never on imports.
      const spare = lifeSupport ? undefined : surplus.get(i.good);
      if (spare !== undefined) rate = Math.min(rate, spare / i.qty);
    }
    rate = Math.max(0, rate);
    // Nominal demand shows shortages as prices, except for reserved goods: industry doesn't
    // get to drive life-support imports.
    for (const i of recipe.inputs) {
      const protectedGood = !lifeSupport && reserve.has(i.good);
      addDemand(s, i.good, (protectedGood ? rate : nominal) * i.qty * dtDays);
    }
    const used = rate > 0 ? rate / f.maxRatePerDay : 0;
    f.utilisation = f.utilisation === undefined ? used : f.utilisation + (used - f.utilisation) * k;
    if (!(rate > 0)) continue;
    for (const i of recipe.inputs) {
      s.market[i.good].stock = Math.max(0, s.market[i.good].stock - rate * i.qty * dtDays);
      const spare = lifeSupport ? undefined : surplus.get(i.good);
      if (spare !== undefined) surplus.set(i.good, spare - rate * i.qty);
    }
    for (const o of recipe.outputs) {
      const qty = rate * o.qty * dtDays;
      s.market[o.good].stock += qty;
      addSupply(s, o.good, qty);
    }
    workers -= rate * recipe.workersPerUnitPerDay;
  }
  s.idleWorkers = Math.max(0, workers);
  maintain(s, world, workforce - workers, dtDays);
}

interface UnitPrices {
  input: (good: GoodId) => number;
  output: (good: GoodId) => number;
}

/**
 * What a tonne of each good costs as an input and fetches as output. Inputs cost the local
 * price, or the ask of a deep market on the same body if that is dearer: that is where the
 * local shuttle buys them. Output fetches the best of the local price, that deep market's bid
 * and an Earth export netback. Without this, Gateway ran a water → fuel plant on water bought
 * from Earth until its own buying drove Earth's water price above what the fuel sold for, and
 * kept running it at a loss until the station could no longer buy food.
 */
function unitPrices(s: Settlement, world: LogisticsWorld): UnitPrices {
  const c = world.constants.markets;
  let deep: Settlement | null = null;
  let earth: Settlement | null = null;
  for (const id of sortedIds(world.settlements)) {
    const o = world.settlements.get(id)!;
    if (!o.isDeepMarket) continue;
    earth ??= o;
    if (o.site.bodyId === s.site.bodyId) deep ??= o;
  }
  const netback = world.constants.industry.exportNetback;
  return {
    input: (g) => Math.max(s.market[g].price, deep ? askPrice(deep.market[g], c) : 0),
    output: (g) =>
      Math.max(
        s.market[g].price,
        deep ? bidPrice(deep.market[g], c, Number.POSITIVE_INFINITY, 0) : 0,
        earth ? earth.market[g].price * netback : 0,
      ),
  };
}

const pays = (recipe: Recipe, p: UnitPrices): boolean =>
  recipe.outputs.reduce((a, o) => a + o.qty * p.output(o.good), 0) >=
  recipe.inputs.reduce((a, i) => a + i.qty * p.input(i.good), 0);

/**
 * Tonnes per day of each survival good made here beyond the people's needs and the inputs of
 * local life support at capacity: all industry may use of it. Without this, a water → fuel
 * plant at Vesta ate imported water, so food investment (which needs local water) never
 * counted as urgent and the colony outgrew its food.
 */
function survivalSurplus(s: Settlement, world: LogisticsWorld): Map<GoodId, number> {
  const needs = world.constants.population.needsPerCapitaPerDay.survival;
  const surplus = new Map<GoodId, number>();
  for (const good of Object.keys(needs) as GoodId[]) {
    surplus.set(good, s.market[good].productionPerDay - s.population * (needs[good] ?? 0));
  }
  for (const f of s.facilities) {
    if (!producesSurvival(world, f.recipeId)) continue;
    for (const i of world.recipes.get(f.recipeId)?.inputs ?? []) {
      const left = surplus.get(i.good);
      if (left !== undefined) surplus.set(i.good, left - f.maxRatePerDay * i.qty);
    }
  }
  for (const [g, v] of surplus) surplus.set(g, Math.max(0, v));
  return surplus;
}

/**
 * Stock industry must leave alone: `survivalInputReserveDays` of the people's survival needs
 * and of the inputs local life-support facilities use at capacity.
 */
function lifeSupportReserve(s: Settlement, world: LogisticsWorld): Map<GoodId, number> {
  const days = world.constants.industry.survivalInputReserveDays;
  const reserve = new Map<GoodId, number>();
  const add = (good: GoodId, perDay: number) =>
    reserve.set(good, (reserve.get(good) ?? 0) + perDay * days);
  const needs = world.constants.population.needsPerCapitaPerDay.survival;
  for (const [good, perCapita] of Object.entries(needs) as [GoodId, number][]) {
    add(good, s.population * perCapita);
  }
  for (const f of s.facilities) {
    if (!producesSurvival(world, f.recipeId)) continue;
    for (const i of world.recipes.get(f.recipeId)?.inputs ?? [])
      add(i.good, f.maxRatePerDay * i.qty);
  }
  return reserve;
}

/** Consume maintenance machinery for `employed` workers; wear facilities for any shortfall. */
function maintain(s: Settlement, world: LogisticsWorld, employed: number, dtDays: number): void {
  const c = world.constants.industry;
  const need = employed * c.maintenancePerWorkerDay * dtDays;
  if (!(need > 0)) return;
  const e = s.market.machinery;
  addDemand(s, 'machinery', need);
  const used = Math.min(e.stock, need);
  e.stock -= used;
  const shortfall = 1 - used / need;
  if (shortfall <= 0) return;
  const keep = 1 - (c.wearPerYear * shortfall * dtDays) / 365.25;
  for (const f of s.facilities) {
    f.maxRatePerDay = Math.max(Math.min(f.maxRatePerDay, c.minRatePerDay), f.maxRatePerDay * keep);
  }
}
