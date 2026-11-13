import { addDemand, askPrice, bidPrice, maxBuyQty, recordDeepTrade } from '../economy/markets.ts';
import { buyShip, companyPays, creditSettlement, external } from '../economy/money.ts';
import type { Company, Contract, GoodId, Settlement, Ship } from '../economy/types.ts';
import { planTrip } from '../navigation/planner.ts';
import { availableFunds, release } from '../economy/treasury.ts';
import type { LogisticsWorld } from './world.ts';

/** Everything a controller (AI or player) can ask the world to do. */
export type Command =
  | { type: 'SetIntent'; shipId: string; text: string }
  | { type: 'PlanAndDispatch'; shipId: string; toSiteId: string }
  | { type: 'BuyCargo'; shipId: string; good: GoodId; qty: number; maxPrice: number }
  | { type: 'SellCargo'; shipId: string; good: GoodId; qty: number; minPrice: number }
  | { type: 'AcceptContract'; contractId: string; shipId: string }
  | { type: 'LoadContractCargo'; contractId: string }
  | { type: 'DeliverContract'; contractId: string }
  | { type: 'AbandonContract'; contractId: string }
  | { type: 'PurchaseShip'; classId: string; shipyardSiteId: string }
  | { type: 'SellShip'; shipId: string };

/**
 * Effective fuel price for `qty` tonnes at a site: the local ask while the depot has stock,
 * otherwise emergency supply at a steep premium (keeps ships from being stranded).
 */
export function fuelPricePerTonne(world: LogisticsWorld, site: Settlement, qty: number): number {
  const e = site.market.fuel;
  if (site.isDeepMarket || e.stock >= qty) return askPrice(e, world.constants.markets);
  return (world.goods.get('fuel')?.basePrice ?? 0) * world.constants.ships.emergencyFuelFactor;
}

class Rejection extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const reject = (reason: string): never => {
  throw new Rejection(reason);
};

export const cargoMass = (ship: Pick<Ship, 'cargo'>): number =>
  Object.values(ship.cargo).reduce((a, b) => a + (b ?? 0), 0);

function getShip(world: LogisticsWorld, companyId: string, shipId: string): Ship {
  const ship = world.ships.get(shipId) ?? reject('unknown-ship');
  if (ship.companyId !== companyId) reject('not-owner');
  return ship;
}

function dockedAt(world: LogisticsWorld, ship: Ship): Settlement {
  if (ship.state !== 'docked' || !ship.siteId) reject('not-docked');
  return world.settlements.get(ship.siteId!) ?? reject('unknown-site');
}

function getContract(world: LogisticsWorld, companyId: string, id: string): Contract {
  const c = world.contracts.get(id) ?? reject('unknown-contract');
  if (c.companyId !== companyId) reject('not-owner');
  return c;
}

/** Pay `amount` to settlement `to`, if cash allows. */
function spend(
  world: LogisticsWorld,
  company: Company,
  ship: Ship | null,
  amount: number,
  to: Settlement,
): void {
  if (company.cash < amount) reject('insufficient-cash');
  companyPays(world, company, ship, to, amount);
}

/** Share of a contract's value charged as a penalty when a carrier fails it. */
export const penaltyFor = (world: LogisticsWorld, c: Contract): number =>
  (c.kind === 'export' ? c.escrowCost : c.reward) * world.constants.contracts.penaltyFraction;

function setOrigin(ship: Ship, good: GoodId, site: Settlement): void {
  if (site.isDeepMarket) {
    if (ship.cargoOrigin) delete ship.cargoOrigin[good];
  } else {
    (ship.cargoOrigin ??= {})[good] = site.id;
  }
}

/** Take `qty` of a good out of a ship's hold. */
function unload(ship: Ship, good: GoodId, qty: number): void {
  const left = (ship.cargo[good] ?? 0) - qty;
  if (left > 1e-9) {
    ship.cargo[good] = left;
  } else {
    delete ship.cargo[good];
    if (ship.cargoOrigin) delete ship.cargoOrigin[good];
  }
}

function earn(company: Company, ship: Ship | null, amount: number): void {
  company.cash += amount;
  company.stats.revenue += amount;
  if (ship) ship.stats.revenue += amount;
}

