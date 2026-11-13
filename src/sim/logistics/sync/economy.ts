import type { BodyDefinition } from '../../data/types.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { TICK_DAYS } from '../core/time.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { createWorld } from '../createWorld.ts';
import type { ScenarioConfig } from '../economy/types.ts';
import { applyDelta, createDeltaWriter, type WorldDelta } from './delta.ts';

/**
 * Where the logistics economy runs. The orrery and UI only ever read `world`:
 *  - `InlineEconomy` advances the real world on the calling (main) thread, within a
 *    per-frame time budget;
 *  - `WorkerEconomy` runs it in a Web Worker and mirrors it into a read-only replica.
 * Both produce identical economies: ticks are fixed and the economy reads planet positions
 * only at explicit dates, never the render clock.
 */
export interface EconomyBackend {
  readonly kind: 'inline' | 'worker';
  /** The world to read: authoritative (inline) or a replica (worker). Never mutate it. */
  readonly world: LogisticsWorld;
  /** Economy time as seen here (the replica lags the worker by a message or two). */
  readonly jd: number;
  /** Data from the economy has arrived (always true inline). */
  readonly started: boolean;
  /** Set when the economy can no longer advance. */
  readonly failure: string | null;
  /** Ask the economy to reach `targetJd` (never goes backwards). Called once per frame. */
  advance(targetJd: number): void;
  dispose(): void;
}

/** Ticks processed between wall-clock budget checks (1: a heavy tick never doubles the overrun). */
const BUDGET_CHUNK_TICKS = 1;

/** Advance whole ticks toward `targetJd` until caught up, out of ticks or out of time. */
export function runTicks(
  world: LogisticsWorld,
  targetJd: number,
  maxTicks: number,
  budgetMs: number,
  now: () => number,
): number {
  const t0 = now();
  let ticks = 0;
  while (ticks < maxTicks) {
    const n = world.advanceTo(targetJd, Math.min(BUDGET_CHUNK_TICKS, maxTicks - ticks));
    ticks += n;
    if (n === 0 || now() - t0 >= budgetMs) break;
  }
  return ticks;
}

export interface InlineOptions {
  /** Economy ticks processed per frame at most (keeps frames responsive). */
  maxTicksPerStep?: number;
  /** Wall-clock budget (ms) for economy work per frame; the economy lags rather than stutters. */
  maxStepMs?: number;
  /** Time source for the budget (ms). Defaults to performance.now. */
  now?: () => number;
}

/** The economy on the calling thread (tests, Node, and the fallback when workers fail). */
export class InlineEconomy implements EconomyBackend {
  readonly kind = 'inline';
  readonly world: LogisticsWorld;
  readonly started = true;
  readonly failure = null;
  readonly #maxTicks: number;
  readonly #budgetMs: number;
  readonly #now: () => number;

  constructor(scenario: ScenarioConfig, ephemeris: Ephemeris, options: InlineOptions = {}) {
    this.world = createWorld(scenario, ephemeris, { controllers: true });
    this.#maxTicks = options.maxTicksPerStep ?? 400;
    this.#budgetMs = options.maxStepMs ?? 8;
    this.#now = options.now ?? (() => performance.now());
  }

  get jd(): number {
    return this.world.jd;
  }

