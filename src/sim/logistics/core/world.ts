import { createRng, type Rng } from '../../belts/random.ts';
import type { Ephemeris } from '../../world/ephemeris.ts';
import { EventLog } from './events.ts';
import { Scheduler } from './scheduler.ts';
import { JD_EPSILON, TICK_DAYS } from './time.ts';

/** Minimal scenario shape used by the core; extended by the economy layer. */
export interface ScenarioCore {
  seed: number;
  startJd: number;
}

export type Phase<W> = (world: W, dtDays: number) => void;
export type ScheduledAction<W> = (world: W) => void;

function hashName(name: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16_777_619);
  return h >>> 0;
}

/**
 * Deterministic world clock: a fixed tick loop plus an exact-time scheduler.
 * Feature modules register phases in a fixed order; state lives in stores.
 */
export class LogisticsWorld {
  readonly config: ScenarioCore;
  readonly ephemeris: Ephemeris;
  readonly events = new EventLog();
  #jd: number;
  #phases: { name: string; fn: Phase<LogisticsWorld> }[] = [];
  #scheduler = new Scheduler<ScheduledAction<LogisticsWorld>>();
  #rngs = new Map<string, Rng>();

  constructor(config: ScenarioCore, ephemeris: Ephemeris) {
    this.config = config;
    this.ephemeris = ephemeris;
    this.#jd = config.startJd;
  }

  get jd(): number {
    return this.#jd;
  }

  /** Named, independently seeded RNG stream (adding a stream never perturbs others). */
  rng(name: string): Rng {
    let r = this.#rngs.get(name);
    if (!r) {
      r = createRng((this.config.seed * 2_654_435_761) ^ hashName(name));
      this.#rngs.set(name, r);
    }
    return r;
  }

  addPhase(name: string, fn: Phase<LogisticsWorld>): void {
    this.#phases.push({ name, fn });
  }

  schedule(jd: number, action: ScheduledAction<LogisticsWorld>): void {
    this.#scheduler.schedule(jd, action);
  }

  /**
   * Advance by whole ticks up to `targetJd`, processing at most `maxTicks`.
   * Returns the number of ticks processed. Scheduled actions due before a tick's end run
   * (in time order) before that tick's phases.
   */
  advanceTo(targetJd: number, maxTicks = Number.POSITIVE_INFINITY): number {
    let ticks = 0;
    while (ticks < maxTicks && this.#jd + TICK_DAYS <= targetJd + JD_EPSILON) {
      const next = this.#jd + TICK_DAYS;
      for (let a = this.#scheduler.popDue(next); a; a = this.#scheduler.popDue(next)) a(this);
      this.#jd = next;
      for (const p of this.#phases) p.fn(this, TICK_DAYS);
      ticks++;
    }
    return ticks;
  }
}

export const minimalScenario = (seed: number, startJd = 2_466_154.5): ScenarioCore => ({
  seed,
  startJd,
});