/** Remove a ship from the world and its company. */
export function removeShip(world: LogisticsWorld, ship: Ship): void {
  world.ships.delete(ship.id);
  const company = world.companies.get(ship.companyId);
  if (company) company.shipIds = company.shipIds.filter((id) => id !== ship.id);
  world.events.append(world.jd, {
    type: 'ShipRemoved',
    shipId: ship.id,
    companyId: ship.companyId,
  });
}

export function arrive(world: LogisticsWorld, shipId: string): void {
  const ship = world.ships.get(shipId);
  if (!ship || !ship.plan) return;
  const dest = ship.plan.toSiteId;
  ship.state = 'docked';
  ship.siteId = dest;
  ship.plan = null;
  ship.stats.trips++;
  const company = world.companies.get(ship.companyId);
  const port = world.settlements.get(dest);
  // The docking fee is port income.
  if (company && port) companyPays(world, company, ship, port, world.constants.ships.dockingFee);
  world.events.append(world.jd, {
    type: 'ShipArrived',
    shipId,
    companyId: ship.companyId,
    settlementId: dest,
  });
  if (ship.pendingRemoval) {
    removeShip(world, ship);
    return;
  }
  if (!ship.contractId && cargoMass(ship) === 0) {
    ship.intent = 'Idle';
    world.events.append(world.jd, {
      type: 'ShipIdle',
      shipId,
      companyId: ship.companyId,
      settlementId: dest,
    });
  }
}

export function deliverShip(world: LogisticsWorld, shipId: string, siteId: string): void {
  const ship = world.ships.get(shipId);
  if (!ship || ship.state !== 'building') return;
  ship.state = 'docked';
  ship.intent = 'Idle';
  const ids = { shipId, companyId: ship.companyId, settlementId: siteId };
  world.events.append(world.jd, { type: 'ShipDelivered', ...ids });
  world.events.append(world.jd, { type: 'ShipIdle', ...ids });
}

export function depart(world: LogisticsWorld, shipId: string): void {
  const ship = world.ships.get(shipId);
  if (!ship || !ship.plan || ship.state !== 'waiting') return;
  const from = ship.siteId ?? undefined;
  ship.state = 'in_transit';
  ship.siteId = null;
  world.events.append(world.jd, {
    type: 'ShipDeparted',
    shipId,
    companyId: ship.companyId,
    ...(from ? { fromSiteId: from } : {}),
    toSiteId: ship.plan.toSiteId,
    arriveJd: ship.plan.arriveJd,
  });
}

