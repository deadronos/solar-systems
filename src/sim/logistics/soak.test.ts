import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../data/catalog.ts';
import { Simulation } from '../simulation.ts';
import { Ephemeris } from '../world/ephemeris.ts';
import { START_JD } from './core/time.ts';
import { createWorld } from './createWorld.ts';
import { DEFAULT_SCENARIO } from './data/scenario.ts';
import { MAX_STARVING_DAYS, runSoak } from './soakHarness.ts';

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
    const r = runSoak(DEFAULT_SCENARIO);
    expect(r.violations).toEqual([]);
    expect(
      r.maxStarvingDays,
      `longest survival shortage: ${r.worstSettlement}`,
    ).toBeLessThanOrEqual(MAX_STARVING_DAYS);
  });
});

describe('performance', () => {
  it('runs at least 1,000 economy ticks per second headless', { timeout: 60_000 }, () => {
    const w = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
    // CPU time of this thread, not wall-clock: on CI the other 20-year soaks run in parallel
    // and compete for the runner, which made a wall-clock guard fail at random.
    // (`src/sim` has no Node types; the tests run on Node.)
    const node = globalThis as unknown as {
      process: { threadCpuUsage(): { user: number; system: number } };
    };
    const cpu = () => {
      const u = node.process.threadCpuUsage();
      return (u.user + u.system) / 1e6;
    };
    const t0 = cpu();
    const ticks = w.advanceTo(START_JD + 2 * 365);
    const perSecond = ticks / (cpu() - t0);
    console.info(`logistics ticks/s (CPU): ${perSecond.toFixed(0)}`);
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
