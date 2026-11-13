/**
 * Domain events. Every state change in the logistics world is announced here; the UI feed,
 * controllers and stats all consume the same log. Events carry the ids they concern so
 * observers can index and click through.
 */
type Ids = {
  shipId?: string;
  companyId?: string;
  settlementId?: string;
  contractId?: string;
};

export type EventPayload =
  | {
      type: 'ContractPosted';
      contractId: string;
      settlementId: string;
      good: string;
      qty: number;
      reward: number;
      kind: 'delivery' | 'freight';
      pickupSettlementId?: string;
    }
  | {
      type: 'ContractAccepted';
      contractId: string;
      companyId: string;
      shipId: string;
      settlementId: string;
    }
  | {
      type: 'ContractCompleted';
      contractId: string;
      companyId: string;
      shipId: string;
      settlementId: string;
      good: string;
      qty: number;
      reward: number;
    }
  | {
      type: 'ContractExpired';
      contractId: string;
      settlementId: string;
      companyId?: string;
      penalty: number;
    }
  | {
      type: 'ContractAbandoned';
      contractId: string;
      companyId: string;
      shipId: string;
      settlementId: string;
      penalty: number;
    }
  | {
      type: 'ShipDeparted';
      shipId: string;
      companyId: string;
      fromSiteId?: string;
      toSiteId: string;
      arriveJd?: number;
    }
  | { type: 'ShipArrived'; shipId: string; companyId: string; settlementId: string }
  | { type: 'ShipIntentChanged'; shipId: string; companyId: string; text: string }
  | { type: 'ShipIdle'; shipId: string; companyId: string; settlementId?: string }
  | {
      type: 'CargoBought';
      shipId: string;
      companyId: string;
      settlementId: string;
      good: string;
      qty: number;
      price: number;
    }
  | {
      type: 'CargoSold';
      shipId: string;
      companyId: string;
      settlementId: string;
      good: string;
      qty: number;
      price: number;
    }
  | {
      type: 'FuelPurchased';
      shipId: string;
      companyId: string;
      settlementId: string;
      qty: number;
      cost: number;
      emergency?: boolean;
    }
  | {
      type: 'ShipOrdered';
      shipId: string;
      companyId: string;
      settlementId: string;
      classId: string;
      price: number;
    }
  | { type: 'ShipDelivered'; shipId: string; companyId: string; settlementId: string }
  | { type: 'ShipSold'; shipId: string; companyId: string; settlementId?: string; value: number }
  | { type: 'ShipRemoved'; shipId: string; companyId: string }
  | {
      type: 'LocalShuttle';
      settlementId: string;
      pickupSettlementId: string;
      good: string;
      qty: number;
      cost: number;
    }
  | { type: 'PriceChanged'; settlementId: string; good: string; from: number; to: number }
  | { type: 'Shortage'; settlementId: string; tier: 'survival' }
  | { type: 'ShortageResolved'; settlementId: string; tier: 'survival' }
  | { type: 'PopulationMilestone'; settlementId: string; population: number }
  | { type: 'HousingExpanded'; settlementId: string; capacity: number }
  | { type: 'CompanyFounded'; companyId: string }
  | { type: 'CompanyInDistress'; companyId: string; cash: number }
  | { type: 'CompanyRecovered'; companyId: string; cash: number }
  | { type: 'CompanyBankrupt'; companyId: string }
  | {
      type: 'CommandRejected';
      companyId: string;
      command: string;
      reason: string;
      shipId?: string;
    };

export type EventType = EventPayload['type'];

export type LogisticsEvent = EventPayload & { seq: number; jd: number };

const RING_CAPACITY = 10_000;
const PER_ENTITY_CAPACITY = 200;
/**
 * Days a retired entity's per-entity history is kept (so an open inspector still shows it)
 * before the index entry is dropped. Matches the contract table's prune age.
 */
const RETIRED_GRACE_DAYS = 90;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return h >>> 0;
}

const mix = (h: number, word: number): number => Math.imul(h ^ word, FNV_PRIME) >>> 0;

