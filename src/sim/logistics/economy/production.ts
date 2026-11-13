import type { LogisticsWorld } from '../core/world.ts';
import { addDemand, addSupply } from './markets.ts';
import type { Facility, Settlement } from './types.ts';

const producesSurvival = (world: LogisticsWorld, recipeId: string): boolean =>
  world.recipes
    .get(recipeId)
    ?.outputs.some((o) => world.goods.get(o.good)?.category === 'survival') ?? false;

/**
 * Survival-first facility order per world and facilities array (facilities never change today).
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
 * Run facilities (life support first, otherwise in declared order). Output is limited by capacity, available workers
 * and input stock. Nominal input demand is recorded even when inputs are missing, so
 * shortages show up as high prices.
 */
export function runProduction(s: Settlement, world: LogisticsWorld, dtDays: number): void {
  if (s.isDeepMarket) return;
  let workers = s.population * world.constants.population.workforceFraction;
  // Life support first: recipes that output survival goods get workers and inputs first.
  for (const f of survivalFirstOrder(s, world)) {
    const recipe = world.recipes.get(f.recipeId);
    if (!recipe) continue;
    let rate = f.maxRatePerDay;
    if (recipe.workersPerUnitPerDay > 0)
      rate = Math.min(rate, workers / recipe.workersPerUnitPerDay);
    for (const i of recipe.inputs) addDemand(s, i.good, rate * i.qty * dtDays);
    for (const i of recipe.inputs) {
      rate = Math.min(rate, s.market[i.good].stock / (i.qty * dtDays));
    }
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
}
