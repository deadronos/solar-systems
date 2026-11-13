import { expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../data/catalog.ts';
import { Ephemeris } from '../world/ephemeris.ts';
import { START_JD } from './core/time.ts';
import { createWorld, restoreWorld, snapshotWorld } from './createWorld.ts';
import { DEFAULT_SCENARIO } from './data/scenario.ts';

const eph = () => new Ephemeris(DEFAULT_CATALOG);

it(
  'continues the same ten-year simulation after a year-five JSON round trip',
  { timeout: 180_000 },
  () => {
    const original = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
    original.advanceTo(START_JD + 5 * 365);
    original.rng('snapshot-test').next();
    const snapshot = snapshotWorld(original);
    const restored = restoreWorld(JSON.parse(JSON.stringify(snapshot)), eph());

    expect(restored.rng('snapshot-test').next()).toBe(original.rng('snapshot-test').next());
    expect([...restored.settlements.values()].find((site) => site.isDeepMarket)?.treasury).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(restored.events.hash()).toBe(original.events.hash());

    original.advanceTo(START_JD + 10 * 365);
    restored.advanceTo(START_JD + 10 * 365);

    expect(restored.events.hash()).toBe(original.events.hash());
    expect(restored.events.recent(20)).toEqual(original.events.recent(20));
    expect(restored.settlements).toEqual(original.settlements);
    expect(restored.ships).toEqual(original.ships);
    expect(restored.companies).toEqual(original.companies);
    expect(restored.contracts).toEqual(original.contracts);
    expect(restored.stats?.delta(new Map())).toEqual(original.stats?.delta(new Map()));
  },
);

it('keeps quiet-entity history after the global ring rolls over', () => {
  const world = createWorld(DEFAULT_SCENARIO, eph());
  const quiet = world.events.append(world.jd, {
    type: 'ShipIdle',
    companyId: 'company',
    shipId: 'quiet-ship',
  });
  for (let i = 0; i < 10_001; i++) {
    world.events.append(world.jd, { type: 'ShipIdle', companyId: 'company', shipId: 'busy-ship' });
  }
  expect(world.events.since(0)).not.toContain(quiet);
  const restored = restoreWorld(snapshotWorld(world), eph());
  expect(restored.events.forEntity('quiet-ship', 1)).toEqual([quiet]);
});

it('preserves same-date order for deliveries and detaches snapshot state', () => {
  const world = createWorld(DEFAULT_SCENARIO, eph());
  const company = [...world.companies.values()][0]!;
  const yard = [...world.settlements.values()].find((site) => site.isShipyard)!;
  const shipClass = [...world.shipClasses.values()][0]!;
  const ships = ['First', 'Second'].map((name) =>
    world.addShip(company, shipClass.id, yard.id, name, 'building'),
  );
  for (const ship of ships) {
    world.schedule(START_JD + 1, { kind: 'deliverShip', shipId: ship.id, siteId: yard.id });
  }
  const snapshot = snapshotWorld(world);
  world.advanceTo(START_JD + 1);

  const restored = restoreWorld(snapshot, eph());
  expect(restored.ships.get(ships[0]!.id)?.state).toBe('building');
  restored.advanceTo(START_JD + 1);
  expect(restored.events.hash()).toBe(world.events.hash());
  const deliveries = restored.events.since(0).filter((event) => event.type === 'ShipDelivered');
  expect(deliveries.map((event) => event.shipId)).toEqual(ships.map((ship) => ship.id));
  expect(restoreWorld(snapshot, eph()).ships.get(ships[0]!.id)?.state).toBe('building');
});

it('rejects snapshots from a world that has received replica state', () => {
  const world = createWorld(DEFAULT_SCENARIO, eph());
  world.setReplicaJd(START_JD + 1);
  expect(() => snapshotWorld(world)).toThrow(/replica/i);
});

it('rejects snapshots from a world with an extra tick phase', () => {
  const world = createWorld(DEFAULT_SCENARIO, eph(), { controllers: true });
  world.addPhase('custom', (w) => {
    w.nextId('custom');
  });
  expect(() => snapshotWorld(world)).toThrow(/phase/i);
});
