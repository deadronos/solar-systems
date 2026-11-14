import { ECONOMY_CONSTANTS } from '../data/economyConstants.ts';
import type { LogisticsWorld } from '../core/world.ts';
import {
  GOOD_IDS,
  type EconomyConstants,
  type GoodId,
  type MarketEntry,
  type Settlement,
} from './types.ts';

export type PriceBand = 'cheap' | 'normal' | 'scarce';

/** Price / base price below which a good is "cheap". */
const CHEAP_BELOW = 0.7;
/** Price / base price above which a good is "scarce". */
const SCARCE_ABOVE = 1.5;
/** How far (as a factor) past a band edge a price must go to leave its band (hysteresis). */
const BAND_HYSTERESIS = 1.15;
/**
 * Minimum days between PriceChanged events for one (settlement, good). Thin colony markets
 * swing between the price clamps, and without this they flood the event log (#13).
 */
const ANNOUNCE_MIN_INTERVAL_DAYS = 30;

/** Band of a price relative to the good's base price (no hysteresis). */
export function priceBand(price: number, base: number): PriceBand {
  const r = price / base;
  return r < CHEAP_BELOW ? 'cheap' : r > SCARCE_ABOVE ? 'scarce' : 'normal';
}

/**
 * Band the price is in now, given the last announced band: a price must clear a band edge by
 * `BAND_HYSTERESIS` to leave it, so a price hovering at an edge doesn't flap.
 */
function bandWithHysteresis(price: number, base: number, from: PriceBand): PriceBand {
  const r = price / base;
  const h = BAND_HYSTERESIS;
  if (from === 'cheap')
    return r > SCARCE_ABOVE * h ? 'scarce' : r > CHEAP_BELOW * h ? 'normal' : from;
  if (from === 'scarce')
    return r < CHEAP_BELOW / h ? 'cheap' : r < SCARCE_ABOVE / h ? 'normal' : from;
  return r < CHEAP_BELOW / h ? 'cheap' : r > SCARCE_ABOVE * h ? 'scarce' : from;
}

/**
 * Whether the price has moved to another band since the last PriceChanged, and the minimum
 * interval has passed. Price history itself lives in the daily stats series, not the log.
 */
export function shouldAnnouncePrice(e: MarketEntry, base: number, jd: number): boolean {
  if (!(base > 0)) return false;
  const from = priceBand(e.lastAnnouncedPrice, base);
  if (bandWithHysteresis(e.price, base, from) === from) return false;
  // Snapshots from before #13 have no announcement date.
  return jd - (e.lastAnnouncedJd ?? Number.NEGATIVE_INFINITY) >= ANNOUNCE_MIN_INTERVAL_DAYS;
}

/** Tonnes above a source's reserve. A negative value means the reserve is short. */
export function spareStock(
  site: Pick<Settlement, 'isDeepMarket' | 'market'>,
  good: GoodId,
  sourceReserveFraction: number,
): number {
  if (site.isDeepMarket) return Number.POSITIVE_INFINITY;
  const entry = site.market[good];
  return entry.stock - sourceReserveFraction * entry.targetStock;
}

/** Desired stock: own needs for the buffer period plus a short buffer of own output. */
export const targetFor = (
  consumptionPerDay: number,
  productionPerDay: number,
  c: EconomyConstants['markets'],
): number => {
  const t = consumptionPerDay * c.bufferDays + productionPerDay * c.producerBufferDays;
  return t > 1e-6 ? Math.max(1, t) : 0;
};

export function priceFor(
  basePrice: number,
  stock: number,
  targetStock: number,
  c: EconomyConstants['markets'],
): number {
  if (targetStock <= 0) return basePrice;
  const ratio = Math.max(stock, 0) / targetStock;
  const raw = ratio > 0 ? ratio ** -c.elasticity : Number.POSITIVE_INFINITY;
  return basePrice * Math.min(c.priceClampMax, Math.max(c.priceClampMin, raw));
}

/** Price at which the settlement sells to traders. */
export const askPrice = (e: MarketEntry, c: EconomyConstants['markets']): number =>
  e.price * (1 + c.spread / 2);

