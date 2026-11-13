import { addDemand, askPrice, bidPrice, maxBuyQty } from '../economy/markets.ts';
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

function spend(world: LogisticsWorld, company: Company, ship: Ship | null, amount: number): void {
  if (company.cash < amount) reject('insufficient-cash');
  company.cash -= amount;
  company.stats.costs += amount;
  if (ship) ship.stats.costs += amount;
  void world;
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
  if (company) {
    const fee = world.constants.ships.dockingFee;
    company.cash -= fee;
    company.stats.costs += fee;
    ship.stats.costs += fee;
  }
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
      spend(world, company, ship, cost);
      if (plan.fuelT > 0) {
        // Ship refuelling is local demand, so depots order more fuel.
        addDemand(from, 'fuel', plan.fuelT);
        if (!from.isDeepMarket && !emergency) {
          fuel.stock -= plan.fuelT;
          from.treasury += plan.fuelT * fuelPrice;
        }
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
      spend(world, company, ship, price * cmd.qty);
      if (!site.isDeepMarket) {
        e.stock -= cmd.qty;
        site.treasury += price * cmd.qty;
      }
      ship.cargo[cmd.good] = (ship.cargo[cmd.good] ?? 0) + cmd.qty;
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
      if (!site.isDeepMarket) {
        e.stock += cmd.qty;
        site.treasury -= price * cmd.qty;
      }
      const left = (ship.cargo[cmd.good] ?? 0) - cmd.qty;
      if (left > 1e-9) ship.cargo[cmd.good] = left;
      else delete ship.cargo[cmd.good];
      earn(company, ship, price * cmd.qty);
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
      if (contract.kind !== 'freight' || contract.status !== 'accepted') reject('not-loadable');
      const ship = getShip(world, companyId, contract.shipId ?? '');
      const site = dockedAt(world, ship);
      if (site.id !== contract.pickupSettlementId) reject('wrong-site');
      if (cargoMass(ship) + contract.qty > world.shipClassOf(ship).cargoT + 1e-9)
        reject('cargo-full');
      ship.cargo[contract.good] = (ship.cargo[contract.good] ?? 0) + contract.qty;
      contract.status = 'loaded';
      // The buyer pays the pickup for the escrowed goods once they are aboard.
      const buyer = world.settlements.get(contract.settlementId);
      if (buyer) {
        buyer.treasury -= contract.escrowCost;
        release(buyer, contract.escrowCost);
      }
      if (!site.isDeepMarket) site.treasury += contract.escrowCost;
      return;
    }
    case 'DeliverContract': {
      const contract = getContract(world, companyId, cmd.contractId);
      if (contract.status !== 'accepted' && contract.status !== 'loaded') reject('not-deliverable');
      // Freight must be the escrowed goods themselves, i.e. loaded at the pickup.
      if (contract.kind === 'freight' && contract.status !== 'loaded') reject('not-loaded');
      const ship = getShip(world, companyId, contract.shipId ?? '');
      const site = dockedAt(world, ship);
      if (site.id !== contract.settlementId) reject('wrong-site');
      if ((ship.cargo[contract.good] ?? 0) < contract.qty - 1e-9) reject('not-in-cargo');
      const left = (ship.cargo[contract.good] ?? 0) - contract.qty;
      if (left > 1e-9) ship.cargo[contract.good] = left;
      else delete ship.cargo[contract.good];
      site.market[contract.good].stock += contract.qty;
      site.treasury -= contract.reward;
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
      const penalty = contract.reward * c.contracts.penaltyFraction;
      company.cash -= penalty;
      company.stats.costs += penalty;
      const ship = contract.shipId ? world.ships.get(contract.shipId) : undefined;
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
      spend(world, company, null, cls.price);
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
    const upkeep = world.shipClassOf(ship).upkeepPerDay * dtDays;
    company.cash -= upkeep;
    company.stats.costs += upkeep;
    ship.stats.costs += upkeep;
    if (ship.state !== 'docked' || ship.contractId || cargoMass(ship) > 0) ship.busyDays += dtDays;
  }
}
