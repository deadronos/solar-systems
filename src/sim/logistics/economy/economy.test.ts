import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { createWorld } from '../createWorld.ts';
import {
  askPrice,
  bidPrice,
  maxBuyQty,
  priceBand,
  priceFor,
  quoteBuy,
  quoteSell,
  shouldAnnouncePrice,
  updateMarket,
} from './markets.ts';
import { runProduction } from './production.ts';
import type { ScenarioConfig, SettlementDef } from './types.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const C = DEFAULT_SCENARIO.constants;

const colony = (over: Partial<SettlementDef> = {}): SettlementDef => ({
  id: 'test-colony',
  name: 'Test Colony',
  description: '',
  site: { bodyId: 'mars', kind: 'surface' },
  population: 10_000,
  housingCapacity: 11_000,
  facilities: [],
  initialStock: {},
  treasury: 100_000_000,
  isShipyard: false,
  isDeepMarket: false,
  ...over,
});

const scenario = (s: SettlementDef): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  settlements: [s],
  companies: [],
});

describe('scenario balance settings', () => {
  it('uses the configured stock buffer and initial reserve for a colony', () => {
    const base = scenario(colony());
    const world = createWorld(
      {
        ...base,
        constants: {
          ...base.constants,
          markets: { ...base.constants.markets, bufferDays: 20 },
          population: { ...base.constants.population, initialReserveDays: 50 },
        },
      },
      eph,
    );
    const food = world.settlements.get('test-colony')!.market.food;
    expect(food.targetStock).toBeCloseTo(300);
    expect(food.stock).toBeCloseTo(750);
  });
});

describe('prices', () => {
  it('equals base at ratio 1 and clamps at 0.25× / 4×', () => {
    expect(priceFor(100, 50, 50, C.markets)).toBeCloseTo(100);
    expect(priceFor(100, 0, 50, C.markets)).toBeCloseTo(400);
    expect(priceFor(100, 1e9, 50, C.markets)).toBeCloseTo(25);
    expect(priceFor(100, 10, 0, C.markets)).toBeCloseTo(100);
  });

  it('has a spread and a zero bid when the treasury cannot pay', () => {
    const e = {
      stock: 10,
      targetStock: 10,
      price: 100,
      consumptionPerDay: 1,
      productionPerDay: 0,
      lastAnnouncedPrice: 100,
    };
    expect(askPrice(e, C.markets)).toBeGreaterThan(bidPrice(e, C.markets, 1e9, 1));
    expect(bidPrice(e, C.markets, 0, 5)).toBe(0);
    expect(maxBuyQty(e, C.markets)).toBe(20);
  });

  describe('slippage and inertia (#15)', () => {
    /** A colony with food at target stock and its posted price at base. */
    const atTarget = () => {
      const w = createWorld(scenario(colony()), eph);
      const s = w.settlements.get('test-colony')!;
      const e = s.market.food;
      e.stock = e.targetStock;
      e.price = 1_500;
      return { w, s, e };
    };
    const half = C.markets.spread / 2;

    it('prices a large order along the curve, not at the first tonne', () => {
      const { w, s, e } = atTarget();
      expect(quoteSell(w, s, 'food', 1, Infinity)).toBeCloseTo(1_500 * (1 - half), -1);
      const big = quoteSell(w, s, 'food', e.targetStock, Infinity);
      // Doubling stock halves the price; the order averages ~ln 2 of the way down.
      expect(big).toBeLessThan(1_500 * 0.75);
      expect(big).toBeGreaterThan(1_500 * 0.6);
      expect(quoteBuy(w, s, 'food', e.targetStock / 2)).toBeGreaterThan(1_500 * 1.3);
    });

    it('trades at the worse of the posted price and the curve', () => {
      const { w, s } = atTarget();
      // Posted price lags high after a glut: sellers get the curve, buyers pay the posted.
      s.market.food.price = 3_000;
      expect(quoteSell(w, s, 'food', 1, Infinity)).toBeCloseTo(1_500 * (1 - half), -1);
      expect(quoteBuy(w, s, 'food', 1)).toBeCloseTo(3_000 * (1 + half), -1);
    });

    it('moves the posted price toward the curve over days, not in one tick', () => {
      const { w, s, e } = atTarget();
      e.stock = e.targetStock / 4; // curve: 4× base
      updateMarket(s, w, 0.25);
      expect(e.price).toBeGreaterThan(1_500);
      expect(e.price).toBeLessThan(1_500 * 1.2);
      // Hold stock at a quarter of target (with no flows, target shrinks as use decays).
      for (let i = 0; i < 400; i++) {
        e.stock = e.targetStock / 4;
        updateMarket(s, w, 0.25);
      }
      expect(e.price).toBeGreaterThan(1_500 * 3.5);
    });
  });
});

