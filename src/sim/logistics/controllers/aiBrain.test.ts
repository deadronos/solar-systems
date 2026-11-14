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
      const world = createWorld(
        {
          ...base,
          constants: { ...base.constants, ships: { ...base.constants.ships, dockingFee } },
        },
        eph,
      );
      return new AiBrain().decide(createCompanyView(world, 'ai'), [{ kind: 'periodic' }]);
    };

    expect(withFee(base.constants.ships.dockingFee)).toContainEqual(
      expect.objectContaining({ type: 'BuyCargo', good: 'electronics' }),
    );
    expect(withFee(2_000_000_000)).not.toContainEqual(
      expect.objectContaining({ type: 'PlanAndDispatch' }),
    );
  });

  it('returns the intent in the command batch without mutating the ship during decide', () => {
    const w = createWorld(scenario([company()]), eph);
    const ship = [...w.ships.values()][0]!;
    const before = ship.intent;
    const commands = new AiBrain().decide(createCompanyView(w, 'ai'), [
      { kind: 'shipIdle', shipId: ship.id },
    ]);

    expect(ship.intent).toBe(before);
    expect(commands.filter((cmd) => cmd.type === 'SetIntent')).toEqual([
      { type: 'SetIntent', shipId: ship.id, text: expect.stringMatching(/electronics/) },
    ]);
    w.issue('ai', commands);
    expect(ship.intent).toMatch(/electronics/);
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

  describe("rivals' inbound cargo (#16)", () => {
    /** World with our trader at Earth and a rival ship bound for the colony with `qty` t. */
    const withRivalCargo = (qty: number, state: 'in_transit' | 'docked' = 'in_transit') => {
      const rival = company({ id: 'rival', personalityId: 'bulk' });
      const w = createWorld(scenario([company(), rival]), eph);
      const ship = [...w.ships.values()].find((s) => s.companyId === 'rival')!;
      const plan = w.nav.estimateCached(
        w.shipClassOf(ship),
        w.settlements.get('earth-exchange')!,
        w.settlements.get('col')!,
        w.jd,
      )!;
      ship.state = state;
      ship.siteId = state === 'docked' ? 'earth-exchange' : null;
      ship.plan = {
        ...plan,
        classId: ship.classId,
        fromSiteId: 'earth-exchange',
        toSiteId: 'col',
        legs: [],
      };
      ship.cargo = { electronics: qty };
      return w;
    };

    it("the view reports only rivals' cargo that is on its way", () => {
      const w = withRivalCargo(120);
      expect(createCompanyView(w, 'ai').inbound('col', 'electronics')).toBe(120);
      expect(createCompanyView(w, 'ai').inbound('col', 'food')).toBe(0);
      // A company never counts its own ships as competition.
      expect(createCompanyView(w, 'rival').inbound('col', 'electronics')).toBe(0);
      const docked = withRivalCargo(120, 'docked');
      expect(createCompanyView(docked, 'ai').inbound('col', 'electronics')).toBe(0);
    });

    it('a projected bid falls with stock expected to land first, and matches the plain bid at 0', () => {
      const v = createCompanyView(withRivalCargo(0), 'ai');
      const plain = v.bid('col', 'electronics', 10);
      expect(plain).toBeGreaterThan(0);
      expect(v.bid('col', 'electronics', 10, 0)).toBe(plain);
      expect(v.bid('col', 'electronics', 10, 50)).toBeLessThan(plain);
      // Earth is a deep market: one trader's inbound cargo doesn't move its quote.
      expect(v.bid('earth-exchange', 'ore', 10, 1e4)).toBe(v.bid('earth-exchange', 'ore', 10));
    });

    it('stops chasing a sale that rivals already fill', () => {
      const decide = (qty: number) =>
        new AiBrain().decide(createCompanyView(withRivalCargo(qty), 'ai'), [{ kind: 'periodic' }]);
      const buys = (qty: number) =>
        decide(qty).filter((c) => c.type === 'BuyCargo' && c.good === 'electronics');
      expect(buys(0)).toHaveLength(1);
      // Enough inbound cargo, even at the arbitrageur's weight, to fill the colony's demand.
      const room = createCompanyView(withRivalCargo(0), 'ai').demandRoom('col', 'electronics');
      expect(buys(Math.ceil(room / 0.9) + 1)).toHaveLength(0);
    });
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
