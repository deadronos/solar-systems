import type { Ephemeris } from '../world/ephemeris.ts';
import { runShips } from './core/commands.ts';
import { LogisticsWorld, sortedIds } from './core/world.ts';
import { generateContracts } from './economy/contracts.ts';
import { initMarketRates, updateMarket } from './economy/markets.ts';
import { runPopulation } from './economy/population.ts';
import { runProduction } from './economy/production.ts';
import type { ScenarioConfig } from './economy/types.ts';

/**
 * Build a world and install every system in the fixed tick order:
 * production → population → markets (later: contracts, companies, controllers).
 */
export function createWorld(config: ScenarioConfig, ephemeris: Ephemeris): LogisticsWorld {
  const world = new LogisticsWorld(config, ephemeris);
  const settlementIds = () => sortedIds(world.settlements);
  for (const id of settlementIds()) initMarketRates(world.settlements.get(id)!, world);
  world.addPhase('production', (w, dt) => {
    for (const id of settlementIds()) runProduction(w.settlements.get(id)!, w, dt);
  });
  world.addPhase('population', (w, dt) => {
    for (const id of settlementIds()) runPopulation(w.settlements.get(id)!, w, dt);
  });
  world.addPhase('markets', (w, dt) => {
    for (const id of settlementIds()) updateMarket(w.settlements.get(id)!, w, dt);
  });
  world.addPhase('contracts', (w) => generateContracts(w));
  world.addPhase('ships', (w, dt) => runShips(w, dt, sortedIds(w.ships)));
  return world;
}