function apply(world: LogisticsWorld, companyId: string, cmd: Command): void {
  const company = world.companies.get(companyId) ?? reject('unknown-company');
  if (company.status === 'bankrupt') reject('company-bankrupt');
  const c = world.constants;

  switch (cmd.type) {
    case 'SetIntent': {
      const ship = getShip(world, companyId, cmd.shipId);
      if (typeof cmd.text !== 'string') reject('invalid-intent');
      if (ship.intent === cmd.text) return;
      ship.intent = cmd.text;
      world.events.append(world.jd, {
        type: 'ShipIntentChanged',
        shipId: ship.id,
        companyId,
        text: cmd.text,
      });
      return;
    }
    case 'PlanAndDispatch': {
      const ship = getShip(world, companyId, cmd.shipId);
      const from = dockedAt(world, ship);
      if (ship.pendingRemoval) reject('ship-retiring');
      const to = world.settlements.get(cmd.toSiteId) ?? reject('unknown-site');
      if (to.id === from.id) reject('same-site');
      const plan =
        planTrip(world.shipClassOf(ship), from, to, world.jd, world.nav) ?? reject('no-route');
      let cost = plan.exoticCost;
      if (plan.exoticCost > 0 && !from.isShipyard) reject('no-exotic-fuel');
      const fuel = from.market.fuel;
      const fuelPrice = fuelPricePerTonne(world, from, plan.fuelT);
      const emergency = plan.fuelT > 0 && !from.isDeepMarket && fuel.stock < plan.fuelT;
      cost += plan.fuelT * fuelPrice;
      // Fuel (emergency supply included) and exotic propellant are bought from the port.
      spend(world, company, ship, cost, from);
      if (plan.fuelT > 0) {
        // Ship refuelling is local demand, so depots order more fuel.
        addDemand(from, 'fuel', plan.fuelT);
        recordDeepTrade(from, 'fuel', -plan.fuelT);
        if (!from.isDeepMarket && !emergency) fuel.stock -= plan.fuelT;
        world.events.append(world.jd, {
          type: 'FuelPurchased',
          shipId: ship.id,
          companyId,
          settlementId: from.id,
          qty: plan.fuelT,
          cost,
          ...(emergency ? { emergency: true } : {}),
        });
      }
      ship.plan = plan;
      ship.state = 'waiting';
      if (plan.departJd <= world.jd) depart(world, ship.id);
      else world.schedule(plan.departJd, { kind: 'depart', shipId: ship.id });
      world.schedule(plan.arriveJd, { kind: 'arrive', shipId: ship.id });
      return;
    }
    case 'BuyCargo': {
      const ship = getShip(world, companyId, cmd.shipId);
      const site = dockedAt(world, ship);
      if (!(cmd.qty > 0)) reject('bad-quantity');
      if (cargoMass(ship) + cmd.qty > world.shipClassOf(ship).cargoT + 1e-9) reject('cargo-full');
      const e = site.market[cmd.good];
      if (e.stock < cmd.qty) reject('insufficient-stock');
      const price = askPrice(e, c.markets);
      if (price > cmd.maxPrice) reject('price-above-limit');
      spend(world, company, ship, price * cmd.qty, site);
      if (!site.isDeepMarket) e.stock -= cmd.qty;
      recordDeepTrade(site, cmd.good, -cmd.qty);
      ship.cargo[cmd.good] = (ship.cargo[cmd.good] ?? 0) + cmd.qty;
      setOrigin(ship, cmd.good, site);
      world.events.append(world.jd, {
        type: 'CargoBought',
        shipId: ship.id,
        companyId,
        settlementId: site.id,
        good: cmd.good,
        qty: cmd.qty,
        price,
      });
      return;
    }
    case 'SellCargo': {
      const ship = getShip(world, companyId, cmd.shipId);
      const site = dockedAt(world, ship);
      if (!(cmd.qty > 0)) reject('bad-quantity');
      if ((ship.cargo[cmd.good] ?? 0) < cmd.qty - 1e-9) reject('not-in-cargo');
      const e = site.market[cmd.good];
      if (!site.isDeepMarket && cmd.qty > maxBuyQty(e, c.markets) + 1e-9)
        reject('market-saturated');
      const price = bidPrice(e, c.markets, availableFunds(site), cmd.qty);
      if (price <= 0) reject('no-demand');
      if (price < cmd.minPrice) reject('price-below-limit');
      if (!site.isDeepMarket) e.stock += cmd.qty;
      creditSettlement(world, site, -price * cmd.qty);
      recordDeepTrade(site, cmd.good, cmd.qty);
      const origin = ship.cargoOrigin?.[cmd.good];
      unload(ship, cmd.good, cmd.qty);
      earn(company, ship, price * cmd.qty);
      // The Earth charter rewards the colony that produced goods exported to Earth.
      const exporter = site.isDeepMarket && origin ? world.settlements.get(origin) : undefined;
      const bounty =
        (world.goods.get(cmd.good)?.basePrice ?? 0) * cmd.qty * c.markets.earthExportBounty;
      if (exporter && !exporter.isDeepMarket && bounty > 0) {
        external(world, 'charter', bounty);
        creditSettlement(world, exporter, bounty);
      }
      company.stats.tradesCompleted++;
      world.events.append(world.jd, {
        type: 'CargoSold',
        shipId: ship.id,
        companyId,
        settlementId: site.id,
        good: cmd.good,
        qty: cmd.qty,
        price,
      });
      return;
    }
    case 'AcceptContract': {
      const contract = world.contracts.get(cmd.contractId) ?? reject('unknown-contract');
      if (contract.status !== 'open') reject('contract-not-open');
      const ship = getShip(world, companyId, cmd.shipId);
      if (ship.contractId) reject('ship-has-contract');
      if (ship.state === 'building' || ship.pendingRemoval) reject('ship-unavailable');
      contract.status = 'accepted';
      const buyer = world.settlements.get(contract.settlementId);
      if (buyer) delete buyer.orderEscalation[contract.good];
      contract.companyId = companyId;
      contract.shipId = ship.id;
      ship.contractId = contract.id;
      world.events.append(world.jd, {
        type: 'ContractAccepted',
        contractId: contract.id,
        companyId,
        shipId: ship.id,
        settlementId: contract.settlementId,
      });
      return;
    }
    case 'LoadContractCargo': {
      const contract = getContract(world, companyId, cmd.contractId);
      if (contract.kind === 'delivery' || contract.status !== 'accepted') reject('not-loadable');
      const ship = getShip(world, companyId, contract.shipId ?? '');
      const site = dockedAt(world, ship);
      if (site.id !== contract.pickupSettlementId) reject('wrong-site');
      if (cargoMass(ship) + contract.qty > world.shipClassOf(ship).cargoT + 1e-9)
        reject('cargo-full');
      if (contract.kind === 'export') {
        // A sell order: the carrier buys the reserved goods, and they become its cargo.
        spend(world, company, ship, contract.escrowCost, site);
        ship.cargo[contract.good] = (ship.cargo[contract.good] ?? 0) + contract.qty;
        setOrigin(ship, contract.good, site);
        contract.status = 'completed';
        ship.contractId = null;
        company.stats.contractsCompleted++;
        world.events.append(world.jd, {
          type: 'SellOrderFilled',
          contractId: contract.id,
          companyId,
          shipId: ship.id,
          settlementId: site.id,
          good: contract.good,
          qty: contract.qty,
          price: contract.escrowCost / contract.qty,
        });
        return;
      }
      ship.cargo[contract.good] = (ship.cargo[contract.good] ?? 0) + contract.qty;
      contract.status = 'loaded';
      recordDeepTrade(site, contract.good, -contract.qty);
      // The buyer pays the pickup for the escrowed goods once they are aboard.
      const buyer = world.settlements.get(contract.settlementId);
      if (buyer) {
        creditSettlement(world, buyer, -contract.escrowCost);
        release(buyer, contract.escrowCost);
      }
      creditSettlement(world, site, contract.escrowCost);
      return;
    }
    case 'DeliverContract': {
      const contract = getContract(world, companyId, cmd.contractId);
      if (contract.kind === 'export') reject('not-deliverable');
      if (contract.status !== 'accepted' && contract.status !== 'loaded') reject('not-deliverable');
      // Freight must be the escrowed goods themselves, i.e. loaded at the pickup.
      if (contract.kind === 'freight' && contract.status !== 'loaded') reject('not-loaded');
      const ship = getShip(world, companyId, contract.shipId ?? '');
      const site = dockedAt(world, ship);
      if (site.id !== contract.settlementId) reject('wrong-site');
      if ((ship.cargo[contract.good] ?? 0) < contract.qty - 1e-9) reject('not-in-cargo');
      unload(ship, contract.good, contract.qty);
      site.market[contract.good].stock += contract.qty;
      creditSettlement(world, site, -contract.reward);
      release(site, contract.reward);
      earn(company, ship, contract.reward);
      company.stats.contractsCompleted++;
      contract.status = 'completed';
      ship.contractId = null;
      world.events.append(world.jd, {
        type: 'ContractCompleted',
        contractId: contract.id,
        companyId,
        shipId: ship.id,
        settlementId: site.id,
        good: contract.good,
        qty: contract.qty,
        reward: contract.reward,
      });
      return;
    }
    case 'AbandonContract': {
      const contract = getContract(world, companyId, cmd.contractId);
      if (contract.status === 'loaded') reject('cargo-loaded');
      if (contract.status !== 'accepted') reject('not-accepted');
      // The penalty compensates the settlement that posted the order.
      const penalty = penaltyFor(world, contract);
      const poster = world.settlements.get(contract.settlementId);
      const ship = contract.shipId ? world.ships.get(contract.shipId) : undefined;
      if (poster) companyPays(world, company, null, poster, penalty);
      if (ship) ship.contractId = null;
      world.events.append(world.jd, {
        type: 'ContractAbandoned',
        contractId: contract.id,
        companyId,
        shipId: contract.shipId ?? '',
        settlementId: contract.settlementId,
        penalty,
      });
      contract.status = 'open';
      contract.companyId = null;
      contract.shipId = null;
      return;
    }
    case 'PurchaseShip': {
      const cls = world.shipClasses.get(cmd.classId) ?? reject('unknown-class');
      const yard = world.settlements.get(cmd.shipyardSiteId) ?? reject('unknown-site');
      if (!yard.isShipyard) reject('not-a-shipyard');
      if (company.cash < cls.price) reject('insufficient-cash');
      buyShip(world, company, yard, cls.price);
      const n = company.shipIds.length + 1;
      const ship = world.addShip(
        company,
        cls.id,
        yard.id,
        `${company.name.split(' ')[0]} ${cls.name.split(' ').at(-1)} ${n}`,
        'building',
      );
      world.events.append(world.jd, {
        type: 'ShipOrdered',
        shipId: ship.id,
        companyId,
        settlementId: yard.id,
        classId: cls.id,
        price: cls.price,
      });
      world.schedule(world.jd + cls.buildDays, {
        kind: 'deliverShip',
        shipId: ship.id,
        siteId: yard.id,
      });
      return;
    }
    case 'SellShip': {
      const ship = getShip(world, companyId, cmd.shipId);
      const site = dockedAt(world, ship);
      if (cargoMass(ship) > 0) reject('ship-has-cargo');
      if (ship.contractId) reject('ship-has-contract');
      const value = world.shipClassOf(ship).price * c.ships.resaleFraction;
      earn(company, null, value);
      external(world, 'shipyard', value);
      world.events.append(world.jd, {
        type: 'ShipSold',
        shipId: ship.id,
        companyId,
        settlementId: site.id,
        value,
      });
      removeShip(world, ship);
      return;
    }
  }
}

