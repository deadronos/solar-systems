import type { Ephemeris } from '../world/ephemeris.ts';
import { AiBrain, type AiState } from './controllers/aiBrain.ts';
import { installControllers } from './controllers/runner.ts';
import type { CompanyController, WakeReason } from './controllers/types.ts';
import { runShips } from './core/commands.ts';
import { LogisticsWorld, sortedIds, type WorldState } from './core/world.ts';
import { runCompanies } from './economy/companies.ts';
import { generateContracts } from './economy/contracts.ts';
import { initMarketRates, updateMarket } from './economy/markets.ts';
import { StatsRecorder, type StatsState } from './economy/stats.ts';
import { TICK_DAYS } from './core/time.ts';
import { runPopulation } from './economy/population.ts';
import { runProduction } from './economy/production.ts';
import type { ScenarioConfig } from './economy/types.ts';

/**
 * Build a world and install every system in the fixed tick order:
 * population (life support first) → production → markets → contracts → ships → companies →
 * stats → controllers.
 */
export interface CreateWorldOptions {
  /** Install company controllers (AI brains by default). Set false for economy-only tests. */
  controllers?: boolean | ((companyId: string) => CompanyController);
}

interface WorldRuntime {
  stats: StatsRecorder;
  pending: Map<string, WakeReason[]> | null;
  customControllers: boolean;
  phaseCount: number;
}

const runtimes = new WeakMap<LogisticsWorld, WorldRuntime>();

export function createWorld(
  config: ScenarioConfig,
  ephemeris: Ephemeris,
  options: CreateWorldOptions = {},
): LogisticsWorld {
  const world = new LogisticsWorld(config, ephemeris);
  const settlementIds = () => sortedIds(world.settlements);
  for (const id of settlementIds()) initMarketRates(world.settlements.get(id)!, world);
  world.addPhase('population', (w, dt) => {
    for (const id of settlementIds()) runPopulation(w.settlements.get(id)!, w, dt);
  });
  world.addPhase('production', (w, dt) => {
    for (const id of settlementIds()) runProduction(w.settlements.get(id)!, w, dt);
  });
  world.addPhase('markets', (w, dt) => {
    for (const id of settlementIds()) updateMarket(w.settlements.get(id)!, w, dt);
  });
  world.addPhase('contracts', (w) => generateContracts(w));
  world.addPhase('ships', (w, dt) => runShips(w, dt, sortedIds(w.ships)));
  world.addPhase('companies', (w) => runCompanies(w));
  const stats = new StatsRecorder();
  stats.attach(world);
  world.stats = stats;
  world.addPhase('stats', (w) => {
    const tick = Math.round((w.jd - w.config.startJd) / TICK_DAYS);
    if (tick % Math.round(1 / TICK_DAYS) === 0) stats.sampleDaily(w);
  });
  const ctl = options.controllers;
  const pending = ctl
    ? installControllers(world, typeof ctl === 'function' ? ctl : undefined)
    : null;
  runtimes.set(world, {
    stats,
    pending,
    customControllers: typeof ctl === 'function',
    phaseCount: world.phaseCount,
  });
  return world;
}

export interface WorldSnapshot {
  version: 1;
  config: ScenarioConfig;
  world: WorldState;
  stats: StatsState;
  controllerRunner: {
    pending: [string, WakeReason[]][];
    brains: [string, AiState][];
  } | null;
}

/** Capture a detached, JSON-safe snapshot of a standard authoritative world between ticks. */
export function snapshotWorld(world: LogisticsWorld): WorldSnapshot {
  const runtime = runtimes.get(world);
  if (!runtime || world.stats !== runtime.stats) {
    throw new Error('Snapshots require the standard createWorld runtime');
  }
  if (runtime.phaseCount !== world.phaseCount) {
    throw new Error('Snapshots require the standard createWorld phases');
  }
  if (runtime.customControllers || (!runtime.pending && world.controllers.size > 0)) {
    throw new Error('Snapshots support only the default controller runner');
  }
  const brains: [string, AiState][] = [];
  for (const [id, controller] of world.controllers) {
    if (
      !(controller instanceof AiBrain) ||
      Object.getPrototypeOf(controller) !== AiBrain.prototype
    ) {
      throw new Error(`Controller "${id}" cannot be snapshotted`);
    }
    brains.push([id, controller.capture()]);
  }
  return structuredClone({
    version: 1,
    config: world.config,
    world: world.capture(),
    stats: runtime.stats.capture(),
    controllerRunner: runtime.pending ? { pending: [...runtime.pending], brains } : null,
  });
}

/** Restore a snapshot with the same ephemeris catalog used by the original world. */
export function restoreWorld(snapshot: WorldSnapshot, ephemeris: Ephemeris): LogisticsWorld {
  if (snapshot.version !== 1) throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
  const state = structuredClone(snapshot);
  const world = createWorld(state.config, ephemeris, {
    controllers: state.controllerRunner !== null,
  });
  const runtime = runtimes.get(world)!;
  world.restore(state.world);
  runtime.stats.restore(state.stats);
  if (state.controllerRunner) {
    world.controllers.clear();
    for (const [id, memory] of state.controllerRunner.brains) {
      const brain = new AiBrain();
      brain.restore(memory);
      world.setController(id, brain);
    }
    for (const [id, reasons] of state.controllerRunner.pending) runtime.pending!.set(id, reasons);
  }
  return world;
}
