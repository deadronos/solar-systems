import { RESALE_FRACTION, removeShip } from '../core/commands.ts';
import { sortedIds, type LogisticsWorld } from '../core/world.ts';
import type { Company, ShipClass } from './types.ts';

const ENTRANT_NAMES = [
  'Aurora Logistics',
  'Meridian Haulage',
  'Copperline',
  'Starling Freight',
  'Tethys Cargo',
  'Ironwake Shipping',
  'Nova Transit',
  'Halcyon Lines',
  'Perihelion Bulk',
  'Lagrange & Sons',
];
const ENTRANT_COLORS = [
  '#ffd54f',
  '#4db6ac',
  '#ff8a65',
  '#9575cd',
  '#aed581',
  '#f06292',
  '#90a4ae',
  '#dce775',
];

/** Cash + resale value of ships + cargo at Earth reference prices. */
export function netWorth(world: LogisticsWorld, companyId: string): number {
  const company = world.companies.get(companyId);
  if (!company) return 0;
  let v = company.cash;
  for (const id of company.shipIds) {
    const ship = world.ships.get(id);
    if (!ship) continue;
    v += world.shipClassOf(ship).price * RESALE_FRACTION;
    for (const [g, q] of Object.entries(ship.cargo)) {
      v += (q ?? 0) * (world.goods.get(g as keyof typeof ship.cargo)?.basePrice ?? 0);
    }
  }
  return v;
}

function bankrupt(world: LogisticsWorld, company: Company): void {
  company.status = 'bankrupt';
  world.events.append(world.jd, { type: 'CompanyBankrupt', companyId: company.id });
  // Contracts: accepted ones reopen; loaded freight is lost with the carrier.
  for (const id of sortedIds(world.contracts)) {
    const c = world.contracts.get(id)!;
    if (c.companyId !== company.id) continue;
    if (c.status === 'accepted') {
      c.status = 'open';
      c.companyId = null;
      c.shipId = null;
    } else if (c.status === 'loaded') {
      // The cargo is lost with the carrier; the buyer is refunded its prepayment.
      const buyer = world.settlements.get(c.settlementId);
      if (buyer) buyer.treasury += c.escrowCost;
      c.status = 'expired';
      world.events.append(world.jd, {
        type: 'ContractExpired',
        contractId: c.id,
        settlementId: c.settlementId,
        companyId: company.id,
        penalty: 0,
      });
    }
  }
  for (const id of [...company.shipIds].toSorted()) {
    const ship = world.ships.get(id);
    if (!ship) continue;
    ship.contractId = null;
    if (ship.state === 'in_transit') {
      ship.pendingRemoval = true;
      ship.intent = 'Returning for liquidation';
    } else {
      removeShip(world, ship);
    }
  }
  world.schedule(world.jd + world.constants.entrantDelayDays, (w) => spawnEntrant(w));
}

/** A new company enters the market with seed capital and one ship at a shipyard. */
export function spawnEntrant(world: LogisticsWorld): Company {
  const rng = world.rng('entrants');
  const personalities = [...world.personalities.values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
  const personality = personalities[Math.floor(rng.next() * personalities.length)]!;
  const used = new Set([...world.companies.values()].map((c) => c.name));
  const name = ENTRANT_NAMES.find((n) => !used.has(n)) ?? `Newco ${world.companies.size + 1}`;
  const company: Company = {
    id: world.nextId('company'),
    name,
    color: ENTRANT_COLORS[world.companies.size % ENTRANT_COLORS.length]!,
    personalityId: personality.id,
    cash: world.constants.entrantSeedCash,
    shipIds: [],
    status: 'active',
    distressSinceJd: null,
    foundedJd: world.jd,
    stats: { revenue: 0, costs: 0, tradesCompleted: 0, contractsCompleted: 0 },
  };
  world.companies.set(company.id, company);
  world.events.append(world.jd, { type: 'CompanyFounded', companyId: company.id });

  const affordable = (c: ShipClass) => c.price <= company.cash * 0.5;
  const classes = [...world.shipClasses.values()].toSorted((a, b) => a.price - b.price);
  const cls =
    classes.find((c) => personality.preferredTiers.includes(c.tier) && affordable(c)) ??
    classes.find(affordable);
  const yard = sortedIds(world.settlements)
    .map((id) => world.settlements.get(id)!)
    .find((s) => s.isShipyard);
  if (cls && yard) {
    company.cash -= cls.price;
    company.stats.costs += cls.price;
    const ship = world.addShip(
      company,
      cls.id,
      yard.id,
      `${name.split(' ')[0]} ${cls.name.split(' ').at(-1)} 1`,
      'docked',
    );
    world.events.append(world.jd, {
      type: 'ShipIdle',
      shipId: ship.id,
      companyId: company.id,
      settlementId: yard.id,
    });
  }
  return company;
}

/** Distress, recovery and bankruptcy bookkeeping. */
export function runCompanies(world: LogisticsWorld): void {
  for (const id of sortedIds(world.companies)) {
    const company = world.companies.get(id)!;
    if (company.status === 'bankrupt') continue;
    if (company.cash < 0) {
      if (company.status === 'active') {
        company.status = 'distress';
        company.distressSinceJd = world.jd;
        world.events.append(world.jd, {
          type: 'CompanyInDistress',
          companyId: id,
          cash: company.cash,
        });
      } else if (
        world.jd - (company.distressSinceJd ?? world.jd) >=
        world.constants.bankruptcyGraceDays
      ) {
        bankrupt(world, company);
      }
    } else if (company.status === 'distress') {
      company.status = 'active';
      company.distressSinceJd = null;
      world.events.append(world.jd, {
        type: 'CompanyRecovered',
        companyId: id,
        cash: company.cash,
      });
    }
  }
}