const f64 = new Float64Array(1);
const f64Words = new Uint32Array(f64.buffer);

/**
 * Fold one event into the running hash: each defined field as key, type tag and value, in the
 * event's own key order (fixed by how each emitter builds the payload). Allocation-free, unlike
 * hashing `JSON.stringify(e)`. Numbers hash by their float64 bits.
 */
function hashEvent(h: number, e: LogisticsEvent): number {
  const r = e as unknown as Record<string, unknown>;
  for (const k in r) {
    const v = r[k];
    switch (typeof v) {
      case 'string':
        h = fnv1a(mix(fnv1a(h, k), 1), v);
        break;
      case 'number':
        f64[0] = v;
        h = mix(mix(mix(fnv1a(h, k), 2), f64Words[0]!), f64Words[1]!);
        break;
      case 'boolean':
        h = mix(fnv1a(h, k), v ? 3 : 4);
        break;
      default:
        break; // undefined fields are skipped, as JSON would
    }
  }
  return h;
}

/**
 * Fixed-capacity circular buffer: O(1) append that overwrites the oldest entry once full.
 * Index 0 is the oldest entry. Storage grows lazily, so short histories stay small.
 */
class Ring<T> {
  readonly capacity: number;
  #items: T[] = [];
  #head = 0;

  constructor(capacity: number, from: readonly T[] = []) {
    this.capacity = capacity;
    for (const x of from.slice(-capacity)) this.push(x);
  }

  get length(): number {
    return this.#items.length;
  }

  push(x: T): void {
    if (this.#items.length < this.capacity) {
      this.#items.push(x);
    } else {
      this.#items[this.#head] = x;
      this.#head = (this.#head + 1) % this.capacity;
    }
  }

  /** Entry `i` counting from the oldest. */
  at(i: number): T {
    return this.#items[(this.#head + i) % this.#items.length]!;
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.#items.slice(this.#head), ...this.#items.slice(0, this.#head)];
  }
}

/** Id whose history ends with this event, if it is terminal for that entity. */
function retiredId(e: EventPayload): string | null {
  switch (e.type) {
    case 'ShipRemoved':
      return e.shipId;
    case 'ContractCompleted':
    case 'ContractExpired':
      return e.contractId;
    case 'CompanyBankrupt':
      return e.companyId;
    default:
      return null;
  }
}

/** Ids referenced by an event (used for per-entity indexing and click-through). */
export function eventEntityIds(e: EventPayload): string[] {
  const ids: string[] = [];
  const r = e as Ids & { pickupSettlementId?: string; toSiteId?: string; fromSiteId?: string };
  if (r.shipId) ids.push(r.shipId);
  if (r.companyId) ids.push(r.companyId);
  if (r.settlementId) ids.push(r.settlementId);
  if (r.contractId) ids.push(r.contractId);
  if (r.pickupSettlementId) ids.push(r.pickupSettlementId);
  if (r.fromSiteId) ids.push(r.fromSiteId);
  if (r.toSiteId) ids.push(r.toSiteId);
  return ids;
}

export interface EventLogState {
  count: number;
  hash: number;
  /** Oldest first. */
  ring: LogisticsEvent[];
  /** Per-entity histories, oldest first. */
  byEntity: [string, LogisticsEvent[]][];
  /** Retired ids and the jd they retired, oldest first (absent in older snapshots). */
  retired?: [string, number][];
}

/**
 * Append-only event log: ring buffer for "recent", capped per-entity indices for inspectors,
 * and a running hash over every event ever appended (for determinism checks). Per-entity
 * indices of removed ships, finished contracts and bankrupt companies are dropped
 * `RETIRED_GRACE_DAYS` after their terminal event. The same happens on a replica that
 * `ingest`s the events, so both sides stay bounded.
 */
export class EventLog {
  #ring = new Ring<LogisticsEvent>(RING_CAPACITY);
  #byEntity = new Map<string, Ring<LogisticsEvent>>();
  /** Retirement queue in jd order; `#retiredHead` is the next entry to prune. */
  #retired: [string, number][] = [];
  #retiredHead = 0;
  #listeners = new Set<(e: LogisticsEvent) => void>();
  #count = 0;
  #hash = FNV_OFFSET;

