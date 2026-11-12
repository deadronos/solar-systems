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

const open = (w: ReturnType<typeof createWorld>, good: string) =>
  [...w.contracts.values()].filter((c) => c.good === good && c.status === 'open');

describe('contracts', () => {
  it('a shortage posts exactly one delivery contract per good', () => {
    const w = createWorld(scenario([colony()]), eph);
    w.advanceTo(START_JD + 1);
    expect(open(w, 'food')).toHaveLength(1);
    expect(open(w, 'food')[0]!.kind).toBe('delivery');
    w.advanceTo(START_JD + 5);
    expect(open(w, 'food')).toHaveLength(1);
    expect(
      w.events.recent(1000).filter((e) => e.type === 'ContractPosted' && e.good === 'food'),
    ).toHaveLength(1);
  });

  it('chooses freight when a cheaper source exists and pays the source up front', () => {
    const w = createWorld(scenario([earth, colony()]), eph);
    const treasury0 = w.settlements.get('col')!.treasury;
    w.advanceTo(START_JD + 1);
    const c = open(w, 'food')[0]!;
    expect(c.kind).toBe('freight');
    expect(c.pickupSettlementId).toBe('earth-exchange');
    expect(w.settlements.get('col')!.treasury).toBeLessThan(treasury0);
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
    const w = createWorld(scenario([colony()], [company]), eph);
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
    const w = createWorld(scenario([colony()], [company]), eph);
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