/**
 * Price at which the settlement buys from traders; 0 if it can't pay for `qty` or has no use
 * for it. `funds` is the money it may spend (see `availableFunds`).
 */
export function bidPrice(
  e: MarketEntry,
  c: EconomyConstants['markets'],
  funds: number,
  qty: number,
): number {
  if (e.consumptionPerDay <= 0) return 0;
  const p = e.price * (1 - c.spread / 2);
  return funds >= p * qty ? p : 0;
}

/** Reference price of a good at a settlement (deep markets apply their price factors). */
export const basePriceAt = (
  world: Pick<LogisticsWorld, 'goods'>,
  s: Pick<Settlement, 'deepPriceFactors'>,
  good: GoodId,
): number => (world.goods.get(good)?.basePrice ?? 0) * (s.deepPriceFactors?.[good] ?? 1);

/**
 * Price on the curve once `deltaT` tonnes have moved into the market (negative: out of it).
 * Colonies price from stock against target; deep markets from recent net trade.
 */
function curvePrice(
  s: Pick<Settlement, 'isDeepMarket'>,
  e: MarketEntry,
  base: number,
  deltaT: number,
  c: EconomyConstants['markets'],
): number {
  if (s.isDeepMarket) return deepPriceFor(base, (e.netSoldT ?? 0) + deltaT, c);
  if (e.targetStock <= 0) return base * c.priceClampMin;
  return priceFor(base, e.stock + deltaT, e.targetStock, c);
}

/** Sample points for averaging the curve over an order. */
const SLIPPAGE_SAMPLES = 8;

/**
 * Average curve price over an order that moves `qty` tonnes into the market (negative: out),
 * starting `fromT` tonnes in: what the order would pay walking down the curve (#15).
 */
function slippedPrice(
  s: Pick<Settlement, 'isDeepMarket'>,
  e: MarketEntry,
  base: number,
  fromT: number,
  qty: number,
  c: EconomyConstants['markets'],
): number {
  if (qty === 0) return curvePrice(s, e, base, fromT, c);
  let sum = 0;
  for (let k = 0; k < SLIPPAGE_SAMPLES; k++) {
    sum += curvePrice(s, e, base, fromT + (qty * (k + 0.5)) / SLIPPAGE_SAMPLES, c);
  }
  return sum / SLIPPAGE_SAMPLES;
}

/**
 * Unit price a trader pays to buy `qty` tonnes: the posted price or the order's average along
 * the curve, whichever is higher, plus half the spread. Taking the dearer of the two means a
 * posted price that lags the curve (inertia) is never a bargain to snap up after a rival has
 * emptied the market.
 */
export function quoteBuy(
  world: Pick<LogisticsWorld, 'goods' | 'constants'>,
  s: Pick<Settlement, 'isDeepMarket' | 'market' | 'deepPriceFactors'>,
  good: GoodId,
  qty: number,
): number {
  const c = world.constants.markets;
  const e = s.market[good];
  const slipped = slippedPrice(s, e, basePriceAt(world, s, good), 0, -qty, c);
  return Math.max(e.price, slipped) * (1 + c.spread / 2);
}

/**
 * Unit price the settlement pays a trader for `qty` tonnes, or 0 if it has no use for the
 * good or can't pay (`funds`, see `availableFunds`). The lower of the posted price and the
 * order's average along the curve, less half the spread. With `incomingT`, the quote once
 * that many more tonnes have landed first, so a trader can price in cargo already on its way.
 */
export function quoteSell(
  world: Pick<LogisticsWorld, 'goods' | 'constants'>,
  s: Pick<Settlement, 'isDeepMarket' | 'market' | 'deepPriceFactors'>,
  good: GoodId,
  qty: number,
  funds: number,
  incomingT = 0,
): number {
  const c = world.constants.markets;
  const e = s.market[good];
  if (e.consumptionPerDay <= 0) return 0;
  const base = basePriceAt(world, s, good);
  let posted = e.price;
  if (incomingT > 0) {
    const now = curvePrice(s, e, base, 0, c);
    if (now > 0) posted *= curvePrice(s, e, base, incomingT, c) / now;
  }
  const p = Math.min(posted, slippedPrice(s, e, base, incomingT, qty, c)) * (1 - c.spread / 2);
  return funds >= p * qty ? p : 0;
}

