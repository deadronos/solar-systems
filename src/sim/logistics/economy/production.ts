import type { LogisticsWorld } from '../core/world.ts';
import { addDemand, addSupply } from './markets.ts';
import type { Facility, GoodId, Settlement } from './types.ts';

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
  // Life support first: recipes that output survival goods get workers and inputs first.
  for (const f of survivalFirstOrder(s, world)) {
    const recipe = world.recipes.get(f.recipeId);
    if (!recipe) continue;
    // Industry may only use what life support doesn't need (water → fuel, ice → fuel).
    const lifeSupport = producesSurvival(world, f.recipeId);
    const usable = (good: GoodId) =>
      lifeSupport
        ? s.market[good].stock
        : Math.max(0, s.market[good].stock - (reserve.get(good) ?? 0));
    let rate = f.maxRatePerDay;
    if (recipe.workersPerUnitPerDay > 0)
      rate = Math.min(rate, workers / recipe.workersPerUnitPerDay);
    const nominal = rate;
    for (const i of recipe.inputs) rate = Math.min(rate, usable(i.good) / (i.qty * dtDays));
    // Nominal demand shows shortages as prices, except for reserved goods: industry doesn't
    // get to drive life-support imports.
    for (const i of recipe.inputs) {
      const protectedGood = !lifeSupport && reserve.has(i.good);
      addDemand(s, i.good, (protectedGood ? rate : nominal) * i.qty * dtDays);
    }
    const used = rate > 0 ? rate / f.maxRatePerDay : 0;
    f.utilisation = f.utilisation === undefined ? used : f.utilisation + (used - f.utilisation) * k;
    if (!(rate > 0)) continue;
    for (const i of recipe.inputs)
      s.market[i.good].stock = Math.max(0, s.market[i.good].stock - rate * i.qty * dtDays);
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
