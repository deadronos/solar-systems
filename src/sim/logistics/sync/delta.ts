import type { LogisticsEvent } from '../core/events.ts';
import type { LogisticsWorld } from '../core/world.ts';
import type { StatsCursor, StatsDelta } from '../economy/stats.ts';
import type { Company, Contract, Settlement, Ship } from '../economy/types.ts';

/**
 * Changes to one entity table since the previous delta: the entities whose content changed
 * (or are new), and the full id order when membership or order changed (removals are implied
 * by an id missing from `ids`). `ids` is null when the table holds the same ids in the same
 * order as before.
 */
export interface TableDelta<T> {
  changed: T[];
  ids: string[] | null;
}

/**
 * Everything a read-only replica needs to mirror a world: the entities that changed since the
 * last delta, plus events and chart samples appended since then. Plain data, so it crosses
 * `postMessage` by structured clone.
 */
export interface WorldDelta {
  jd: number;
  ships: TableDelta<Ship>;
  settlements: TableDelta<Settlement>;
  companies: TableDelta<Company>;
  contracts: TableDelta<Contract>;
  events: LogisticsEvent[];
  eventCount: number;
  eventHash: number;
  stats: StatsDelta | null;
}

/**
 * Number-exact JSON: `JSON.stringify` writes NaN, ±Infinity and null all as `null`, which
 * would hide a change between them.
 */
const exact = (_key: string, v: unknown) =>
  typeof v === 'number' && !Number.isFinite(v) ? `#${v}` : v;

/**
 * Diffs a live table against what was last sent. Entities are compared by a JSON signature,
 * so the sim needs no dirty marking: a change anywhere in an entity resends that entity.
 */
function tableWriter<T extends { id: string }>(map: Map<string, T>): () => TableDelta<T> {
  let sent = new Map<string, string>();
  return () => {
    const changed: T[] = [];
    const next = new Map<string, string>();
    let sameIds = map.size === sent.size;
    const previous = sent.keys();
    for (const [id, item] of map) {
      const signature = JSON.stringify(item, exact);
      if (sent.get(id) !== signature) changed.push(item);
      if (sameIds && previous.next().value !== id) sameIds = false;
      next.set(id, signature);
    }
    sent = next;
    return { changed, ids: sameIds ? null : [...map.keys()] };
  };
}

/** Produces successive deltas of a live world (each one relative to the previous). */
export function createDeltaWriter(world: LogisticsWorld): () => WorldDelta {
  let sentEvents = 0;
  const statsCursor: StatsCursor = new Map();
  const ships = tableWriter(world.ships);
  const settlements = tableWriter(world.settlements);
  const companies = tableWriter(world.companies);
  const contracts = tableWriter(world.contracts);
  return () => {
    const events = world.events.since(sentEvents);
    sentEvents = world.events.count;
    return {
      jd: world.jd,
      ships: ships(),
      settlements: settlements(),
      companies: companies(),
      contracts: contracts(),
      events,
      eventCount: world.events.count,
      eventHash: world.events.hashState,
      stats: world.stats ? world.stats.delta(statsCursor) : null,
    };
  };
}

/** Unchanged entities keep their object, so UI code can tell what changed by identity. */
function applyTable<T extends { id: string }>(map: Map<string, T>, d: TableDelta<T>): void {
  for (const item of d.changed) map.set(item.id, item);
  if (!d.ids) return;
  const current = new Map(map);
  map.clear();
  for (const id of d.ids) {
    const item = current.get(id);
    if (item) map.set(id, item);
  }
}

/**
 * Bring a replica world (built with `createWorld` but never advanced) up to date. Deltas must
 * be applied in the order they were produced, starting with the first.
 */
export function applyDelta(world: LogisticsWorld, d: WorldDelta): void {
  world.setReplicaJd(d.jd);
  applyTable(world.ships, d.ships);
  applyTable(world.settlements, d.settlements);
  applyTable(world.companies, d.companies);
  applyTable(world.contracts, d.contracts);
  world.events.ingest(d.events, d.eventCount, d.eventHash);
  if (d.stats) world.stats?.applyDelta(d.stats);
}
