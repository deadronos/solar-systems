import type { LogisticsWorld } from '../core/world.ts';
import { addDemand, addSupply } from './markets.ts';
import type { Settlement } from './types.ts';

/**
 * Run each facility in declared order. Output is limited by capacity, available workers
 * and input stock. Nominal input demand is recorded even when inputs are missing, so
 * shortages show up as high prices.
 */
export function runProduction(s: Settlement, world: LogisticsWorld, dtDays: number): void {
  if (s.isDeepMarket) return;
  let workers = s.population * world.constants.workforceFraction;
  for (const f of s.facilities) {
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
