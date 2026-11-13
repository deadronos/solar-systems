import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../data/catalog.ts';
import { Simulation } from '../simulation.ts';
import { Ephemeris } from '../world/ephemeris.ts';
import { START_JD } from './core/time.ts';
import { createWorld } from './createWorld.ts';
import { DEFAULT_SCENARIO } from './data/scenario.ts';
import { outstanding } from './economy/treasury.ts';

const eph = () => new Ephemeris(DEFAULT_CATALOG);

describe('determinism', () => {
  it('two runs from the same seed produce identical event logs', { timeout: 60_000 }, () => {
    const a = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
    const b = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
    a.advanceTo(START_JD + 365);
    b.advanceTo(START_JD + 365);
    expect(a.events.count).toBeGreaterThan(500);
    expect(b.events.hash()).toBe(a.events.hash());
  });
});

describe('20-year soak', () => {
  it('stays stable, alive and growing', { timeout: 180_000 }, () => {
    const w = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
    const marsStart = w.settlements.get('mars-colony')!.population;
    const { markets, population } = w.constants;
    const starvingSince = new Map<string, number>();
    let maxStarvingDays = 0;
    let worst = '';
    for (let year = 0; year < 20; year++) {
      for (let day = 0; day < 365; day += 10) {
        w.advanceTo(START_JD + year * 365 + day + 10);
        for (const s of w.settlements.values()) {
          if (s.isDeepMarket) continue;
          for (const [g, e] of Object.entries(s.market)) {
            expect(
              Number.isFinite(e.stock) && e.stock >= -1e-6,
              `${s.id} ${g} stock ${e.stock}`,
            ).toBe(true);
            const base = w.goods.get(g as never)!.basePrice;
            expect(e.price).toBeGreaterThanOrEqual(base * markets.priceClampMin - 1e-6);
            expect(e.price).toBeLessThanOrEqual(base * markets.priceClampMax + 1e-6);
          }
          expect(Number.isFinite(s.population) && s.population >= 0).toBe(true);
          // Money promised to contracts is reserved, so paying them never overdraws.
          expect(s.treasury, `${s.id} treasury`).toBeGreaterThanOrEqual(-1e-6);
          const owed = [...w.contracts.values()]
            .filter(
              (c) => c.settlementId === s.id && c.status !== 'completed' && c.status !== 'expired',
            )
            .reduce((a, c) => a + outstanding(c), 0);
          expect(s.committed, `${s.id} committed`).toBeCloseTo(owed, 0);
          expect(s.committed).toBeLessThanOrEqual(s.treasury + 1e-6);
          if (s.satisfaction.survival < population.emigrationThreshold) {
            if (!starvingSince.has(s.id)) starvingSince.set(s.id, w.jd);
            const d = w.jd - starvingSince.get(s.id)!;
            if (d > maxStarvingDays) {
              maxStarvingDays = d;
              worst = s.id;
            }
          } else {
            starvingSince.delete(s.id);
          }
        }
        for (const co of w.companies.values()) expect(Number.isFinite(co.cash)).toBe(true);
      }
    }
    const active = [...w.companies.values()].filter((co) => co.status !== 'bankrupt');
    expect(active.length).toBeGreaterThanOrEqual(3);
    expect(w.settlements.get('mars-colony')!.population).toBeGreaterThan(marsStart);
    expect(maxStarvingDays, `longest survival shortage: ${worst}`).toBeLessThanOrEqual(365);
    expect(w.events.recent(10_000).some((e) => e.type === 'ShipOrdered') || w.ships.size > 16).toBe(
      true,
    );
  });
});

describe('performance', () => {
  it('runs at least 1,000 economy ticks per second headless', { timeout: 60_000 }, () => {
    const w = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
    const t0 = performance.now();
    const ticks = w.advanceTo(START_JD + 2 * 365);
    const perSecond = ticks / ((performance.now() - t0) / 1000);
    console.info(`logistics ticks/s: ${perSecond.toFixed(0)}`);
    expect(perSecond).toBeGreaterThan(1_000);
  });
});

describe('Simulation integration', () => {
  it('never runs backwards, caps speed and lets the clock wait for the economy', () => {
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO, rate: -86_400, maxTicksPerStep: 4 });
    sim.step(0.1);
    expect(sim.clock.rate).toBeGreaterThan(0);
    sim.clock.setRate(1e12);
    sim.step(0.1);
    expect(sim.clock.rate).toBe(31_557_600);
    // 4 ticks per step = 1 day; the clock can't run more than ~2 days ahead.
    for (let i = 0; i < 20; i++) sim.step(0.25);
    expect(sim.clock.jd - sim.logistics!.jd).toBeLessThanOrEqual(2.01);
    expect(sim.logistics!.jd).toBeGreaterThan(START_JD + 15);
  });
});
