import { createHash } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import { arch, cpus, platform } from 'node:os';
import { DEFAULT_CATALOG } from '../src/sim/data/catalog.ts';
import { Ephemeris } from '../src/sim/world/ephemeris.ts';
import { withFleetSize } from '../src/sim/logistics/data/benchmark.ts';
import { DEFAULT_SCENARIO } from '../src/sim/logistics/data/scenario.ts';
import { createWorld, restoreWorld, snapshotWorld } from '../src/sim/logistics/createWorld.ts';

const cases = {
  early: { scenario: DEFAULT_SCENARIO, warmupDays: 0, sampleDays: 365 },
  mature: { scenario: DEFAULT_SCENARIO, warmupDays: 19 * 365, sampleDays: 365 },
  fleet: { scenario: withFleetSize(DEFAULT_SCENARIO, 300), warmupDays: 0, sampleDays: 30 },
};
const phases = new Map([
  ['runPopulation', 'population'],
  ['runProduction', 'production'],
  ['runInvestment', 'investment'],
  ['updateMarket', 'markets'],
  ['generateContracts', 'contracts'],
  ['runShips', 'ships'],
  ['runCompanies', 'companies'],
  ['sampleDaily', 'stats'],
  ['dispatchAction', 'scheduled actions'],
]);
const cpuMicros = ({ user, system } = process.threadCpuUsage()) => user + system;
const fingerprint = (world) =>
  createHash('sha256')
    .update(JSON.stringify(snapshotWorld(world)))
    .digest('hex');

function phaseSamples(profile) {
  const parents = new Map();
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  for (const node of nodes.values()) {
    for (const id of node.children ?? []) parents.set(id, node.id);
  }
  const counts = new Map();
  for (const id of profile.samples ?? []) {
    let phase = 'other';
    for (let frame = nodes.get(id); frame; frame = nodes.get(parents.get(frame.id))) {
      const { functionName, url } = frame.callFrame;
      if (functionName === '(idle)') {
        phase = 'idle';
      } else if (functionName === '(garbage collector)') {
        phase = 'GC';
      } else if (url.endsWith('/controllers/runner.ts')) {
        phase = 'controllers';
      } else if (url.includes('/sim/logistics/')) {
        phase = phases.get(functionName) ?? phase;
      }
    }
    if (phase !== 'idle') counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts]
    .toSorted((a, b) => b[1] - a[1])
    .map(([phase, count]) => `${phase} ${((100 * count) / total).toFixed(1)}%`)
    .join(', ');
}

async function benchmark(name, { scenario, warmupDays, sampleDays }) {
  const ephemeris = new Ephemeris(DEFAULT_CATALOG);
  const world = createWorld(scenario, ephemeris, { controllers: true });
  world.advanceTo(scenario.startJd + warmupDays);
  const ships = world.ships.size;
  const snapshot = snapshotWorld(world);
  const target = world.jd + sampleDays;
  const start = cpuMicros();
  const ticks = world.advanceTo(target);
  const micros = cpuMicros() - start;
  const expected = fingerprint(world);

  const replay = restoreWorld(snapshot, new Ephemeris(DEFAULT_CATALOG));
  const session = new Session();
  session.connect();
  let profile;
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    replay.advanceTo(target);
    ({ profile } = await session.post('Profiler.stop'));
  } finally {
    session.disconnect();
  }
  if (fingerprint(replay) !== expected) throw new Error(`${name}: replay diverged`);
  console.log(
    `${name}: ${ticks} ticks, ${ships} starting ships, ${((ticks * 1e6) / micros).toFixed(0)} ticks/s CPU`,
  );
  console.log(`  CPU samples: ${phaseSamples(profile)}`);
  console.log(`  State SHA-256: ${expected}`);
}

const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(cases);
if (selected.some((name) => !Object.hasOwn(cases, name))) {
  throw new Error(`Choose one or more cases: ${Object.keys(cases).join(', ')}`);
}
console.log(
  `Node ${process.version}, ${platform()} ${arch()}, ${cpus()[0]?.model ?? 'unknown CPU'}`,
);
for (const name of selected) {
  // Running in parallel would mix profiler samples and contaminate timing.
  // eslint-disable-next-line no-await-in-loop
  await benchmark(name, cases[name]);
}
