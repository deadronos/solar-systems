import type { LogisticsWorld } from '../core/world.ts';
import { GOOD_IDS, type EconomyConstants, type MarketEntry, type Settlement } from './types.ts';

/** Settlements stop buying once stock reaches this multiple of target stock. */
const MAX_STOCK_MULTIPLE = 3;
/** Price change (fraction) that triggers a PriceChanged event. */
const ANNOUNCE_THRESHOLD = 0.25;

export function priceFor(
  basePrice: number,
  stock: number,
  targetStock: number,
  c: EconomyConstants,
): number {
  if (targetStock <= 0) return basePrice;
  const ratio = Math.max(stock, 0) / targetStock;
  const raw = ratio > 0 ? ratio ** -c.elasticity : Number.POSITIVE_INFINITY;
  return basePrice * Math.min(c.priceClampMax, Math.max(c.priceClampMin, raw));
}

/** Price at which the settlement sells to traders. */
export const askPrice = (e: MarketEntry, c: EconomyConstants): number =>
  e.price * (1 + c.spread / 2);

/** Price at which the settlement buys from traders; 0 if it can't pay for `qty` or has no use for it. */
export function bidPrice(
  e: MarketEntry,
  c: EconomyConstants,
  treasury: number,
  qty: number,
): number {
  if (e.consumptionPerDay <= 0) return 0;
  const p = e.price * (1 - c.spread / 2);
  return treasury >= p * qty ? p : 0;
}

/** Tonnes the settlement is still willing to buy. */
export const maxBuyQty = (e: MarketEntry): number =>
  Math.max(0, MAX_STOCK_MULTIPLE * e.targetStock - e.stock);

export function addDemand(s: Settlement, good: keyof Settlement['market'], qty: number): void {
  s.flows.demand[good] = (s.flows.demand[good] ?? 0) + qty;
}

export function addSupply(s: Settlement, good: keyof Settlement['market'], qty: number): void {
  s.flows.supply[good] = (s.flows.supply[good] ?? 0) + qty;
}

/**
 * Fold this tick's flows into the rolling consumption/production rates, recompute target
 * stock and price. Deep markets keep fixed prices and effectively unlimited stock.
 */
export function updateMarket(s: Settlement, world: LogisticsWorld, dtDays: number): void {
  const c = world.constants;
  const k = Math.min(1, dtDays / c.satisfactionEmaDays);
  for (const g of GOOD_IDS) {
    const e = s.market[g];
    const base = (world.goods.get(g)?.basePrice ?? 0) * (s.deepPriceFactors?.[g] ?? 1);
    if (s.isDeepMarket) {
      e.stock = c.deepMarketStock;
      e.targetStock = c.deepMarketStock;
      e.price = base;
      e.consumptionPerDay = 1;
      continue;
    }
    const demand = (s.flows.demand[g] ?? 0) / dtDays;
    const supply = (s.flows.supply[g] ?? 0) / dtDays;
    e.consumptionPerDay += (demand - e.consumptionPerDay) * k;
    e.productionPerDay += (supply - e.productionPerDay) * k;
    const flow = e.consumptionPerDay + e.productionPerDay;
    e.targetStock = flow > 1e-6 ? Math.max(1, flow * c.bufferDays) : 0;
    e.price = flow > 1e-6 ? priceFor(base, e.stock, e.targetStock, c) : base * c.priceClampMin;
    if (Math.abs(e.price / e.lastAnnouncedPrice - 1) > ANNOUNCE_THRESHOLD) {
      world.events.append(world.jd, {
        type: 'PriceChanged',
        settlementId: s.id,
        good: g,
        from: e.lastAnnouncedPrice,
        to: e.price,
      });
      e.lastAnnouncedPrice = e.price;
    }
  }
  s.flows.demand = {};
  s.flows.supply = {};
}

/**
 * Seed rolling rates from nominal demand (population needs + facility inputs at capacity)
 * and nominal output, so prices are sensible from the first tick.
 */
export function initMarketRates(s: Settlement, world: LogisticsWorld): void {
  if (s.isDeepMarket) return;
  const c = world.constants;
  for (const tier of Object.values(c.needsPerCapitaPerDay)) {
    for (const [good, perCapita] of Object.entries(tier) as [
      keyof Settlement['market'],
      number,
    ][]) {
      s.market[good].consumptionPerDay += s.population * perCapita;
    }
  }
  for (const f of s.facilities) {
    const r = world.recipes.get(f.recipeId);
    if (!r) continue;
    for (const i of r.inputs) s.market[i.good].consumptionPerDay += f.maxRatePerDay * i.qty;
    for (const o of r.outputs) s.market[o.good].productionPerDay += f.maxRatePerDay * o.qty;
  }
  for (const g of GOOD_IDS) {
    const e = s.market[g];
    const base = world.goods.get(g)?.basePrice ?? 0;
    const flow = e.consumptionPerDay + e.productionPerDay;
    e.targetStock = flow > 1e-6 ? Math.max(1, flow * c.bufferDays) : 0;
    e.price = flow > 1e-6 ? priceFor(base, e.stock, e.targetStock, c) : base * c.priceClampMin;
    e.lastAnnouncedPrice = e.price;
  }
}
