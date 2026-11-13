import { AU_KM } from '../../constants.ts';
import { length, vec3 } from '../../math/vec3.ts';
import { fuelPricePerTonne } from '../core/commands.ts';
import { sortedIds } from '../core/sortedIds.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { askPrice, bidPrice, maxBuyQty } from '../economy/markets.ts';
import { availableFunds } from '../economy/treasury.ts';
import type { GoodId, Settlement } from '../economy/types.ts';
import type { CompanyView, DeepReadonly } from './types.ts';

const scratch = vec3();

export function createCompanyView(world: LogisticsWorld, companyId: string): CompanyView {
  const company = world.companies.get(companyId);
  if (!company) throw new Error(`Unknown company "${companyId}"`);
  const personality = world.personalities.get(company.personalityId);
  if (!personality) throw new Error(`Unknown personality "${company.personalityId}"`);
  const c = world.constants;
  const snapshots = new WeakMap<object, object>();
  // Copy only values the controller reads and reuse nested copies across view queries.
  // Plain loops: this runs for every settlement, ship and contract a controller looks at.
  const snapshot = <T>(value: T): DeepReadonly<T> => {
    if (typeof value !== 'object' || value === null) return value as DeepReadonly<T>;
    const cached = snapshots.get(value);
    if (cached) return cached as DeepReadonly<T>;
    let copy: unknown[] | Record<string, unknown>;
    if (Array.isArray(value)) {
      copy = Array.from({ length: value.length });
      for (let i = 0; i < value.length; i++) copy[i] = snapshot(value[i]);
    } else {
      copy = {};
      const src = value as Record<string, unknown>;
      for (const key of Object.keys(src)) copy[key] = snapshot(src[key]);
    }
    const frozen = Object.freeze(copy);
    snapshots.set(value, frozen);
    return frozen as DeepReadonly<T>;
  };
  const site = (id: string) => {
    const s = world.settlements.get(id);
    if (!s) throw new Error(`Unknown settlement "${id}"`);
    return s;
  };
  let settlementsSorted: Settlement[] | null = null;

  return {
    jd: world.jd,
    dockingFee: c.ships.dockingFee,
    ai: Object.freeze({ ...c.ai }),
    sourceReserveFraction: c.contracts.sourceReserveFraction,
    company: snapshot(company),
    personality: snapshot(personality),
    ships: () =>
      Object.freeze(
        company.shipIds.flatMap((id) => {
          const ship = world.ships.get(id);
          return ship ? [snapshot(ship)] : [];
        }),
      ),
    settlements: () =>
      snapshot(
        (settlementsSorted ??= sortedIds(world.settlements).map((id) =>
          world.settlements.get(id)!,
        )),
      ),
    settlement: (id) => snapshot(world.settlements.get(id)),
    openContracts: () =>
      Object.freeze(
        sortedIds(world.contracts)
          .map((id) => world.contracts.get(id)!)
          .filter((x) => x.status === 'open')
          .map(snapshot),
      ),
    contract: (id) => snapshot(world.contracts.get(id)),
    shipClass: (id) => {
      const cls = world.shipClasses.get(id);
      if (!cls) throw new Error(`Unknown class "${id}"`);
      return snapshot(cls);
    },
    shipClasses: () => Object.freeze([...world.shipClasses.values()].map(snapshot)),
    market: (sid, good: GoodId) => snapshot(site(sid).market[good]),
    ask: (sid, good) => askPrice(site(sid).market[good], c.markets),
    bid: (sid, good, qty) => {
      const s = site(sid);
      return bidPrice(s.market[good], c.markets, availableFunds(s), qty);
    },
    demandRoom: (sid, good) => {
      const s = site(sid);
      return s.isDeepMarket ? Number.POSITIVE_INFINITY : maxBuyQty(s.market[good], c.markets);
    },
    estimateTrip: (shipId, fromId, toId) => {
      const ship = world.ships.get(shipId);
      if (!ship || ship.companyId !== companyId) return null;
      return snapshot(
        world.nav.estimateCached(world.shipClassOf(ship), site(fromId), site(toId), world.jd),
      );
    },
    fuelPrice: (sid, qty) => fuelPricePerTonne(world, site(sid), qty),
    distanceFromSunAU: (sid) =>
      length(world.ephemeris.positionAt(site(sid).site.bodyId, world.jd, scratch)) / AU_KM,
  };
}
