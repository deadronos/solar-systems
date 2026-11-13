import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { netWorth } from './companies.ts';
import type { ScenarioConfig } from './types.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);

const scenario = (cash: number): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  companies: [
    {
      id: 'poor',
      name: 'Poor Co',
      color: '#fff',
      personalityId: 'bulk',
      cash,
      ships: [
        { classId: 'chem-tug', siteId: 'gateway', name: 'Docked' },
        { classId: 'chem-tug', siteId: 'gateway', name: 'Flyer' },
      ],
    },
  ],
});

describe('companies', () => {
  it('goes into distress, then bankrupt after 90 days of negative cash', () => {
    const w = createWorld(scenario(-1), eph);
    w.advanceTo(START_JD + 1);
    expect(w.companies.get('poor')!.status).toBe('distress');
    w.advanceTo(START_JD + 89);
    expect(w.companies.get('poor')!.status).toBe('distress');
    w.advanceTo(START_JD + 92);
    expect(w.companies.get('poor')!.status).toBe('bankrupt');
    expect(w.events.recent(5000).some((e) => e.type === 'CompanyBankrupt')).toBe(true);
  });

  it('keeps in-transit ships until arrival, then removes them; reopens accepted contracts', () => {
    const w = createWorld(scenario(50_000_000), eph);
    const [docked, flyer] = [...w.ships.values()];
    w.advanceTo(START_JD + 2);
    const contract = [...w.contracts.values()].find((c) => c.status === 'open')!;
    expect(
      w.issue('poor', [{ type: 'AcceptContract', contractId: contract.id, shipId: docked!.id }]),
    ).toEqual([true]);
    w.companies.get('poor')!.cash = -1e9;
    w.advanceTo(START_JD + 91);
    // Short hop to Luna (days) that is still under way when bankruptcy hits (~day 92).
    w.companies.get('poor')!.cash = 1e9;
    expect(
      w.issue('poor', [{ type: 'PlanAndDispatch', shipId: flyer!.id, toSiteId: 'luna-base' }]),
    ).toEqual([true]);
    w.companies.get('poor')!.cash = -1e9;
    expect(w.ships.get(flyer!.id)!.state).toBe('in_transit');
    w.advanceTo(START_JD + 93);
    expect(w.companies.get('poor')!.status).toBe('bankrupt');
    expect(w.ships.has(docked!.id)).toBe(false);
    expect(contract.status === 'open' || contract.status === 'expired').toBe(true);
    expect(contract.companyId).toBeNull();
    expect(w.ships.get(flyer!.id)!.pendingRemoval).toBe(true);
    w.advanceTo(START_JD + 110);
    expect(w.ships.has(flyer!.id)).toBe(false);
  });

  it('a new company enters 180 days after a bankruptcy', () => {
    const w = createWorld(scenario(-1), eph);
    w.advanceTo(START_JD + 92 + 181);
    const founded = w.events.recent(10_000).filter((e) => e.type === 'CompanyFounded');
    expect(founded).toHaveLength(1);
    const entrant = w.companies.get(
      founded[0]!.type === 'CompanyFounded' ? founded[0]!.companyId : '',
    )!;
    expect(entrant.shipIds.length).toBeGreaterThan(0);
    expect(entrant.status).toBe('active');
  });

  it('net worth counts cash and ship resale value', () => {
    const w = createWorld(scenario(1_000), eph);
    expect(netWorth(w, 'poor')).toBeCloseTo(1_000 + 2 * 18_000_000 * 0.6);
  });
});