/** The ship a command acts on (directly, or through the contract it names), if any. */
export function commandShipId(world: LogisticsWorld, cmd: Command): string | undefined {
  if ('shipId' in cmd) return cmd.shipId;
  if ('contractId' in cmd) return world.contracts.get(cmd.contractId)?.shipId ?? undefined;
  return undefined;
}

function rejected(
  world: LogisticsWorld,
  companyId: string,
  cmd: Command,
  reason: string,
  shipId: string | undefined,
): false {
  world.events.append(world.jd, {
    type: 'CommandRejected',
    companyId,
    command: cmd.type,
    reason,
    ...(shipId ? { shipId } : {}),
  });
  return false;
}

/** Validate and apply one command. Emits CommandRejected and returns false on failure. */
export function applyCommand(world: LogisticsWorld, companyId: string, cmd: Command): boolean {
  try {
    apply(world, companyId, cmd);
    return true;
  } catch (err) {
    if (!(err instanceof Rejection)) throw err;
    return rejected(world, companyId, cmd, err.reason, 'shipId' in cmd ? cmd.shipId : undefined);
  }
}

/**
 * Apply a controller's commands in order. A ship's commands form a plan (buy, then
 * dispatch): once one is rejected, that ship's later commands in the batch are skipped
 * (rejected as `earlier-step-failed`) so it never departs on a broken plan. Commands for
 * other ships are unaffected. Returns per-command success.
 */
