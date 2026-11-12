import { createBelt, DEFAULT_BELTS, type Belt, type BeltDefinition } from './belts/belts.ts';
import { DEFAULT_CATALOG } from './data/catalog.ts';
import type { BodyDefinition } from './data/types.ts';
import { SimClock } from './time/clock.ts';
import { Ephemeris } from './world/ephemeris.ts';

export interface SimulationOptions {
  catalog?: readonly BodyDefinition[];
  belts?: readonly BeltDefinition[];
  startJd?: number;
  /** Initial simulated seconds per real second. */
  rate?: number;
}

/**
 * The whole simulation: a clock, an ephemeris for named bodies and belt particle sets.
 * Completely independent of rendering — it can run in a worker, a test or a Node script.
 */
export class Simulation {
  readonly clock: SimClock;
  readonly ephemeris: Ephemeris;
  readonly belts: readonly Belt[];

  constructor(options: SimulationOptions = {}) {
    this.clock = new SimClock(options.startJd, options.rate);
    this.ephemeris = new Ephemeris(options.catalog ?? DEFAULT_CATALOG);
    this.belts = (options.belts ?? DEFAULT_BELTS).map(createBelt);
    this.ephemeris.update(this.clock.jd);
  }

  /** Advance the clock by a real-time delta and recompute body positions. */
  step(realDtSeconds: number): void {
    this.ephemeris.update(this.clock.tick(realDtSeconds));
  }
}
