import { DEFAULT_CATALOG } from '../data/catalog.ts';
import { Ephemeris } from '../world/ephemeris.ts';
import { createWorld } from './createWorld.ts';
import { DEFAULT_SCENARIO } from './data/scenario.ts';
import { ledgerTotal, moneySupply } from './economy/money.ts';
import { outstanding } from './economy/treasury.ts';
import type { ScenarioConfig } from './economy/types.ts';

/**
 * Long-run invariant checks shared by the 20-year soak and its perturbed variants
 * (`soak.test.ts`, `robustness.*.test.ts`). Test support only: nothing in the app imports it.
 */
export interface SoakResult {
  /** Every broken invariant, first occurrence per kind; empty when the run is healthy. */
  violations: string[];
  maxStarvingDays: number;
  worstSettlement: string;
}

/** Days of survival shortage a colony may suffer at a stretch. */
export const MAX_STARVING_DAYS = 365;

export function runSoak(scenario: ScenarioConfig, years = 20): SoakResult {
  const w = createWorld(scenario, new Ephemeris(DEFAULT_CATALOG), { controllers: true });
  const t0 = scenario.startJd;
  const marsStart = w.settlements.get('mars-colony')!.population;
  const { markets, population } = w.constants;
  const violations = new Map<string, string>();
  const fail = (kind: string, detail: string) => {
    if (!violations.has(kind)) violations.set(kind, `day ${Math.round(w.jd - t0)}: ${detail}`);
  };
  const starvingSince = new Map<string, number>();
  let maxStarvingDays = 0;
  let worstSettlement = '';
  const supply0 = moneySupply(w);
  const colonyCash = () =>
    [...w.settlements.values()].reduce((a, s) => a + (s.isDeepMarket ? 0 : s.treasury), 0);
  const colonyCash0 = colonyCash();
  // Buy orders posted per year: the inter-colony market must not collapse (#11).
  const buyOrders = Array.from({ length: years }, () => 0);
  w.events.subscribe((e) => {
    if (e.type === 'ContractPosted' && e.kind !== 'export') {
      buyOrders[Math.min(years - 1, Math.floor((e.jd - t0) / 365))]!++;
    }
  });

  for (let day = 10; day <= years * 365; day += 10) {
    w.advanceTo(t0 + day);
    for (const s of w.settlements.values()) {
      if (s.isDeepMarket) continue;
      for (const [g, e] of Object.entries(s.market)) {
        if (!(Number.isFinite(e.stock) && e.stock >= -1e-6))
          fail('stock', `${s.id} ${g} stock ${e.stock}`);
        const base = w.goods.get(g as never)!.basePrice;
        if (
          e.price < base * markets.priceClampMin - 1e-6 ||
          e.price > base * markets.priceClampMax + 1e-6
        )
          fail('price', `${s.id} ${g} price ${e.price} outside clamps`);
      }
      if (!(Number.isFinite(s.population) && s.population >= 0))
        fail('population', `${s.id} population ${s.population}`);
      // Money promised to contracts is reserved, so paying them never overdraws.
      if (s.treasury < -1e-6) fail('treasury', `${s.id} treasury ${s.treasury}`);
      const owed = [...w.contracts.values()]
        .filter(
          (c) => c.settlementId === s.id && c.status !== 'completed' && c.status !== 'expired',
        )
        .reduce((a, c) => a + outstanding(c), 0);
      if (Math.abs(s.committed - owed) > 0.5)
        fail('committed', `${s.id} committed ${s.committed}, contracts owe ${owed}`);
      if (s.committed > s.treasury + 1e-6)
        fail('overcommitted', `${s.id} committed ${s.committed} > treasury ${s.treasury}`);
      if (s.satisfaction.survival < population.emigrationThreshold) {
        if (!starvingSince.has(s.id)) starvingSince.set(s.id, w.jd);
        const d = w.jd - starvingSince.get(s.id)!;
        if (d > maxStarvingDays) {
          maxStarvingDays = d;
          worstSettlement = s.id;
        }
      } else {
        starvingSince.delete(s.id);
      }
    }
    for (const co of w.companies.values())
      if (!Number.isFinite(co.cash)) fail('company cash', `${co.id} cash ${co.cash}`);
    // Money is conserved: every change in the supply is booked on a ledger line.
    const drift = moneySupply(w) - supply0 - ledgerTotal(w.ledger);
    if (Math.abs(drift) >= 1) fail('money', `money drift ${drift}`);
  }

  // Colony money and order volume stay roughly stationary instead of draining away.
  if (colonyCash() <= 0.4 * colonyCash0)
    fail('colony cash', `colony money ${colonyCash()} ≤ 40% of ${colonyCash0}`);
  const lastTwo = buyOrders[years - 2]! + buyOrders[years - 1]!;
  if (lastTwo < 20) fail('buy orders', `${lastTwo} buy orders in the last two years`);
  const active = [...w.companies.values()].filter((co) => co.status !== 'bankrupt').length;
  if (active < 3) fail('companies', `${active} active companies`);
  const mars = w.settlements.get('mars-colony')!.population;
  if (!(mars > marsStart)) fail('mars', `Mars population ${mars} ≤ start ${marsStart}`);
  if (maxStarvingDays > MAX_STARVING_DAYS)
    fail('shortage', `${worstSettlement} short of survival goods for ${maxStarvingDays} days`);
  const grew = w.events.recent(10_000).some((e) => e.type === 'ShipOrdered') || w.ships.size > 16;
  if (!grew) fail('fleet', 'no ship was ordered');

  return { violations: [...violations.values()], maxStarvingDays, worstSettlement };
}

/**
 * Perturbed copies of the default scenario. Small changes push the economy onto very different
 * paths (the scenario seed alone changes almost nothing), so these four — each of which once
 * starved a colony for years — guard against fixes that only work for the default run.
 */
export const SOAK_VARIANTS: Record<string, (s: ScenarioConfig) => void> = {
  /** Planets in different places at the start. */
  'start 400 days later': (s) => {
    s.startJd += 400;
  },
  /** Companies start with 50% more cash, so fleets grow faster. */
  'richer companies': (s) => {
    for (const c of s.companies) c.cash *= 1.5;
  },
  /** Every colony starts with a quarter less stock. */
  'thinner stocks': (s) => {
    for (const x of s.settlements) {
      for (const g of Object.keys(x.initialStock) as (keyof typeof x.initialStock)[]) {
        x.initialStock[g] = x.initialStock[g]! * 0.75;
      }
    }
  },
  /** Every colony starts with 40% less money. */
  'poorer colonies': (s) => {
    for (const x of s.settlements) x.treasury *= 0.6;
  },
};

export function variantScenario(name: string): ScenarioConfig {
  const s = structuredClone(DEFAULT_SCENARIO);
  SOAK_VARIANTS[name]!(s);
  return s;
}
