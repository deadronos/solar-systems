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

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return h >>> 0;
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
  ring: LogisticsEvent[];
  byEntity: [string, LogisticsEvent[]][];
}

/**
 * Append-only event log: ring buffer for "recent", capped per-entity indices for inspectors,
 * and a running hash over every event ever appended (for determinism checks).
 */
export class EventLog {
  #ring: LogisticsEvent[] = [];
  #byEntity = new Map<string, LogisticsEvent[]>();
  #listeners = new Set<(e: LogisticsEvent) => void>();
  #count = 0;
  #hash = FNV_OFFSET;

  capture(): EventLogState {
    return {
      count: this.#count,
      hash: this.#hash,
      ring: this.#ring,
      byEntity: [...this.#byEntity],
    };
  }

  restore(state: EventLogState): void {
    this.#count = state.count;
    this.#hash = state.hash;
    this.#ring = state.ring;
    this.#byEntity = new Map(state.byEntity);
  }

  get count(): number {
    return this.#count;
  }

  append(jd: number, payload: EventPayload): LogisticsEvent {
    const e = { ...payload, seq: this.#count++, jd } as LogisticsEvent;
    this.#hash = fnv1a(this.#hash, JSON.stringify(e));
    this.#index(e);
    for (const l of this.#listeners) l(e);
    return e;
  }

  #index(e: LogisticsEvent): void {
    this.#ring.push(e);
    if (this.#ring.length > RING_CAPACITY) this.#ring.shift();
    for (const id of eventEntityIds(e)) {
      let list = this.#byEntity.get(id);
      if (!list) this.#byEntity.set(id, (list = []));
      list.push(e);
      if (list.length > PER_ENTITY_CAPACITY) list.shift();
    }
  }

  /** Events with `seq >= fromCount` that are still in the ring (oldest first). */
  since(fromCount: number): LogisticsEvent[] {
    const start = Math.max(0, this.#ring.length - (this.#count - fromCount));
    return this.#ring.slice(start);
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
      const e = this.#ring[i]!;
      if (!filter || filter(e)) out.push(e);
    }
    return out;
  }

  /** Most recent events concerning an entity, newest first. */
  forEntity(id: string, limit: number): LogisticsEvent[] {
    const list = this.#byEntity.get(id);
    return list ? list.slice(-limit).toReversed() : [];
  }

  subscribe(fn: (e: LogisticsEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  hash(): string {
    return `${this.#count}:${this.#hash.toString(16)}`;
  }
}