/** Tonnes the settlement is still willing to buy. */
export const maxBuyQty = (e: MarketEntry, c = ECONOMY_CONSTANTS.markets): number =>
  Math.max(0, c.maxStockMultiple * e.targetStock - e.stock);

/**
 * Note a trade with a deep market: `soldT` tonnes sold to it (negative when bought from it).
 * Its price responds on the next market update. A no-op for colonies.
 */
export function recordDeepTrade(s: Settlement, good: GoodId, soldT: number): void {
  if (!s.isDeepMarket) return;
  const e = s.market[good];
  e.netSoldT = (e.netSoldT ?? 0) + soldT;
}

/** Deep market price: falls as traders sell to it, rises as they buy, within narrow clamps. */
export function deepPriceFor(
  base: number,
  netSoldT: number,
  c: EconomyConstants['markets'],
): number {
  const ratio = (c.deepMarketDepthT + netSoldT) / c.deepMarketDepthT;
  const raw = ratio > 0 ? ratio ** -c.elasticity : Number.POSITIVE_INFINITY;
  return base * Math.min(c.deepPriceClampMax, Math.max(c.deepPriceClampMin, raw));
}

export function addDemand(s: Settlement, good: keyof Settlement['market'], qty: number): void {
  s.flows.demand[good] = (s.flows.demand[good] ?? 0) + qty;
}

export function addSupply(s: Settlement, good: keyof Settlement['market'], qty: number): void {
  s.flows.supply[good] = (s.flows.supply[good] ?? 0) + qty;
}

/**
 * Fold this tick's flows into the rolling consumption/production rates, recompute target
 * stock, and move the posted price toward the curve. Deep markets keep effectively unlimited stock; their price moves only
 * with recent net trade (`deepPriceFor`).
 */
export function updateMarket(s: Settlement, world: LogisticsWorld, dtDays: number): void {
  const c = world.constants.markets;
  const k = Math.min(1, dtDays / world.constants.population.satisfactionEmaDays);
  for (const g of GOOD_IDS) {
    const e = s.market[g];
    const base = basePriceAt(world, s, g);
    if (s.isDeepMarket) {
      e.stock = c.deepMarketStock;
      e.targetStock = c.deepMarketStock;
      e.consumptionPerDay = 1;
      const sold = e.netSoldT ?? 0;
      if (sold !== 0) e.netSoldT = sold - sold * Math.min(1, dtDays / c.deepMarketRecoveryDays);
    } else {
      const demand = (s.flows.demand[g] ?? 0) / dtDays;
      const supply = (s.flows.supply[g] ?? 0) / dtDays;
      e.consumptionPerDay += (demand - e.consumptionPerDay) * k;
      e.productionPerDay += (supply - e.productionPerDay) * k;
      e.targetStock = targetFor(e.consumptionPerDay, e.productionPerDay, c);
    }
    // The posted price follows the curve with inertia (#15), so one ship's cargo no longer
    // swings the price contracts, investment and production see by 4× overnight. Trades are
    // priced along the curve itself (`quoteBuy`, `quoteSell`).
    const curve = curvePrice(s, e, base, 0, c);
    e.price += (curve - e.price) * Math.min(1, dtDays / c.priceInertiaDays);
    if (shouldAnnouncePrice(e, base, world.jd)) {
      world.events.append(world.jd, {
        type: 'PriceChanged',
        settlementId: s.id,
        good: g,
        from: e.lastAnnouncedPrice,
        to: e.price,
      });
      e.lastAnnouncedPrice = e.price;
      e.lastAnnouncedJd = world.jd;
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
  const c = world.constants.markets;
  for (const tier of Object.values(world.constants.population.needsPerCapitaPerDay)) {
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
    e.targetStock = targetFor(e.consumptionPerDay, e.productionPerDay, c);
    e.price =
      e.targetStock > 0 ? priceFor(base, e.stock, e.targetStock, c) : base * c.priceClampMin;
    e.lastAnnouncedPrice = e.price;
  }
}