  capture(): EventLogState {
    return {
      count: this.#count,
      hash: this.#hash,
      ring: this.#ring.toArray(),
      byEntity: Array.from(this.#byEntity, ([id, list]) => [id, list.toArray()]),
      retired: this.#retired.slice(this.#retiredHead),
    };
  }

  restore(state: EventLogState): void {
    this.#count = state.count;
    this.#hash = state.hash;
    this.#ring = new Ring(RING_CAPACITY, state.ring);
    this.#byEntity = new Map(
      state.byEntity.map(([id, list]) => [id, new Ring(PER_ENTITY_CAPACITY, list)]),
    );
    this.#retired = state.retired ?? [];
    this.#retiredHead = 0;
  }

  get count(): number {
    return this.#count;
  }

  append(jd: number, payload: EventPayload): LogisticsEvent {
    const e = { ...payload, seq: this.#count++, jd } as LogisticsEvent;
    this.#hash = hashEvent(this.#hash, e);
    this.#index(e);
    for (const l of this.#listeners) l(e);
    return e;
  }

  #index(e: LogisticsEvent): void {
    this.#prune(e.jd);
    this.#ring.push(e);
    for (const id of eventEntityIds(e)) {
      let list = this.#byEntity.get(id);
      if (!list) this.#byEntity.set(id, (list = new Ring(PER_ENTITY_CAPACITY)));
      list.push(e);
    }
    const retired = retiredId(e);
    if (retired) this.#retired.push([retired, e.jd]);
  }

  /** Drop per-entity histories whose grace period has passed by `jd`. */
  #prune(jd: number): void {
    const q = this.#retired;
    while (this.#retiredHead < q.length && q[this.#retiredHead]![1] + RETIRED_GRACE_DAYS < jd) {
      this.#byEntity.delete(q[this.#retiredHead]![0]);
      this.#retiredHead++;
    }
    // Compact the consumed prefix now and then, so the queue doesn't grow forever.
    if (this.#retiredHead > 1024 && this.#retiredHead * 2 > q.length) {
      this.#retired = q.slice(this.#retiredHead);
      this.#retiredHead = 0;
    }
  }

  /** Number of entities with a per-entity history (for tests and diagnostics). */
  get indexedEntityCount(): number {
    return this.#byEntity.size;
  }

  /** Events with `seq >= fromCount` that are still in the ring (oldest first). */
  since(fromCount: number): LogisticsEvent[] {
    const n = this.#ring.length;
    const out: LogisticsEvent[] = [];
    for (let i = Math.max(0, n - (this.#count - fromCount)); i < n; i++) {
      out.push(this.#ring.at(i));
    }
    return out;
  }

  /** Running hash state, for mirroring the log elsewhere (see `ingest`). */
  get hashState(): number {
    return this.#hash;
  }

  /**
   * Mirror events appended to another log (e.g. in a worker): index them for `recent` and
   * `forEntity` and adopt that log's count and hash. Listeners are not notified.
   */
  ingest(events: readonly LogisticsEvent[], count: number, hashState: number): void {
    for (const e of events) if (e.seq >= this.#count) this.#index(e);
    this.#count = count;
    this.#hash = hashState;
  }

  /** Most recent events first. */
  recent(limit: number, filter?: (e: LogisticsEvent) => boolean): LogisticsEvent[] {
    const out: LogisticsEvent[] = [];
    for (let i = this.#ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.#ring.at(i);
      if (!filter || filter(e)) out.push(e);
    }
    return out;
  }

  /** Most recent events concerning an entity, newest first. */
  forEntity(id: string, limit: number): LogisticsEvent[] {
    const list = this.#byEntity.get(id);
    if (!list) return [];
    const out: LogisticsEvent[] = [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) out.push(list.at(i));
    return out;
  }

  subscribe(fn: (e: LogisticsEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  hash(): string {
    return `${this.#count}:${this.#hash.toString(16)}`;
  }
}
