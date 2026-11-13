import type { LogisticsWorld } from '../core/world.ts';
import { addDemand } from './markets.ts';
import type { NeedTier, Settlement } from './types.ts';

const TIERS: NeedTier[] = ['survival', 'basic', 'comfort'];
/** Spread housing-material demand over this many days so prices signal the need. */
const HOUSING_DEMAND_DAYS = 60;

/**
 * Consume needs, update satisfaction, grow or shrink population (no deaths: people leave),
 * expand housing, collect the Earth charter stipend.
 */
export function runPopulation(s: Settlement, world: LogisticsWorld, dtDays: number): void {
  if (s.isDeepMarket) return;
  const c = world.constants;
  const pop = s.population;
  s.treasury += c.stipendPerCapitaPerDay * pop * dtDays;
  if (pop <= 0) return;

  const k = Math.min(1, dtDays / c.satisfactionEmaDays);
  for (const tier of TIERS) {
    const needs = c.needsPerCapitaPerDay[tier];
    let fracMin = 1;
    let fracSum = 0;
    let n = 0;
    for (const [good, perCapita] of Object.entries(needs) as [
      keyof Settlement['market'],
      number,
    ][]) {
      const required = pop * perCapita * dtDays;
      if (required <= 0) continue;
      const e = s.market[good];
      const used = Math.min(e.stock, required);
      e.stock -= used;
      addDemand(s, good, required);
      const f = used / required;
      fracMin = Math.min(fracMin, f);
      fracSum += f;
      n++;
    }
    const fulfilled = tier === 'survival' ? fracMin : n > 0 ? fracSum / n : 1;
    s.satisfaction[tier] += (fulfilled - s.satisfaction[tier]) * k;
  }

  // Growth / emigration (per year → per tick).
  const { survival, basic, comfort } = s.satisfaction;
  let rate: number;
  if (survival < c.emigrationThreshold) {
    rate = (-c.maxEmigrationPerYear * (c.emigrationThreshold - survival)) / c.emigrationThreshold;
  } else {
    rate = c.maxGrowthPerYear * (0.25 + 0.4 * basic + 0.35 * comfort);
  }
  let next = pop * (1 + (rate * dtDays) / 365.25);
  next = Math.min(Math.max(next, 0), Math.max(s.housingCapacity, 0));
  s.population = next;

  const milestone = Math.floor(next / 10_000);
  if (milestone > s.lastMilestone) {
    world.events.append(world.jd, {
      type: 'PopulationMilestone',
      settlementId: s.id,
      population: milestone * 10_000,
    });
  }
  s.lastMilestone = milestone;

  const short = survival < c.emigrationThreshold;
  if (short !== s.inShortage) {
    s.inShortage = short;
    world.events.append(world.jd, {
      type: short ? 'Shortage' : 'ShortageResolved',
      settlementId: s.id,
      tier: 'survival',
    });
  }

  // Housing expansion.
  const hb = c.housingBatch;
  if (s.housingCapacity > 0 && next / s.housingCapacity > hb.occupancyTrigger) {
    for (const i of hb.inputs) addDemand(s, i.good, (i.qty * dtDays) / HOUSING_DEMAND_DAYS);
    if (hb.inputs.every((i) => s.market[i.good].stock >= i.qty)) {
      for (const i of hb.inputs) s.market[i.good].stock -= i.qty;
      s.housingCapacity *= 1 + hb.capacityGainFraction;
      // New districts come with matching life support (farms, recyclers, ice plants).
      for (const f of s.facilities) {
        const r = world.recipes.get(f.recipeId);
        if (r?.outputs.some((o) => world.goods.get(o.good)?.category === 'survival')) {
          f.maxRatePerDay *= 1 + hb.capacityGainFraction;
        }
      }
      world.events.append(world.jd, {
        type: 'HousingExpanded',
        settlementId: s.id,
        capacity: Math.round(s.housingCapacity),
      });
    }
  }
}