export function applyCommands(
  world: LogisticsWorld,
  companyId: string,
  cmds: Command[],
): boolean[] {
  const failedShips = new Set<string>();
  return cmds.map((cmd) => {
    const shipId = commandShipId(world, cmd);
    if (shipId && failedShips.has(shipId)) {
      return rejected(world, companyId, cmd, 'earlier-step-failed', shipId);
    }
    const ok = applyCommand(world, companyId, cmd);
    if (!ok && shipId) failedShips.add(shipId);
    return ok;
  });
}

/** Per-tick ship running costs and utilisation accounting. */
export function runShips(world: LogisticsWorld, dtDays: number, shipIds: readonly string[]): void {
  for (const id of shipIds) {
    const ship = world.ships.get(id);
    if (!ship || ship.state === 'building') continue;
    const company = world.companies.get(ship.companyId);
    if (!company) continue;
    // Upkeep is crew wages and services, paid where the ship is or last docked.
    const port = world.settlements.get(ship.siteId ?? ship.plan?.fromSiteId ?? '');
    const upkeep = world.shipClassOf(ship).upkeepPerDay * dtDays;
    if (port) {
      companyPays(world, company, ship, port, upkeep);
    } else {
      throw new Error(`Ship "${ship.id}" has no port for upkeep`);
    }
    if (ship.state !== 'docked' || ship.contractId || cargoMass(ship) > 0) ship.busyDays += dtDays;
  }
}
