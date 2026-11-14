import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { SETTLEMENTS } from '../data/settlements.ts';
import { expireContract } from './contracts.ts';
import { deepPriceFor, quoteSell } from './markets.ts';
import { ledgerTotal, moneySupply } from './money.ts';
import type { CompanyDef, ScenarioConfig, SettlementDef } from './types.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const C = DEFAULT_SCENARIO.constants;
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

/** A food producer on Phobos with a large surplus. */
const farm = colony({
  id: 'farm',
  name: 'Farm',
  site: { bodyId: 'phobos', kind: 'surface' },
  population: 100,
  facilities: [{ recipeId: 'grow_food', maxRatePerDay: 50 }],
  initialStock: { water: 1e6, oxygen: 1e5, food: 1e6, fuel: 50_000 },
  treasury: 10_000_000,
});

const company = (siteId: string, classId = 'ntr-freighter'): CompanyDef => ({
  id: 't',
  name: 'T',
  color: '#fff',
  personalityId: 'contract',
  cash: 1e9,
  ships: [{ classId, siteId, name: 'X' }],
});

const scenario = (settlements: SettlementDef[], companies: CompanyDef[] = []): ScenarioConfig => ({
  ...DEFAULT_SCENARIO,
  settlements,
  companies,
});

type World = ReturnType<typeof createWorld>;
/** The ledger must account for every change in the money supply. */
const expectConserved = (w: World, supply0: number) =>
  expect(moneySupply(w) - supply0).toBeCloseTo(ledgerTotal(w.ledger), 0);

describe('money flows', () => {
  it('docking fees and ship upkeep are paid to the port', () => {
    const w = createWorld(scenario([earth, colony(), farm], [company('farm')]), eph);
    const supply0 = moneySupply(w);
    const ship = [...w.ships.values()][0]!;
    const port = w.settlements.get('farm')!;
    const before = port.treasury;
    w.advanceTo(START_JD + 10);
    const upkeep = w.shipClassOf(ship).upkeepPerDay * 10;
    const stipend = w.ledger.stipend; // both colonies' stipends
    expect(port.treasury - before).toBeGreaterThan(upkeep * 0.99);
    expect(stipend).toBeGreaterThan(0);
    expectConserved(w, supply0);

    expect(w.issue('t', [{ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'col' }])).toEqual([
      true,
    ]);
    const col = w.settlements.get('col')!;
    w.advanceTo(ship.plan!.arriveJd + 0.5);
    const arrived = w.events.recent(50, (e) => e.type === 'ShipArrived');
    expect(arrived.length).toBeGreaterThan(0);
    // Fees and the upkeep accrued since docking both landed in the colony's treasury.
    expect(col.treasury).toBeGreaterThan(0);
    expectConserved(w, supply0);
  });

  it('the Earth charter pays a bounty to the colony whose goods are sold to Earth', () => {
    const w = createWorld(scenario([earth, farm], [company('farm', 'torch-courier')]), eph);
    const supply0 = moneySupply(w);
    const ship = [...w.ships.values()][0]!;
    expect(
      w.issue('t', [
        { type: 'BuyCargo', shipId: ship.id, good: 'food', qty: 100, maxPrice: 1e9 },
        { type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'earth-exchange' },
      ]),
    ).toEqual([true, true]);
    expect(ship.cargoOrigin?.food).toBe('farm');
    w.advanceTo(ship.plan!.arriveJd + 0.5);
    const seller = w.settlements.get('farm')!;
    const before = seller.treasury;
    const charter = w.ledger.charter;
    expect(
      w.issue('t', [{ type: 'SellCargo', shipId: ship.id, good: 'food', qty: 100, minPrice: 0 }]),
    ).toEqual([true]);
    const bounty = w.goods.get('food')!.basePrice * 100 * C.markets.earthExportBounty;
    expect(seller.treasury - before).toBeCloseTo(bounty, 3);
    expect(w.ledger.charter - charter).toBeCloseTo(bounty, 3);
    expect(ship.cargoOrigin?.food).toBeUndefined();
    expectConserved(w, supply0);
  });

  it("Earth's price falls as traders sell to it and recovers over time", () => {
    const w = createWorld(DEFAULT_SCENARIO, eph);
    const e = w.settlements.get('earth-exchange')!.market.steel;
    const base = e.price;
    e.netSoldT = C.markets.deepMarketDepthT;
    w.advanceTo(START_JD + 0.25);
    // Trades see the drop at once; the posted price follows with inertia (#15).
    const earthS = w.settlements.get('earth-exchange')!;
    expect(quoteSell(w, earthS, 'steel', 1, Infinity)).toBeLessThan(base * 0.6);
    expect(e.price).toBeGreaterThan(base * 0.9);
    w.advanceTo(START_JD + 20);
    expect(e.price).toBeLessThan(base * 0.75);
    expect(e.price).toBeGreaterThanOrEqual(base * C.markets.deepPriceClampMin - 1e-9);
    w.advanceTo(START_JD + 365);
    expect(e.price).toBeGreaterThan(base * 0.95);
    expect(deepPriceFor(100, -1e9, C.markets)).toBe(100 * C.markets.deepPriceClampMax);
  });

  it('a ship purchase pays the yard its share; the rest leaves the economy', () => {
    const w = createWorld(scenario([earth, colony({ isShipyard: true })], [company('col')]), eph);
    const supply0 = moneySupply(w);
    const yard = w.settlements.get('col')!;
    const before = yard.treasury;
    const cls = w.shipClasses.get('chem-tug')!;
    expect(
      w.issue('t', [{ type: 'PurchaseShip', classId: cls.id, shipyardSiteId: 'col' }]),
    ).toEqual([true]);
    expect(yard.treasury - before).toBeCloseTo(cls.price * C.ships.shipyardShare, 3);
    expect(w.ledger.shipyard).toBeCloseTo(-cls.price * (1 - C.ships.shipyardShare), 3);
    expectConserved(w, supply0);
  });
});

