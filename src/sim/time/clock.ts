import { SECONDS_PER_DAY } from '../constants.ts';
import { dateToJd } from './julian.ts';

export interface ClockState {
  readonly jd: number;
  /** Simulated seconds per real second. Negative runs time backwards. */
  readonly rate: number;
  readonly paused: boolean;
}

type Listener = () => void;

/** Largest real-time step accepted per tick, so a backgrounded tab doesn't jump years. */
const MAX_REAL_DT_SECONDS = 0.25;

/**
 * Simulation clock. Advances a Julian date by `rate` simulated seconds per real second.
 * Discrete changes (rate, pause, jumps) notify subscribers; continuous time advance does not,
 * so UIs should poll `jd` at whatever cadence they need.
 */
export class SimClock {
  #jd: number;
  #rate: number;
  #paused = false;
  #listeners = new Set<Listener>();
  #snapshot: ClockState;

  constructor(startJd = dateToJd(new Date()), rate = 86_400) {
    this.#jd = startJd;
    this.#rate = rate;
    this.#snapshot = this.#makeSnapshot();
  }

  get jd(): number {
    return this.#jd;
  }

  get rate(): number {
    return this.#rate;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Advance by a real-time delta (seconds). Returns the new Julian date. */
  tick(realDtSeconds: number): number {
    if (!this.#paused) {
      const dt = Math.min(Math.max(realDtSeconds, 0), MAX_REAL_DT_SECONDS);
      this.#jd += (dt * this.#rate) / SECONDS_PER_DAY;
    }
    return this.#jd;
  }

  setRate(rate: number): void {
    this.#rate = rate;
    this.#emit();
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#emit();
  }

  togglePaused(): void {
    this.setPaused(!this.#paused);
  }

  setJd(jd: number): void {
    this.#jd = jd;
    this.#emit();
  }

  /** Move the clock without notifying listeners (used when the economy lags behind). */
  syncTo(jd: number): void {
    this.#jd = jd;
  }

  resetToNow(): void {
    this.setJd(dateToJd(new Date()));
  }

  /** Stable snapshot of discrete state (for useSyncExternalStore). */
  getState = (): ClockState => this.#snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #makeSnapshot(): ClockState {
    return { jd: this.#jd, rate: this.#rate, paused: this.#paused };
  }

  #emit(): void {
    this.#snapshot = this.#makeSnapshot();
    for (const l of this.#listeners) l();
  }
}
