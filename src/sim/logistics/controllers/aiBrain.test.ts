import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { SETTLEMENTS } from '../data/settlements.ts';
import type { CompanyDef, ScenarioConfig, SettlementDef } from '../economy/types.ts';
import { AiBrain, riskAdjustedProfit } from './aiBrain.ts';
import { createCompanyView } from './view.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const earth = SETTLEMENTS.find((s) => s.isDeepMarket)!;

/** A colony that is fully supplied except for electronics (big price gap vs Earth). */
const colony: SettlementDef = {
  id: 'col',
  name: 'Colony',
  description: '',
  site: { bodyId: 'mars', kind: 'surface' },
  population: 20_000,
  housingCapacity: 20_000,
  facilities: [],
  initialStock: { water: 1e6, oxygen: 1e6, food: 1e6, medicine: 1e4, consumer_goods: 1e5 },
  treasury: 2_000_000_000,
  isShipyard: false,
  isDeepMarket: false,
};

const company = (over: Partial<CompanyDef> = {}): CompanyDef => ({
  id: 'ai',
  name: 'AI Co',
  color: '#fff',
  personalityId: 'arbitrage',
  cash: 2_000_000_000,
  ships: [{ classId: 'torch-courier', siteId: 'earth-exchange', name: 'A' }],
  ...over,
});

const scenario = (companies: CompanyDef[]): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  settlements: [earth, colony],
  companies,
});

describe('AiBrain', () => {
  it('buys where cheap, flies to where expensive, and explains why', () => {
    const w = createWorld(scenario([company()]), eph, { controllers: true });
    w.advanceTo(START_JD + 1.5);
    const ship = [...w.ships.values()][0]!;
    expect(ship.cargo.electronics ?? 0).toBeGreaterThan(0);
    expect(ship.plan?.toSiteId).toBe('col');
    expect(ship.intent).toMatch(/electronics/);
  });

  it('skips a profitable trade when the scenario docking fee exceeds its margin', () => {
    const base = scenario([company()]);
    const withFee = (dockingFee: number) => {
      const world = createWorld({ ...base, constants: { ...base.constants, dockingFee } }, eph);
      return new AiBrain().decide(createCompanyView(world, 'ai'), [{ kind: 'periodic' }]);
    };

    expect(withFee(base.constants.dockingFee)).toContainEqual(
      expect.objectContaining({ type: 'BuyCargo', good: 'electronics' }),
    );
    expect(withFee(2_000_000_000)).not.toContainEqual(
      expect.objectContaining({ type: 'PlanAndDispatch' }),
    );
  });

  it('does not send two of its own ships after the same contract', () => {
    const w = createWorld(
      scenario([
        company({
          personalityId: 'contract',
          ships: [
            { classId: 'torch-courier', siteId: 'earth-exchange', name: 'A' },
            { classId: 'torch-courier', siteId: 'earth-exchange', name: 'B' },
          ],
        }),
      ]),
      eph,
      { controllers: true },
    );
    w.advanceTo(START_JD + 10);
    const rejected = w.events
      .recent(10_000)
      .filter((e) => e.type === 'CommandRejected' && e.reason === 'contract-not-open');
    expect(rejected).toHaveLength(0);
  });

  it('discounts long trades by risk aversion', () => {
    const revenue = 110;
    const cost = 100;
    expect(riskAdjustedProfit(revenue, cost, 300, 0.1)).toBeGreaterThan(0);
    expect(riskAdjustedProfit(revenue, cost, 300, 0.7)).toBeLessThan(0);
    expect(riskAdjustedProfit(revenue, cost, 1, 0.7)).toBeGreaterThan(0);
  });

  it('buys another ship when rich and busy', () => {
    const w = createWorld(
      scenario([company({ cash: 20_000_000_000, personalityId: 'courier' })]),
      eph,
      { controllers: true },
    );
    w.advanceTo(START_JD + 65);
    expect(w.events.recent(10_000).some((e) => e.type === 'ShipOrdered')).toBe(true);
  });

  it('runs the default scenario for a year without throwing and everyone trades', () => {
    const w = createWorld(DEFAULT_SCENARIO, eph, { controllers: true });
    w.advanceTo(START_JD + 365);
    const sold = w.events
      .recent(10_000)
      .filter((e) => e.type === 'CargoSold' || e.type === 'ContractCompleted');
    expect(sold.length).toBeGreaterThan(20);
    const active = new Set(sold.map((e) => ('companyId' in e ? e.companyId : '')));
    expect(active.size).toBeGreaterThanOrEqual(4);
  });
});
