import type { LogisticsWorld } from '../core/world.ts';
import { netWorth } from './companies.ts';
import { GOOD_IDS } from './types.ts';

export type StatKey =
  | 'companyCash'
  | 'companyNetWorth'
  | 'settlementPopulation'
  | `price:${string}`
  | 'tradeVolumeT';

export interface Sample {
  jd: number;
  v: number;
}

const MAX_SAMPLES = 3_650;
/** Trade-flow tonnage decays with this time constant (days) — a ~1-year rolling view. */
const FLOW_DECAY_DAYS = 365;

/**
 * Daily time series for charts plus rolling trade flows between settlements, fed by the
 * event log. Pure observer: never mutates the world.
 */
export class StatsRecorder {
  #series = new Map<string, Sample[]>();
  #todayVolume = 0;
  #window: number[] = [];
  /** Tonnes sold/delivered over the last 365 days. */
  tradeVolume365 = 0;
  /** `${from}>${to}|${companyId}` → decayed tonnage. */
  readonly flows = new Map<string, number>();
  #lastDeparture = new Map<string, string>();

  attach(world: LogisticsWorld): void {
    world.events.subscribe((e) => {
      switch (e.type) {
        case 'ShipDeparted':
          if (e.fromSiteId) this.#lastDeparture.set(e.shipId, e.fromSiteId);
          break;
        case 'CargoSold':
        case 'ContractCompleted': {
          this.#todayVolume += e.qty;
          const from = this.#lastDeparture.get(e.shipId);
          if (from && from !== e.settlementId) {
            const key = `${from}>${e.settlementId}|${e.companyId}`;
            this.flows.set(key, (this.flows.get(key) ?? 0) + e.qty);
          }
          break;
        }
        default:
          break;
      }
    });
  }

  #push(key: string, id: string, jd: number, v: number): void {
    const k = `${key}|${id}`;
    let s = this.#series.get(k);
    if (!s) this.#series.set(k, (s = []));
    s.push({ jd, v });
    if (s.length > MAX_SAMPLES) {
      // Downsample ×2, keeping the newest sample.
      const kept = s.filter((_, i) => i % 2 === (s!.length - 1) % 2);
      s.length = 0;
      s.push(...kept);
    }
  }

  sampleDaily(world: LogisticsWorld): void {
    const jd = world.jd;
    for (const c of world.companies.values()) {
      if (c.status === 'bankrupt') continue;
      this.#push('companyCash', c.id, jd, c.cash);
      this.#push('companyNetWorth', c.id, jd, netWorth(world, c.id));
    }
    for (const s of world.settlements.values()) {
      if (s.isDeepMarket) continue;
      this.#push('settlementPopulation', s.id, jd, s.population);
      for (const g of GOOD_IDS) {
        if (s.market[g].targetStock > 0) this.#push(`price:${g}`, s.id, jd, s.market[g].price);
      }
    }
    this.#window.push(this.#todayVolume);
    this.tradeVolume365 += this.#todayVolume;
    this.#todayVolume = 0;
    if (this.#window.length > 365) this.tradeVolume365 -= this.#window.shift()!;
    this.#push('tradeVolumeT', 'global', jd, this.tradeVolume365);
    const decay = Math.exp(-1 / FLOW_DECAY_DAYS);
    for (const [k, v] of this.flows) {
      const nv = v * decay;
      if (nv < 1) this.flows.delete(k);
      else this.flows.set(k, nv);
    }
  }

  series(key: StatKey, id: string): readonly Sample[] {
    return this.#series.get(`${key}|${id}`) ?? [];
  }
}
