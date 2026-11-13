import { AU_KM } from '../../constants.ts';
import { length, vec3 } from '../../math/vec3.ts';
import { fuelPricePerTonne } from '../core/commands.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { askPrice, bidPrice, maxBuyQty } from '../economy/markets.ts';
import { availableFunds } from '../economy/treasury.ts';
import type { GoodId } from '../economy/types.ts';
import type { CompanyView } from './types.ts';

const scratch = vec3();

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
      return bidPrice(s.market[good], c, availableFunds(s), qty);
    },
    demandRoom: (sid, good) => {
      const s = site(sid);
      return s.isDeepMarket ? Number.POSITIVE_INFINITY : maxBuyQty(s.market[good]);
    },
    estimateTrip: (shipId, fromId, toId) => {
      const ship = world.ships.get(shipId);
      if (!ship || ship.companyId !== companyId) return null;
      return world.nav.estimateCached(world.shipClassOf(ship), site(fromId), site(toId), world.jd);
    },
    fuelPrice: (sid, qty) => fuelPricePerTonne(world, site(sid), qty),
    distanceFromSunAU: (sid) =>
      length(world.ephemeris.positionAt(site(sid).site.bodyId, world.jd, scratch)) / AU_KM,
    setIntent: (shipId, text) => {
      const ship = world.ships.get(shipId);
      if (ship && ship.companyId === companyId) ship.intent = text;
    },
  };
}
