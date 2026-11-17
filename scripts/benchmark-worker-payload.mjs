import { serialize } from 'node:v8';
import { DEFAULT_CATALOG } from '../src/sim/data/catalog.ts';
import { Ephemeris } from '../src/sim/world/ephemeris.ts';
import { withFleetSize } from '../src/sim/logistics/data/benchmark.ts';
import { DEFAULT_SCENARIO } from '../src/sim/logistics/data/scenario.ts';
import { createWorld } from '../src/sim/logistics/createWorld.ts';
import { createDeltaWriter } from '../src/sim/logistics/sync/delta.ts';

const bytes = (item) => serialize(item).byteLength;
const median = (samples) => samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
for (const [name, scenario, warmupDays] of [
  ['mature', DEFAULT_SCENARIO, 20 * 365],
  ['fleet', withFleetSize(DEFAULT_SCENARIO, 300), 30],
]) {
  const world = createWorld(scenario, new Ephemeris(DEFAULT_CATALOG), { controllers: true });
  world.advanceTo(world.jd + warmupDays);
  const write = createDeltaWriter(world);
  write();
  const samples = [];
  for (let day = 0; day < 7; day++) {
    world.advanceTo(world.jd + 1);
    const delta = write();
    const { ships, plans, settlements, companies, contracts, events, stats } = delta;
    samples.push({
      total: bytes(delta),
      'ship fields': bytes(ships),
      plans: bytes(plans),
      settlements: bytes(settlements),
      companies: bytes(companies),
      contracts: bytes(contracts),
      events: bytes(events),
      stats: bytes(stats),
    });
  }
  console.log(`${name}: ${world.ships.size} ships, median bytes across seven daily deltas`);
  console.table(
    Object.fromEntries(
      Object.keys(samples[0]).map((key) => [key, median(samples.map((sample) => sample[key]))]),
    ),
  );
}