describe('production', () => {
  it('is limited by missing inputs', () => {
    const w = createWorld(
      scenario(
        colony({
          facilities: [{ recipeId: 'smelt_steel', maxRatePerDay: 100 }],
          initialStock: { ore: 15, fuel: 100 },
        }),
      ),
      eph,
    );
    w.advanceTo(START_JD + 1);
    const m = w.settlements.get('test-colony')!.market;
    expect(m.steel.stock).toBeCloseTo(10, 5);
    expect(m.ore.stock).toBeCloseTo(0, 5);
  });

  it('idles industry, and asks for no inputs, while output is worth less than inputs', () => {
    const w = createWorld(
      scenario(
        colony({
          facilities: [{ recipeId: 'water_fuel', maxRatePerDay: 100 }],
          initialStock: { water: 100_000 },
        }),
      ),
      eph,
    );
    const s = w.settlements.get('test-colony')!;
    s.flows.demand = {};
    s.market.water.productionPerDay = 1e4;
    s.market.water.price = 800;
    s.market.fuel.price = 400;
    const fuel0 = s.market.fuel.stock;
    runProduction(s, w, 1);
    expect(s.market.fuel.stock).toBe(fuel0);
    // Only the people's own water use is demanded, not the plant's 110 t.
    expect(s.flows.demand.water ?? 0).toBeLessThan(100);
    // Fuel worth more than the water it takes: the plant runs.
    s.market.fuel.price = 1_000;
    runProduction(s, w, 1);
    expect(s.market.fuel.stock).toBeCloseTo(fuel0 + 100, 5);
  });

  it('runs industry on the local surplus of survival goods, never on imports', () => {
    const w = createWorld(
      scenario(
        colony({
          population: 10_000,
          facilities: [{ recipeId: 'water_fuel', maxRatePerDay: 100 }],
          initialStock: { water: 100_000 },
        }),
      ),
      eph,
    );
    const s = w.settlements.get('test-colony')!;
    s.market.water.price = 100;
    s.market.fuel.price = 1_000;
    // The people need 40 t/day of water; 62 t/day are made here, so 22 t/day are spare.
    const need = 10_000 * (C.population.needsPerCapitaPerDay.survival.water ?? 0);
    s.market.water.productionPerDay = need + 22;
    const fuel0 = s.market.fuel.stock;
    runProduction(s, w, 1);
    expect(s.market.fuel.stock - fuel0).toBeCloseTo(20, 5);
    // Nothing spare: the plant idles, however much water is in stock.
    s.market.water.productionPerDay = need;
    const fuel1 = s.market.fuel.stock;
    runProduction(s, w, 1);
    expect(s.market.fuel.stock).toBe(fuel1);
  });
});

