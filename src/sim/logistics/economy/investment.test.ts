import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import type { LogisticsEvent } from '../core/events.ts';
import { START_JD } from '../core/time.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { SETTLEMENTS } from '../data/settlements.ts';
import { outputValue } from './investment.ts';
import { runProduction } from './production.ts';
import type { ScenarioConfig, SettlementDef } from './types.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const C = DEFAULT_SCENARIO.constants;
const earth = SETTLEMENTS.find((s) => s.isDeepMarket)!;

/** A mining colony with plenty of idle workers, money and build materials in stock. */
const colony = (over: Partial<SettlementDef> = {}): SettlementDef => ({
  id: 'col',
  name: 'Colony',
  description: '',
  site: { bodyId: 'mars', kind: 'surface' },
  population: 10_000,
  housingCapacity: 20_000,
  facilities: [{ recipeId: 'mine_ore', maxRatePerDay: 100 }],
  initialStock: { water: 1e6, oxygen: 1e6, food: 1e6, machinery: 10_000, steel: 100_000 },
  treasury: 500_000_000,
  isShipyard: false,
  isDeepMarket: false,
  deposits: ['mine_ore'],
  ...over,
});

const scenario = (s: SettlementDef): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  settlements: [earth, s],
  companies: [],
});

function record(w: ReturnType<typeof createWorld>): LogisticsEvent[] {
  const log: LogisticsEvent[] = [];
  w.events.subscribe((e) => log.push(e));
  return log;
}

describe('investment', () => {
  it('picks a project at review time and builds it when the kit is in stock', () => {
    const w = createWorld(scenario(colony()), eph);
    const log = record(w);
    const s = w.settlements.get('col')!;
    const facilities0 = s.facilities.length;
    const capacity0 = s.facilities[0]!.maxRatePerDay;
    w.advanceTo(START_JD + C.industry.reviewDays + 1);
    const decision = log.find((e) => e.type === 'InvestmentDecision');
    const built = log.find((e) => e.type === 'FacilityBuilt');
    expect(decision).toBeDefined();
    expect(built).toBeDefined();
    if (decision?.type !== 'InvestmentDecision' || built?.type !== 'FacilityBuilt') return;
    expect(built.recipeId).toBe(decision.recipeId);
    expect(decision.reason.length).toBeGreaterThan(0);
    // Either a new facility or more capacity for the existing one.
    const grew =
      s.facilities.length > facilities0 || s.facilities[0]!.maxRatePerDay > capacity0 + 1e-9;
    expect(grew).toBe(true);
    expect(s.project).toBeNull();
  });

  it('waits for an imported kit, and drops the project after the timeout', () => {
    const w = createWorld(
      scenario(colony({ initialStock: { water: 1e6, oxygen: 1e6, food: 1e6 } })),
      eph,
    );
    const log = record(w);
    w.advanceTo(START_JD + C.industry.reviewDays + 1);
    const s = w.settlements.get('col')!;
    expect(s.project).not.toBeNull();
    // Kit demand drives imports like any other consumption.
    expect(s.market.machinery.consumptionPerDay).toBeGreaterThan(0);
    s.market.machinery.stock = 0;
    s.market.steel.stock = 0;
    const started = s.project!.startedJd;
    // Nobody delivers (no companies, no neighbour), so the project eventually lapses.
    w.advanceTo(started + C.industry.projectTimeoutDays + 1);
    expect(log.some((e) => e.type === 'InvestmentAbandoned')).toBe(true);
  });

  it('builds extraction only on deposits the site has', () => {
    const w = createWorld(scenario(colony({ deposits: [] })), eph);
    const log = record(w);
    w.advanceTo(START_JD + 365);
    const extraction = new Set(
      [...w.recipes.values()].filter((r) => r.inputs.length === 0).map((r) => r.id),
    );
    const built = log.filter((e) => e.type === 'FacilityBuilt' && e.isNew);
    expect(built.length).toBeGreaterThan(0);
    for (const e of built) {
      if (e.type === 'FacilityBuilt') expect(extraction.has(e.recipeId)).toBe(false);
    }
  });
});

describe('maintenance and the life-support reserve', () => {
  it('facilities wear without maintenance machinery and hold with it', () => {
    const w = createWorld(scenario(colony()), eph);
    const s = w.settlements.get('col')!;
    const f = s.facilities[0]!;
    const rate0 = f.maxRatePerDay;
    for (let i = 0; i < 1461; i++) runProduction(s, w, 0.25);
    expect(f.maxRatePerDay).toBe(rate0);
    s.market.machinery.stock = 0;
    for (let i = 0; i < 1461; i++) {
      s.market.machinery.stock = 0;
      runProduction(s, w, 0.25);
    }
    // Wear compounds tick by tick: about e^−wearPerYear after a year.
    expect(f.maxRatePerDay).toBeCloseTo(rate0 * Math.exp(-C.industry.wearPerYear), 1);
  });

  it('industry never draws on the stock life support needs', () => {
    const w = createWorld(
      scenario(
        colony({
          facilities: [{ recipeId: 'water_fuel', maxRatePerDay: 1_000 }],
          initialStock: { oxygen: 1e6, food: 1e6, machinery: 1e4 },
        }),
      ),
      eph,
    );
    const s = w.settlements.get('col')!;
    const reserve =
      s.population *
      (C.population.needsPerCapitaPerDay.survival.water ?? 0) *
      C.industry.survivalInputReserveDays;
    s.market.water.stock = reserve + 10;
    // Made locally, so industry may use it (see the surplus test in economy.test.ts).
    s.market.water.productionPerDay = 1e4;
    const fuel0 = s.market.fuel.stock;
    runProduction(s, w, 0.25);
    expect(s.market.water.stock).toBeCloseTo(reserve, 6);
    expect(s.market.fuel.stock - fuel0).toBeCloseTo(10 / 1.1, 6);
    runProduction(s, w, 0.25);
    expect(s.market.water.stock).toBeCloseTo(reserve, 6);
  });

  describe('output value', () => {
    /** Colony short of fuel: it uses 2 t/day, makes none, and its local price is high. */
    const shortOfFuel = () => {
      const w = createWorld(scenario(colony({ facilities: [] })), eph);
      const s = w.settlements.get('col')!;
      const e = s.market.fuel;
      e.consumptionPerDay = 2;
      e.productionPerDay = 0;
      e.price = 5_000;
      const netback =
        w.settlements.get('earth-exchange')!.market.fuel.price * C.industry.exportNetback;
      return { w, s, netback };
    };

    it('only the share local use absorbs earns the local price; the rest is exported', () => {
      const { w, s, netback } = shortOfFuel();
      expect(outputValue(w, s, 'fuel', 1)).toBeCloseTo(5_000, 6);
      // A 200 t/day plant at a 2 t/day station mostly exports.
      expect(outputValue(w, s, 'fuel', 200)).toBeCloseTo((2 * 5_000 + 198 * netback) / 200, 6);
    });

    it('counts idle capacity as supply, so a second plant is not valued as the first', () => {
      const { w, s, netback } = shortOfFuel();
      s.facilities.push({ recipeId: 'water_fuel', maxRatePerDay: 10 });
      expect(outputValue(w, s, 'fuel', 50)).toBeCloseTo(netback, 6);
    });
  });
});
