import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { EventLog } from './events.ts';
import { Scheduler } from './scheduler.ts';
import { START_JD } from './time.ts';
import { LogisticsWorld, minimalScenario } from './world.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);

describe('Scheduler', () => {
  it('pops in time then insertion order', () => {
    const s = new Scheduler<string>();
    s.schedule(5, 'b');
    s.schedule(3, 'a');
    s.schedule(5, 'c');
    expect(s.peekJd()).toBe(3);
    expect([s.popDue(10), s.popDue(10), s.popDue(10), s.popDue(10)]).toEqual([
      'a',
      'b',
      'c',
      undefined,
    ]);
  });

  it('does not pop items scheduled after the given time', () => {
    const s = new Scheduler<string>();
    s.schedule(5, 'late');
    expect(s.popDue(4)).toBeUndefined();
    expect(s.size).toBe(1);
  });
});

describe('EventLog', () => {
  const fill = (log: EventLog, qty: number) => {
    log.append(1, { type: 'ShipIdle', shipId: 's1', companyId: 'c1' });
    log.append(2, { type: 'ShipDeparted', shipId: 's1', companyId: 'c1', toSiteId: 'mars' });
    log.append(3, {
      type: 'CargoBought',
      shipId: 's1',
      companyId: 'c1',
      settlementId: 'mars',
      good: 'steel',
      qty,
      price: 10,
    });
  };

  it('indexes events by entity and keeps a stable hash', () => {
    const a = new EventLog();
    const b = new EventLog();
    const c = new EventLog();
    fill(a, 5);
    fill(b, 5);
    fill(c, 6);
    expect(a.forEntity('s1', 10)).toHaveLength(3);
    expect(a.forEntity('mars', 10)).toHaveLength(2);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).not.toBe(c.hash());
    expect(a.recent(2).map((e) => e.seq)).toEqual([2, 1]);
  });

  it('notifies subscribers', () => {
    const log = new EventLog();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.type));
    log.append(1, { type: 'ShipIdle', shipId: 's', companyId: 'c' });
    off();
    log.append(2, { type: 'ShipIdle', shipId: 's', companyId: 'c' });
    expect(seen).toEqual(['ShipIdle']);
  });

  it('wraps the ring and per-entity lists, oldest dropped first', () => {
    const log = new EventLog();
    for (let i = 0; i < 10_250; i++) {
      log.append(i, { type: 'ShipIdle', shipId: 's', companyId: `c${i}` });
    }
    expect(log.recent(1)[0]!.seq).toBe(10_249);
    const since = log.since(0);
    expect(since).toHaveLength(10_000);
    expect(since[0]!.seq).toBe(250);
    expect(since.at(-1)!.seq).toBe(10_249);
    expect(log.since(10_240).map((e) => e.seq)).toEqual([
      10_240, 10_241, 10_242, 10_243, 10_244, 10_245, 10_246, 10_247, 10_248, 10_249,
    ]);
    const ship = log.forEntity('s', 500);
    expect(ship).toHaveLength(200);
    expect(ship[0]!.seq).toBe(10_249);
    expect(ship.at(-1)!.seq).toBe(10_050);

    const copy = new EventLog();
    copy.restore(structuredClone(log.capture()));
    expect(copy.forEntity('s', 3)).toEqual(log.forEntity('s', 3));
    expect(copy.since(0)).toEqual(since);
    expect(copy.hash()).toBe(log.hash());
  });

  it('hashes every field, including optional ones', () => {
    const a = new EventLog();
    const b = new EventLog();
    const base = { type: 'FuelPurchased', shipId: 's', companyId: 'c', settlementId: 'm' } as const;
    a.append(1, { ...base, qty: 1, cost: 2 });
    b.append(1, { ...base, qty: 1, cost: 2, emergency: true });
    expect(a.hash()).not.toBe(b.hash());
    const c = new EventLog();
    c.append(1, { ...base, qty: 1, cost: 2.000_000_001 });
    expect(a.hash()).not.toBe(c.hash());
  });

  it('drops retired entities after the grace period, also on a replica', () => {
    const log = new EventLog();
    const replica = new EventLog();
    log.append(1, { type: 'ShipIdle', shipId: 'gone', companyId: 'c' });
    log.append(2, { type: 'ShipRemoved', shipId: 'gone', companyId: 'c' });
    log.append(50, { type: 'ShipIdle', shipId: 'other', companyId: 'c' });
    expect(log.forEntity('gone', 10)).toHaveLength(2);
    log.append(200, { type: 'ShipIdle', shipId: 'other', companyId: 'c' });
    expect(log.forEntity('gone', 10)).toEqual([]);
    expect(log.forEntity('c', 10)).toHaveLength(4);
    replica.ingest(log.since(0), log.count, log.hashState);
    expect(replica.forEntity('gone', 10)).toEqual([]);
    expect(replica.indexedEntityCount).toBe(log.indexedEntityCount);
  });
});

describe('LogisticsWorld', () => {
  it('advanceTo processes whole ticks only', () => {
    const w = new LogisticsWorld(minimalScenario(1), eph);
    expect(w.advanceTo(START_JD + 1.1)).toBe(4);
    expect(w.jd).toBeCloseTo(START_JD + 1.0, 9);
  });

  it('runs scheduled items in time order before the tick containing them', () => {
    const order: string[] = [];
    const w = new LogisticsWorld(minimalScenario(1), eph, (_, action) => {
      if (action.kind === 'depart') order.push(action.shipId);
    });
    w.schedule(START_JD + 0.3, { kind: 'depart', shipId: 'b' });
    w.schedule(START_JD + 0.1, { kind: 'depart', shipId: 'a' });
    w.addPhase('probe', () => order.push(`tick@${(w.jd - START_JD).toFixed(2)}`));
    w.advanceTo(START_JD + 0.5);
    expect(order).toEqual(['a', 'tick@0.25', 'b', 'tick@0.50']);
  });

  it('budgeted advance lags but converges to the same state', () => {
    const make = () => {
      const w = new LogisticsWorld(minimalScenario(7), eph);
      w.addPhase('noise', (world) => {
        world.events.append(world.jd, {
          type: 'ShipIdle',
          shipId: `s${Math.floor(world.rng('test').next() * 100)}`,
          companyId: 'c',
        });
      });
      return w;
    };
    const a = make();
    const b = make();
    a.advanceTo(START_JD + 30);
    let guard = 0;
    while (b.jd < START_JD + 30 - 1e-9 && guard++ < 1000) b.advanceTo(START_JD + 30, 7);
    expect(b.jd).toBeCloseTo(a.jd, 9);
    expect(b.events.hash()).toBe(a.events.hash());
  });
});
