import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../data/catalog.ts';
import { Ephemeris } from '../world/ephemeris.ts';
import { START_JD } from './core/time.ts';
import { createWorld } from './createWorld.ts';
import { DEFAULT_SCENARIO } from './data/scenario.ts';

// Runs on its own (`pnpm test:perf`, after `pnpm test` in `pnpm check`): with the 20-year soaks
// in parallel, CI's shared runner swung 2× between runs and the guard failed at random.
// `src/sim` has no Node types; the tests run on Node.
const node = globalThis as unknown as {
  process: { threadCpuUsage(): { user: number; system: number } };
};
const cpuSeconds = () => {
  const u = node.process.threadCpuUsage();
  return (u.user + u.system) / 1e6;
};

describe('performance', () => {
  it('runs at least 1,000 economy ticks per second headless', { timeout: 120_000 }, () => {
    // Best of three one-year runs, in CPU time of this thread.
    let best = 0;
    for (let i = 0; i < 3; i++) {
      const w = createWorld(DEFAULT_SCENARIO, new Ephemeris(DEFAULT_CATALOG), {
        controllers: true,
      });
      const t0 = cpuSeconds();
      const ticks = w.advanceTo(START_JD + 365);
      best = Math.max(best, ticks / (cpuSeconds() - t0));
    }
    console.info(`logistics ticks/s (CPU, best of 3): ${best.toFixed(0)}`);
    expect(best).toBeGreaterThan(1_000);
  });
});
