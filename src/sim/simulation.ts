import { createBelt, DEFAULT_BELTS, type Belt, type BeltDefinition } from './belts/belts.ts';
import { DEFAULT_CATALOG } from './data/catalog.ts';
import type { LogisticsWorld } from './logistics/core/world.ts';
import { MAX_RATE_SECONDS_PER_SECOND, TICK_DAYS } from './logistics/core/time.ts';
import { createWorld } from './logistics/createWorld.ts';
import type { ScenarioConfig } from './logistics/economy/types.ts';
import type { BodyDefinition } from './data/types.ts';
import { SimClock } from './time/clock.ts';
import { Ephemeris } from './world/ephemeris.ts';

export interface SimulationOptions {
  catalog?: readonly BodyDefinition[];
  belts?: readonly BeltDefinition[];
  startJd?: number;
  /** Initial simulated seconds per real second. */
  rate?: number;
  /** Run the logistics economy on top of the orrery. */
  scenario?: ScenarioConfig;
  /** Economy ticks processed per frame at most (keeps frames responsive). */
  maxTicksPerStep?: number;
  /** Wall-clock budget (ms) for economy work per frame; the economy lags rather than stutters. */
  maxStepMs?: number;
  /** Time source for the budget (ms). Defaults to performance.now. */
  now?: () => number;
}

/** Ticks processed between wall-clock budget checks. */
const BUDGET_CHUNK_TICKS = 4;

/** If the economy falls this far behind the clock, the clock waits for it. */
const MAX_LAG_DAYS = 2;

/**
 * The whole simulation: a clock, an ephemeris for named bodies and belt particle sets.
 * Completely independent of rendering — it can run in a worker, a test or a Node script.
 */
export class Simulation {
  readonly clock: SimClock;
  readonly ephemeris: Ephemeris;
  readonly belts: readonly Belt[];
  readonly logistics: LogisticsWorld | null;
  /** Days the economy trails the requested clock time (0 when keeping up). */
  lagDays = 0;
  /** Smoothed achieved sim seconds per real second. */
  achievedRate = 0;
  readonly #maxTicksPerStep: number;
  readonly #maxStepMs: number;
  readonly #now: () => number;

  constructor(options: SimulationOptions = {}) {
    const startJd = options.scenario?.startJd ?? options.startJd;
    this.clock = new SimClock(startJd, options.rate);
    this.ephemeris = new Ephemeris(options.catalog ?? DEFAULT_CATALOG);
    this.belts = (options.belts ?? DEFAULT_BELTS).map(createBelt);
    this.logistics = options.scenario
      ? createWorld(options.scenario, this.ephemeris, { controllers: true })
      : null;
    this.#maxTicksPerStep = options.maxTicksPerStep ?? 400;
    this.#maxStepMs = options.maxStepMs ?? 8;
    this.#now = options.now ?? (() => performance.now());
    this.ephemeris.update(this.clock.jd);
  }

  /** Advance the clock by a real-time delta and recompute body positions (and the economy). */
  step(realDtSeconds: number): void {
    const before = this.clock.jd;
    const world = this.logistics;
    if (world) {
      // The economy only runs forward and has a top speed.
      if (this.clock.rate < 0) this.clock.setRate(-this.clock.rate);
      if (this.clock.rate > MAX_RATE_SECONDS_PER_SECOND)
        this.clock.setRate(MAX_RATE_SECONDS_PER_SECOND);
      if (this.clock.jd < world.jd) this.clock.syncTo(world.jd);
    }
    this.clock.tick(realDtSeconds);
    if (world) {
      // Process ticks in small chunks until caught up, out of ticks or out of time.
      const t0 = this.#now();
      let ticks = 0;
      while (ticks < this.#maxTicksPerStep) {
        const n = world.advanceTo(
          this.clock.jd,
          Math.min(BUDGET_CHUNK_TICKS, this.#maxTicksPerStep - ticks),
        );
        ticks += n;
        if (n === 0 || this.#now() - t0 >= this.#maxStepMs) break;
      }
      this.lagDays = Math.max(0, this.clock.jd - world.jd);
      if (this.lagDays > MAX_LAG_DAYS) {
        this.clock.syncTo(world.jd + TICK_DAYS);
        this.lagDays = TICK_DAYS;
      }
    }
    if (realDtSeconds > 0) {
      const rate = ((this.clock.jd - before) * 86_400) / Math.min(realDtSeconds, 0.25);
      this.achievedRate += (rate - this.achievedRate) * 0.1;
    }
    this.ephemeris.update(this.clock.jd);
  }
}
