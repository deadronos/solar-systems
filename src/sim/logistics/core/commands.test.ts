import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import type { ScenarioConfig } from '../economy/types.ts';
import { START_JD } from './time.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);

/** One company ("t") with one ship of the given class at the given site. */
const scenario = (classId: string, siteId: string, cash = 500_000_000): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  companies: [
    {
      id: 't',
      name: 'Test Co',
      color: '#fff',
      personalityId: 'bulk',
      cash,
      ships: [{ classId, siteId, name: 'T1' }],
    },
  ],
});

const rejections = (w: ReturnType<typeof createWorld>) =>
  w.events
    .recent(100, (e) => e.type === 'CommandRejected')
    .map((e) => (e.type === 'CommandRejected' ? e.reason : ''));

describe('commands', () => {
  it('buy → dispatch → arrive → sell moves stock and cash and emits events in order', () => {
    const w = createWorld(scenario('torch-courier', 'earth-exchange'), eph);
    const ship = [...w.ships.values()][0]!;
    const co = w.companies.get('t')!;
    const cash0 = co.cash;
    expect(
      w.issue('t', [
        { type: 'BuyCargo', shipId: ship.id, good: 'electronics', qty: 100, maxPrice: 1e9 },
      ]),
    ).toEqual([true]);
    expect(ship.cargo.electronics).toBe(100);
    expect(co.cash).toBeLessThan(cash0);
    expect(
      w.issue('t', [{ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'mars-colony' }]),
    ).toEqual([true]);
    expect(ship.plan).not.toBeNull();
    const arrive = ship.plan!.arriveJd;
    w.advanceTo(arrive + 0.5);
    expect(ship.state).toBe('docked');
    expect(ship.siteId).toBe('mars-colony');
    const marsStock = w.settlements.get('mars-colony')!.market.electronics.stock;
    void rejections;
    expect(
      w.issue('t', [
        { type: 'SellCargo', shipId: ship.id, good: 'electronics', qty: 50, minPrice: 0 },
      ]),
    ).toEqual([true]);
    expect(w.settlements.get('mars-colony')!.market.electronics.stock).toBeCloseTo(marsStock + 50);
    const types = w.events
      .forEntity(ship.id, 50)
      .map((e) => e.type)
      .toReversed();
    expect(types.filter((t) => t !== 'ShipIdle')).toEqual([
      'CargoBought',
      'FuelPurchased',
      'ShipDeparted',
      'ShipArrived',
      'CargoSold',
    ]);
  });

  it('buys departure fuel from the local market for chemical ships', () => {
    const w = createWorld(scenario('chem-tug', 'gateway'), eph);
    const ship = [...w.ships.values()][0]!;
    const fuel0 = w.settlements.get('gateway')!.market.fuel.stock;
    expect(
      w.issue('t', [{ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'luna-base' }]),
    ).toEqual([true]);
    expect(w.settlements.get('gateway')!.market.fuel.stock).toBeLessThan(fuel0);
    expect(w.events.recent(10).some((e) => e.type === 'FuelPurchased')).toBe(true);
  });

  it('rejects invalid commands with reasons', () => {
    const w = createWorld(scenario('chem-tug', 'gateway', 10), eph);
    const ship = [...w.ships.values()][0]!;
    const res = w.issue('t', [
      { type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'gateway' },
      { type: 'BuyCargo', shipId: ship.id, good: 'water', qty: 10, maxPrice: 1e9 },
      { type: 'BuyCargo', shipId: ship.id, good: 'water', qty: 1e6, maxPrice: 1e9 },
      { type: 'BuyCargo', shipId: ship.id, good: 'water', qty: 1, maxPrice: 0.01 },
      { type: 'BuyCargo', shipId: 'nope', good: 'water', qty: 1, maxPrice: 1e9 },
      { type: 'SellShip', shipId: ship.id },
    ]);
    expect(res).toEqual([false, false, false, false, false, true]);
    expect(rejections(w).toReversed()).toEqual([
      'same-site',
      'insufficient-cash',
      'cargo-full',
      'price-above-limit',
      'unknown-ship',
    ]);
  });

  it('rejects dispatch without fuel at the site and from an unknown company', () => {
    const w = createWorld(scenario('chem-tug', 'vesta-mines'), eph);
    const ship = [...w.ships.values()][0]!;
    w.settlements.get('vesta-mines')!.market.fuel.stock = 0;
    expect(
      w.issue('t', [{ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'ceres-colony' }]),
    ).toEqual([false]);
    expect(w.issue('other', [{ type: 'SellShip', shipId: ship.id }])).toEqual([false]);
    expect(rejections(w)).toEqual(['unknown-company', 'no-fuel']);
  });

  it('delivers purchased ships after their build time', () => {
    const w = createWorld(scenario('chem-tug', 'gateway'), eph);
    expect(
      w.issue('t', [{ type: 'PurchaseShip', classId: 'chem-tug', shipyardSiteId: 'gateway' }]),
    ).toEqual([true]);
    const built = [...w.ships.values()].find((s) => s.state === 'building')!;
    w.advanceTo(START_JD + 59);
    expect(built.state).toBe('building');
    w.advanceTo(START_JD + 61);
    expect(built.state).toBe('docked');
  });

  it('refuses to sell a ship that carries cargo', () => {
    const w = createWorld(scenario('chem-tug', 'gateway'), eph);
    const ship = [...w.ships.values()][0]!;
    w.issue('t', [{ type: 'BuyCargo', shipId: ship.id, good: 'fuel', qty: 1, maxPrice: 1e9 }]);
    expect(w.issue('t', [{ type: 'SellShip', shipId: ship.id }])).toEqual([false]);
  });
});