describe('sell orders', () => {
  it('a producer with surplus offers it once, reserving the goods', () => {
    const w = createWorld(scenario([earth, colony(), farm]), eph);
    const stock0 = w.settlements.get('farm')!.market.food.stock;
    w.advanceTo(START_JD + 3);
    const offers = [...w.contracts.values()].filter((c) => c.kind === 'export');
    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    expect(offer.settlementId).toBe('farm');
    expect(offer.qty).toBeLessThanOrEqual(C.contracts.maxContractQtyT);
    expect(offer.escrowCost).toBeGreaterThan(0);
    // Reserving the offer outweighs three days of output.
    expect(w.settlements.get('farm')!.market.food.stock).toBeLessThan(stock0);
    // The seller owes nothing, so nothing is committed.
    expect(w.settlements.get('farm')!.committed).toBe(0);
  });

  it('loading pays the seller and hands the goods to the carrier', () => {
    const w = createWorld(scenario([earth, colony(), farm], [company('farm')]), eph);
    const supply0 = moneySupply(w);
    w.advanceTo(START_JD + 1);
    const offer = [...w.contracts.values()].find((c) => c.kind === 'export')!;
    const ship = [...w.ships.values()][0]!;
    const seller = w.settlements.get('farm')!;
    const co = w.companies.get('t')!;
    const before = { seller: seller.treasury, cash: co.cash };
    expect(
      w.issue('t', [
        { type: 'AcceptContract', contractId: offer.id, shipId: ship.id },
        { type: 'LoadContractCargo', contractId: offer.id },
      ]),
    ).toEqual([true, true]);
    expect(offer.status).toBe('completed');
    expect(ship.contractId).toBeNull();
    expect(ship.cargo.food).toBe(offer.qty);
    expect(seller.treasury - before.seller).toBeCloseTo(offer.escrowCost, 3);
    expect(before.cash - co.cash).toBeCloseTo(offer.escrowCost, 3);
    expect(w.events.recent(5).some((e) => e.type === 'SellOrderFilled')).toBe(true);
    expectConserved(w, supply0);
  });

  it('expiry returns the goods; an accepted order fines the carrier to the seller', () => {
    const w = createWorld(scenario([earth, colony(), farm], [company('farm')]), eph);
    w.advanceTo(START_JD + 1);
    const offer = [...w.contracts.values()].find((c) => c.kind === 'export')!;
    const ship = [...w.ships.values()][0]!;
    const seller = w.settlements.get('farm')!;
    const stock = seller.market.food.stock;
    const cash = seller.treasury;
    w.issue('t', [{ type: 'AcceptContract', contractId: offer.id, shipId: ship.id }]);
    expireContract(w, offer.id);
    expect(offer.status).toBe('expired');
    expect(seller.market.food.stock).toBeCloseTo(stock + offer.qty, 6);
    expect(seller.treasury - cash).toBeCloseTo(offer.escrowCost * C.contracts.penaltyFraction, 3);
    expect(ship.contractId).toBeNull();
  });
});
