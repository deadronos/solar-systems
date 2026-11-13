import { createBelt, DEFAULT_BELTS, type Belt, type BeltDefinition } from './belts/belts.ts';
import { DEFAULT_CATALOG } from './data/catalog.ts';
import type { LogisticsWorld } from './logistics/core/world.ts';
import { MAX_RATE_SECONDS_PER_SECOND } from './logistics/core/time.ts';
import type { ScenarioConfig } from './logistics/economy/types.ts';
import {
  InlineEconomy,
  WorkerEconomy,
  type EconomyBackend,
  type EconomyPort,
  type InlineOptions,
} from './logistics/sync/economy.ts';
import { canUseWorkers, spawnEconomyWorker } from './logistics/sync/spawn.ts';
import type { BodyDefinition } from './data/types.ts';
import { SimClock } from './time/clock.ts';
import { Ephemeris } from './world/ephemeris.ts';

export interface SimulationOptions extends InlineOptions {
  catalog?: readonly BodyDefinition[];
  belts?: readonly BeltDefinition[];
  startJd?: number;
  /** Initial simulated seconds per real second. */
  rate?: number;
  /** Run the logistics economy on top of the orrery. */
  scenario?: ScenarioConfig;
  /**
   * Where the economy runs. 'inline' (default) advances it on this thread within a per-frame
   * budget. 'worker' runs it in a Web Worker, falling back to inline when workers are
   * unavailable or fail to start.
   */
  economy?: 'inline' | 'worker';
  /** Starts the economy worker (defaults to the bundled module worker). */
  spawnWorker?: () => EconomyPort;
}

/** Inline: if the economy falls this far behind the clock, the clock waits for it. */
const MAX_LAG_DAYS = 2;
/** Worker: results arrive a few frames late, so allow this much real time of lag too. */
const WORKER_LAG_SECONDS = 0.25;
/** Lag (real seconds at the current rate) above which the economy is reported as behind. */
const WORKER_BEHIND_SECONDS = 0.15;

/**
 * The whole simulation: a clock, an ephemeris for named bodies, belt particle sets and
 * (optionally) the logistics economy. Independent of rendering — it runs in tests and Node.
 */
export class Simulation {
  readonly clock: SimClock;
  readonly ephemeris: Ephemeris;
  readonly belts: readonly Belt[];
  /** Days the economy trails the requested clock time (0 when keeping up). */
  lagDays = 0;
  /** Smoothed achieved sim seconds per real second. */
  achievedRate = 0;
  /** Why the economy stopped, if it did. */
  economyError: string | null = null;
  readonly #catalog: readonly BodyDefinition[];
  readonly #scenario: ScenarioConfig | null;
  readonly #inline: InlineOptions;
  #economy: EconomyBackend | null;

  constructor(options: SimulationOptions = {}) {
    const startJd = options.scenario?.startJd ?? options.startJd;
    this.clock = new SimClock(startJd, options.rate);
    this.#catalog = options.catalog ?? DEFAULT_CATALOG;
    this.ephemeris = new Ephemeris(this.#catalog);
    this.belts = (options.belts ?? DEFAULT_BELTS).map(createBelt);
    this.#scenario = options.scenario ?? null;
    this.#inline = options;
    this.#economy = null;
    if (this.#scenario) {
      const spawn = options.spawnWorker ?? (canUseWorkers() ? spawnEconomyWorker : null);
      this.#economy =
        options.economy === 'worker' && spawn
          ? new WorkerEconomy(spawn, this.#scenario, this.#catalog, this.ephemeris)
          : this.#inlineEconomy();
    }
    this.ephemeris.update(this.clock.jd);
  }

  #inlineEconomy(): EconomyBackend {
    return new InlineEconomy(this.#scenario!, this.ephemeris, this.#inline);
  }

  /** The economy to read (null without a scenario). Read-only from outside the sim. */
  get logistics(): LogisticsWorld | null {
    return this.#economy?.world ?? null;
  }

  /** Where the economy is running. */
  get economyMode(): 'inline' | 'worker' | null {
    return this.#economy?.kind ?? null;
  }

  /** The economy is noticeably behind the clock (more than transport latency). */
  get economyBehind(): boolean {
    if (!this.#economy) return false;
    const latency =
      this.#economy.kind === 'worker'
        ? (Math.abs(this.clock.rate) * WORKER_BEHIND_SECONDS) / 86_400
        : 0;
    return this.lagDays > Math.max(0.5, latency);
  }

  /** Advance the clock by a real-time delta and recompute body positions (and the economy). */
  step(realDtSeconds: number): void {
    const before = this.clock.jd;
    let eco = this.#economy;
    if (eco?.failure && !eco.started) {
      // The worker never came up: run the economy here instead (nothing was lost yet).
      console.warn(`Economy worker unavailable (${eco.failure}); running it on the main thread.`);
      eco.dispose();
      eco = this.#economy = this.#inlineEconomy();
    }
    if (eco) {
      // The economy only runs forward and has a top speed.
      if (this.clock.rate < 0) this.clock.setRate(-this.clock.rate);
      if (this.clock.rate > MAX_RATE_SECONDS_PER_SECOND)
        this.clock.setRate(MAX_RATE_SECONDS_PER_SECOND);
      if (this.clock.jd < eco.jd) this.clock.syncTo(eco.jd);
    }
    this.clock.tick(realDtSeconds);
    if (eco) {
      eco.advance(this.clock.jd);
      this.economyError = eco.failure;
      const maxLag =
        eco.kind === 'worker'
          ? Math.max(MAX_LAG_DAYS, (Math.abs(this.clock.rate) * WORKER_LAG_SECONDS) / 86_400)
          : MAX_LAG_DAYS;
      this.lagDays = Math.max(0, this.clock.jd - eco.jd);
      if (this.lagDays > maxLag) {
        // Hold the clock at the lag limit until the economy catches up.
        this.clock.syncTo(eco.jd + maxLag);
        this.lagDays = maxLag;
      }
    }
    if (realDtSeconds > 0) {
      const rate = ((this.clock.jd - before) * 86_400) / Math.min(realDtSeconds, 0.25);
      this.achievedRate += (rate - this.achievedRate) * 0.1;
    }
    this.ephemeris.update(this.clock.jd);
  }

  /** Stop the economy worker, if any. */
  dispose(): void {
    this.#economy?.dispose();
  }
}
