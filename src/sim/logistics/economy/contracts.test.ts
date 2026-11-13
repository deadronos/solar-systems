import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { SETTLEMENTS } from '../data/settlements.ts';
import type { CompanyDef, ScenarioConfig, SettlementDef } from './types.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const earth = SETTLEMENTS.find((s) => s.isDeepMarket)!;

const colony = (over: Partial<SettlementDef> = {}): SettlementDef => ({
  id: 'col',
  name: 'Colony',
  description: '',
  site: { bodyId: 'mars', kind: 'surface' },
  population: 10_000,
  housingCapacity: 11_000,
  facilities: [],
  initialStock: { water: 1e5, oxygen: 1e5 },
  treasury: 500_000_000,
  isShipyard: false,
  isDeepMarket: false,
  ...over,
});

const scenario = (settlements: SettlementDef[], companies: CompanyDef[] = []): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  settlements,
  companies,
});

/** Colonies start with a year of survival stock; tests empty the food store. */
const starve = (w: ReturnType<typeof createWorld>, id = 'col') => {
  w.settlements.get(id)!.market.food.stock = 0;
  return w;
};

const open = (w: ReturnType<typeof createWorld>, good: string) =>
  [...w.contracts.values()].filter((c) => c.good === good && c.status === 'open');

describe('contracts', () => {
  it('a shortage posts one order per good per day until the shortfall is covered', () => {
    const w = starve(createWorld(scenario([colony()]), eph));
    w.advanceTo(START_JD + 1);
    expect(open(w, 'food')).toHaveLength(1);
    expect(open(w, 'food')[0]!.kind).toBe('delivery');
    expect(open(w, 'food')[0]!.qty).toBeLessThanOrEqual(800);
    w.advanceTo(START_JD + 3);
    expect(open(w, 'food')).toHaveLength(3);
    w.advanceTo(START_JD + 40);
    const covered = open(w, 'food').reduce((a, c) => a + c.qty, 0);
    w.advanceTo(START_JD + 45);
    expect(open(w, 'food').reduce((a, c) => a + c.qty, 0)).toBe(covered);
  });

  it('chooses freight from a cheap nearby source and pays the source up front', () => {
    const farm = colony({
      id: 'farm',
      name: 'Farm',
      site: { bodyId: 'phobos', kind: 'surface' },
      population: 100,
      facilities: [{ recipeId: 'grow_food', maxRatePerDay: 50 }],
      initialStock: { water: 1e6, oxygen: 1e5, food: 50_000 },
    });
    const w = starve(createWorld(scenario([earth, colony(), farm]), eph));
    const treasury0 = w.settlements.get('col')!.treasury;
    w.advanceTo(START_JD + 1);
    const c = open(w, 'food')[0]!;
    expect(c.kind).toBe('freight');
    expect(c.pickupSettlementId).toBe('farm');
    expect(w.settlements.get('col')!.treasury).toBeLessThan(treasury0);
  });

  it('buys directly from a same-body neighbour without a ship', () => {
    const station = colony({
      id: 'station',
      name: 'Station',
      site: { bodyId: 'earth', kind: 'orbit' },
    });
    const w = starve(createWorld(scenario([earth, station]), eph), 'station');
    w.advanceTo(START_JD + 1);
    expect(w.settlements.get('station')!.market.food.stock).toBeGreaterThan(0);
    expect(w.events.recent(100).some((e) => e.type === 'LocalShuttle')).toBe(true);
  });

  it('a broke settlement posts nothing', () => {
    const cfg = scenario([colony({ treasury: 0 })]);
    const w = createWorld(
      { ...cfg, constants: { ...cfg.constants, stipendPerCapitaPerDay: 0 } },
      eph,
    );
    w.advanceTo(START_JD + 1);
    expect([...w.contracts.values()]).toHaveLength(0);
  });

  it('expired accepted contracts emit an event and penalise the carrier', () => {
    const company: CompanyDef = {
      id: 't',
      name: 'T',
      color: '#fff',
      personalityId: 'bulk',
      cash: 1e9,
      ships: [{ classId: 'chem-tug', siteId: 'col', name: 'x' }],
    };
    const w = starve(createWorld(scenario([colony()], [company]), eph));
    w.advanceTo(START_JD + 1);
    const c = open(w, 'food')[0]!;
    const ship = [...w.ships.values()][0]!;
    expect(w.issue('t', [{ type: 'AcceptContract', contractId: c.id, shipId: ship.id }])).toEqual([
      true,
    ]);
    const cash = w.companies.get('t')!.cash;
    w.advanceTo(c.deadlineJd + 1);
    expect(c.status).toBe('expired');
    expect(ship.contractId).toBeNull();
    const ev = w.events.forEntity(c.id, 10).find((e) => e.type === 'ContractExpired');
    expect(ev && ev.type === 'ContractExpired' && ev.penalty).toBeGreaterThan(0);
    expect(w.companies.get('t')!.cash).toBeLessThan(cash);
  });

  it('DeliverContract completes and pays the reward', () => {
    const company: CompanyDef = {
      id: 't',
      name: 'T',
      color: '#fff',
      personalityId: 'bulk',
      cash: 1e9,
      ships: [{ classId: 'chem-tug', siteId: 'col', name: 'x' }],
    };
    const w = starve(createWorld(scenario([colony()], [company]), eph));
    w.advanceTo(START_JD + 1);
    const c = open(w, 'food')[0]!;
    const ship = [...w.ships.values()][0]!;
    ship.cargo.food = c.qty;
    const cash = w.companies.get('t')!.cash;
    expect(
      w.issue('t', [
        { type: 'AcceptContract', contractId: c.id, shipId: ship.id },
        { type: 'DeliverContract', contractId: c.id },
      ]),
    ).toEqual([true, true]);
    expect(c.status).toBe('completed');
    expect(w.companies.get('t')!.cash).toBeCloseTo(cash + c.reward, 3);
  });
});