  advance(targetJd: number): void {
    runTicks(this.world, targetJd, this.#maxTicks, this.#budgetMs, this.#now);
  }

  dispose(): void {}
}

// ── Worker protocol ──────────────────────────────────────────────────────────

export type ToEconomy =
  | { type: 'init'; scenario: ScenarioConfig; catalog: readonly BodyDefinition[] }
  | { type: 'target'; jd: number };

export type FromEconomy = { type: 'delta'; delta: WorldDelta } | { type: 'error'; message: string };

/** The part of `Worker` the client uses (a fake in tests). */
export interface EconomyPort {
  postMessage(msg: ToEconomy): void;
  addEventListener(type: 'message', fn: (e: { data: FromEconomy }) => void): void;
  addEventListener(type: 'error', fn: (e: { message?: string }) => void): void;
  terminate(): void;
}

/** Worker-side time slice before yielding to read new targets (ms). */
const SLICE_MS = 12;
/** Minimum interval between deltas while catching up (ms); caught-up results post at once. */
const POST_INTERVAL_MS = 50;

/**
 * The worker side, independent of the Worker API: feed it messages with the returned handler.
 * `schedule` must run its callback after pending messages (a MessageChannel in the worker).
 */
export function createEconomyServer(
  post: (msg: FromEconomy) => void,
  schedule: (fn: () => void) => void,
  now: () => number = () => performance.now(),
): (msg: ToEconomy) => void {
  let world: LogisticsWorld | null = null;
  let writeDelta: (() => WorldDelta) | null = null;
  let target = Number.NEGATIVE_INFINITY;
  let scheduled = false;
  let lastPost = Number.NEGATIVE_INFINITY;
  let unsent = false;

  const behind = () => !!world && world.jd + TICK_DAYS <= target + 1e-9;
  const flush = () => {
    post({ type: 'delta', delta: writeDelta!() });
    lastPost = now();
    unsent = false;
  };
  const loop = () => {
    scheduled = false;
    if (!world) return;
    try {
      if (runTicks(world, target, Number.POSITIVE_INFINITY, SLICE_MS, now) > 0) unsent = true;
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      world = null;
      return;
    }
    const more = behind();
    if (unsent && (!more || now() - lastPost >= POST_INTERVAL_MS)) flush();
    if (more) kick();
  };
  const kick = () => {
    if (scheduled) return;
    scheduled = true;
    schedule(loop);
  };

  return (msg) => {
    if (msg.type === 'init') {
      try {
        world = createWorld(msg.scenario, new Ephemeris(msg.catalog), { controllers: true });
        writeDelta = createDeltaWriter(world);
        target = world.jd;
        flush();
      } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.type === 'target') {
      if (msg.jd > target) target = msg.jd;
      if (behind()) kick();
    }
  };
}

/**
 * The economy in a Web Worker, mirrored into a replica world. The worker is spawned on the
 * first `advance`, so simulations that are created but never run (React StrictMode) cost
 * nothing.
 */
export class WorkerEconomy implements EconomyBackend {
  readonly kind = 'worker';
  readonly world: LogisticsWorld;
  started = false;
  failure: string | null = null;
  readonly #spawn: () => EconomyPort;
  readonly #init: ToEconomy;
  #port: EconomyPort | null = null;
  #pending: WorldDelta[] = [];
  #sentTarget = Number.NEGATIVE_INFINITY;

  constructor(
    spawn: () => EconomyPort,
    scenario: ScenarioConfig,
    catalog: readonly BodyDefinition[],
    ephemeris: Ephemeris,
  ) {
    this.#spawn = spawn;
    this.#init = { type: 'init', scenario, catalog };
    // Identical to the worker's starting state, so the UI has something to show at once.
    this.world = createWorld(scenario, ephemeris, { controllers: false });
  }

  get jd(): number {
    return this.world.jd;
  }

  advance(targetJd: number): void {
    if (this.failure) return;
    if (!this.#port) this.#start();
    for (const d of this.#pending) applyDelta(this.world, d);
    this.#pending.length = 0;
    if (targetJd > this.#sentTarget && this.#port) {
      this.#sentTarget = targetJd;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker, not a window
      this.#port.postMessage({ type: 'target', jd: targetJd });
    }
  }

  #start(): void {
    try {
      const port = this.#spawn();
      port.addEventListener('message', ({ data }) => {
        if (data.type === 'delta') {
          this.#pending.push(data.delta);
          this.started = true;
        } else this.#fail(data.message);
      });
      port.addEventListener('error', (e) => this.#fail(e.message || 'economy worker crashed'));
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker, not a window
      port.postMessage(this.#init);
      this.#port = port;
    } catch (err) {
      this.#fail(err instanceof Error ? err.message : String(err));
    }
  }

  #fail(message: string): void {
    this.failure = message;
    this.dispose();
  }

  dispose(): void {
    this.#port?.terminate();
    this.#port = null;
  }
}
