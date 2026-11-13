import type { LogisticsEvent } from '../core/events.ts';
import type { LogisticsWorld } from '../core/world.ts';
import type { StatsCursor, StatsDelta } from '../economy/stats.ts';
import type { Company, Contract, Settlement, Ship } from '../economy/types.ts';

/**
 * Everything a read-only replica needs to mirror a world: entity tables in full (they are
 * small: ~50 KB after decades), plus events and chart samples appended since the last delta.
 * Plain data, so it crosses `postMessage` by structured clone.
 */
export interface WorldDelta {
  jd: number;
  ships: Ship[];
  settlements: Settlement[];
  companies: Company[];
  contracts: Contract[];
  events: LogisticsEvent[];
  eventCount: number;
  eventHash: number;
  stats: StatsDelta | null;
}

/** Produces successive deltas of a live world (each one relative to the previous). */
export function createDeltaWriter(world: LogisticsWorld): () => WorldDelta {
  let sentEvents = 0;
  const statsCursor: StatsCursor = new Map();
  return () => {
    const events = world.events.since(sentEvents);
    sentEvents = world.events.count;
    return {
      jd: world.jd,
      ships: [...world.ships.values()],
      settlements: [...world.settlements.values()],
      companies: [...world.companies.values()],
      contracts: [...world.contracts.values()],
      events,
      eventCount: world.events.count,
      eventHash: world.events.hashState,
      stats: world.stats ? world.stats.delta(statsCursor) : null,
    };
  };
}

function replace<T extends { id: string }>(map: Map<string, T>, items: readonly T[]): void {
  map.clear();
  for (const item of items) map.set(item.id, item);
}

/**
 * Bring a replica world (built with `createWorld` but never advanced) up to date. Deltas must
 * be applied in the order they were produced.
 */
export function applyDelta(world: LogisticsWorld, d: WorldDelta): void {
  world.setReplicaJd(d.jd);
  replace(world.ships, d.ships);
  replace(world.settlements, d.settlements);
  replace(world.companies, d.companies);
  replace(world.contracts, d.contracts);
  world.events.ingest(d.events, d.eventCount, d.eventHash);
  if (d.stats) world.stats?.applyDelta(d.stats);
}