describe('population', () => {
  it('a starving colony shrinks but never goes negative or NaN', () => {
    const w = createWorld(scenario(colony({ treasury: 0 })), eph);
    // Record the shortage as it happens: unfilled orders soon push it out of the ring.
    let shortage = false;
    w.events.subscribe((e) => {
      if (e.type === 'Shortage') shortage = true;
    });
    w.advanceTo(START_JD + 3 * 365);
    const s = w.settlements.get('test-colony')!;
    expect(s.population).toBeLessThan(10_000);
    expect(s.population).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(s.treasury)).toBe(true);
    expect(s.satisfaction.survival).toBeLessThan(C.population.emigrationThreshold);
    expect(shortage).toBe(true);
  });

  it('a well-supplied colony grows but never exceeds housing', () => {
    const w = createWorld(
      scenario(
        colony({
          population: 10_000,
          housingCapacity: 10_300,
          initialStock: {
            water: 1e6,
            oxygen: 1e6,
            food: 1e6,
            medicine: 1e4,
            consumer_goods: 1e5,
            electronics: 1e4,
          },
        }),
      ),
      eph,
    );
    w.advanceTo(START_JD + 2 * 365);
    const s = w.settlements.get('test-colony')!;
    expect(s.population).toBeGreaterThan(10_000);
    expect(s.population).toBeLessThanOrEqual(s.housingCapacity + 1e-6);
  });

  it('expands housing when habitat modules, steel and machinery are in stock', () => {
    const w = createWorld(
      scenario(
        colony({
          population: 10_000,
          housingCapacity: 10_500,
          initialStock: {
            water: 1e6,
            oxygen: 1e6,
            food: 1e6,
            habitat_modules: 100,
            steel: 200,
            machinery: 20,
          },
        }),
      ),
      eph,
    );
    w.advanceTo(START_JD + 2);
    expect(w.settlements.get('test-colony')!.housingCapacity).toBeGreaterThan(10_500);
    expect(w.events.recent(100).some((e) => e.type === 'HousingExpanded')).toBe(true);
  });
});

describe('deep market', () => {
  it('keeps a constant price regardless of stock movements', () => {
    const w = createWorld(DEFAULT_SCENARIO, eph);
    const earth = w.settlements.get('earth-exchange')!;
    const before = earth.market.steel.price;
    earth.market.steel.stock -= 5_000_000;
    w.advanceTo(START_JD + 1);
    expect(earth.market.steel.price).toBe(before);
    expect(bidPrice(earth.market.steel, C.markets, earth.treasury, 1e6)).toBeGreaterThan(0);
  });
});

describe('default scenario', () => {
  it('stays finite over a year with no traders', () => {
    const w = createWorld({ ...DEFAULT_SCENARIO, companies: [] }, eph);
    w.advanceTo(START_JD + 365);
    for (const s of w.settlements.values()) {
      expect(Number.isFinite(s.population)).toBe(true);
      for (const e of Object.values(s.market)) {
        expect(e.stock).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(e.price)).toBe(true);
      }
    }
  });
});

describe('PriceChanged announcements', () => {
  const entry = (price: number, lastAnnouncedPrice: number, lastAnnouncedJd?: number) => ({
    stock: 10,
    targetStock: 10,
    price,
    consumptionPerDay: 1,
    productionPerDay: 0,
    lastAnnouncedPrice,
    ...(lastAnnouncedJd === undefined ? {} : { lastAnnouncedJd }),
  });

  it('classifies prices into bands around the base price', () => {
    expect(priceBand(50, 100)).toBe('cheap');
    expect(priceBand(100, 100)).toBe('normal');
    expect(priceBand(200, 100)).toBe('scarce');
  });

  it('announces band crossings only, with hysteresis at the edges', () => {
    // Moves inside the normal band are not announced, however large.
    expect(shouldAnnouncePrice(entry(140, 80), 100, 1_000)).toBe(false);
    // Just past the scarce edge is still inside the hysteresis margin.
    expect(shouldAnnouncePrice(entry(160, 100), 100, 1_000)).toBe(false);
    expect(shouldAnnouncePrice(entry(180, 100), 100, 1_000)).toBe(true);
    // Leaving "scarce" needs a clear drop back below the edge.
    expect(shouldAnnouncePrice(entry(140, 200), 100, 1_000)).toBe(false);
    expect(shouldAnnouncePrice(entry(120, 200), 100, 1_000)).toBe(true);
  });

  it('waits out the minimum interval since the last announcement', () => {
    expect(shouldAnnouncePrice(entry(300, 100, 990), 100, 1_000)).toBe(false);
    expect(shouldAnnouncePrice(entry(300, 100, 960), 100, 1_000)).toBe(true);
    expect(shouldAnnouncePrice(entry(300, 100), 100, 1_000)).toBe(true);
  });
});
