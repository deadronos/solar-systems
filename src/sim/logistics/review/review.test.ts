import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Simulation } from '../../simulation.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { AiBrain } from '../controllers/aiBrain.ts';
import { createCompanyView } from '../controllers/view.ts';
import { START_JD } from '../core/time.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { SETTLEMENTS } from '../data/settlements.ts';
import type { CompanyDef, Contract, ScenarioConfig, SettlementDef } from '../economy/types.ts';

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
const farm = colony({
  id: 'farm',
  name: 'Farm',
  site: { bodyId: 'phobos', kind: 'surface' },
  population: 100,
  facilities: [{ recipeId: 'grow_food', maxRatePerDay: 50 }],
  initialStock: { water: 1e6, oxygen: 1e5, food: 50_000, fuel: 50_000 },
});
const carrier: CompanyDef = {
  id: 't',
  name: 'T',
  color: '#fff',
  personalityId: 'contract',
  cash: 1e9,
  ships: [{ classId: 'ntr-freighter', siteId: 'farm', name: 'X' }],
};
const scenario = (companies: CompanyDef[] = []): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  settlements: [earth, colony(), farm],
  companies,
});

/** A world with a freight order from 'farm' to 'col' already posted. */
function withFreight(companies: CompanyDef[] = []) {
  const w = createWorld(scenario(companies), eph);
  w.settlements.get('col')!.market.food.stock = 0;
  w.advanceTo(START_JD + 1);
  const c = [...w.contracts.values()].find(
    (x) => x.kind === 'freight' && x.status === 'open',
  ) as Contract;
  expect(c).toBeDefined();
  return { w, c };
}

describe('review fixes', () => {
  it('refunds the buyer when unloaded freight expires', () => {
    const { w, c } = withFreight();
    const col = w.settlements.get('col')!;
    const before = col.treasury;
    expect(c.escrowCost).toBeGreaterThan(0);
    w.advanceTo(c.deadlineJd + 1);
    expect(c.status).toBe('expired');
    // Stipend accrues meanwhile; the refund must come on top of it.
    expect(col.treasury - before).toBeGreaterThan(c.escrowCost * 0.99);
  });

  it('only delivers freight that was actually loaded', () => {
    const { w, c } = withFreight([carrier]);
    const ship = [...w.ships.values()][0]!;
    expect(w.issue('t', [{ type: 'AcceptContract', contractId: c.id, shipId: ship.id }])).toEqual([
      true,
    ]);
    ship.cargo.food = c.qty; // the carrier's own food, not the escrowed goods
    ship.siteId = 'col';
    expect(w.issue('t', [{ type: 'DeliverContract', contractId: c.id }])).toEqual([false]);
  });

  it('keeps loaded freight deliverable after its deadline (late, with a penalty)', () => {
    const { w, c } = withFreight([carrier]);
    const ship = [...w.ships.values()][0]!;
    expect(
      w.issue('t', [
        { type: 'AcceptContract', contractId: c.id, shipId: ship.id },
        { type: 'LoadContractCargo', contractId: c.id },
      ]),
    ).toEqual([true, true]);
    const cash = w.companies.get('t')!.cash;
    w.advanceTo(c.deadlineJd + 1);
    expect(c.status).toBe('loaded');
    expect(ship.contractId).toBe(c.id);
    expect(w.companies.get('t')!.cash).toBeLessThan(cash);
  });

  it('the AI adopts a contract its ship holds even if its memory lost it', () => {
    const { w, c } = withFreight([carrier]);
    const ship = [...w.ships.values()][0]!;
    expect(w.issue('t', [{ type: 'AcceptContract', contractId: c.id, shipId: ship.id }])).toEqual([
      true,
    ]);
    const brain = new AiBrain(); // fresh memory: knows nothing about the contract
    const cmds = brain.decide(createCompanyView(w, 't'), [{ kind: 'shipIdle', shipId: ship.id }]);
    expect(cmds.some((x) => x.type === 'AcceptContract')).toBe(false);
    expect(cmds.some((x) => x.type === 'LoadContractCargo' && x.contractId === c.id)).toBe(true);
  });

  it('the AI does not plan new work in the same decision that sells cargo', () => {
    const w = createWorld(scenario([carrier]), eph);
    const ship = [...w.ships.values()][0]!;
    ship.siteId = 'col';
    ship.cargo.water = 10;
    w.settlements.get('col')!.market.water.stock = 0;
    const cmds = new AiBrain().decide(createCompanyView(w, 't'), [
      { kind: 'shipArrived', shipId: ship.id },
    ]);
    expect(cmds.some((x) => x.type === 'SellCargo')).toBe(true);
    expect(
      cmds.some(
        (x) => x.type === 'AcceptContract' || x.type === 'PlanAndDispatch' || x.type === 'BuyCargo',
      ),
    ).toBe(false);
  });
});

describe('frame time budget', () => {
  it('stops processing ticks once the per-frame time budget is spent', () => {
    let t = 0;
    const sim = new Simulation({
      scenario: DEFAULT_SCENARIO,
      rate: 31_557_600,
      maxStepMs: 10,
      now: () => (t += 4), // every tick chunk "takes" 4 ms
    });
    const jd0 = sim.logistics!.jd;
    sim.step(0.1); // asks for ~0.1 yr = 146 ticks
    const ticks = Math.round((sim.logistics!.jd - jd0) / 0.25);
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(40);
  });
});
