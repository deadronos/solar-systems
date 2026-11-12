import { AU_KM } from '../../constants.ts';
import { length, vec3 } from '../../math/vec3.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { askPrice, bidPrice, maxBuyQty } from '../economy/markets.ts';
import type { GoodId, Settlement, ShipClass } from '../economy/types.ts';
import { estimateTrip, type TripEstimate } from '../navigation/planner.ts';
import type { CompanyView } from './types.ts';

/** Estimates are reused for this many days across all companies (launch windows move slowly). */
const ESTIMATE_BUCKET_DAYS = 2;
const estimateCaches = new WeakMap<LogisticsWorld, Map<string, TripEstimate | null>>();
const scratch = vec3();

/** Shared, time-bucketed trip estimate (keyed by class, route and day bucket). */
export function cachedEstimate(
  world: LogisticsWorld,
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
): TripEstimate | null {
  let cache = estimateCaches.get(world);
  if (!cache) estimateCaches.set(world, (cache = new Map()));
  const bucket = Math.floor(world.jd / ESTIMATE_BUCKET_DAYS);
  const key = `${cls.id}|${from.id}|${to.id}|${bucket}`;
  if (cache.has(key)) {
    const e = cache.get(key)!;
    // Re-anchor cached estimates that would depart in the past.
    if (e && e.departJd < world.jd) {
      const shift = world.jd - e.departJd;
      return { ...e, departJd: e.departJd + shift, arriveJd: e.arriveJd + shift };
    }
    return e;
  }
  if (cache.size > 20_000) cache.clear();
  const e = estimateTrip(cls, from, to, world.jd, world.nav);
  cache.set(key, e);
  return e;
}

export function createCompanyView(world: LogisticsWorld, companyId: string): CompanyView {
  const company = world.companies.get(companyId);
  if (!company) throw new Error(`Unknown company "${companyId}"`);
  const personality = world.personalities.get(company.personalityId);
  if (!personality) throw new Error(`Unknown personality "${company.personalityId}"`);
  const c = world.constants;
  const site = (id: string) => {
    const s = world.settlements.get(id);
    if (!s) throw new Error(`Unknown settlement "${id}"`);
    return s;
  };
  const settlementsSorted = [...world.settlements.keys()]
    .toSorted()
    .map((id) => world.settlements.get(id)!);

  return {
    jd: world.jd,
    company,
    personality,
    ships: () => company.shipIds.map((id) => world.ships.get(id)!).filter(Boolean),
    settlements: () => settlementsSorted,
    settlement: (id) => world.settlements.get(id),
    openContracts: () =>
      [...world.contracts.keys()]
        .toSorted()
        .map((id) => world.contracts.get(id)!)
        .filter((x) => x.status === 'open'),
    contract: (id) => world.contracts.get(id),
    shipClass: (id) => {
      const cls = world.shipClasses.get(id);
      if (!cls) throw new Error(`Unknown class "${id}"`);
      return cls;
    },
    shipClasses: () => [...world.shipClasses.values()],
    market: (sid, good: GoodId) => site(sid).market[good],
    ask: (sid, good) => askPrice(site(sid).market[good], c),
    bid: (sid, good, qty) => {
      const s = site(sid);
      return bidPrice(s.market[good], c, s.treasury, qty);
    },
    demandRoom: (sid, good) => {
      const s = site(sid);
      return s.isDeepMarket ? Number.POSITIVE_INFINITY : maxBuyQty(s.market[good]);
    },
    estimateTrip: (shipId, fromId, toId) => {
      const ship = world.ships.get(shipId);
      if (!ship || ship.companyId !== companyId) return null;
      return cachedEstimate(world, world.shipClassOf(ship), site(fromId), site(toId));
    },
    distanceFromSunAU: (sid) =>
      length(world.ephemeris.positionAt(site(sid).site.bodyId, world.jd, scratch)) / AU_KM,
    setIntent: (shipId, text) => {
      const ship = world.ships.get(shipId);
      if (ship && ship.companyId === companyId) ship.intent = text;
    },
  };
}
