import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { Simulation } from '../../simulation.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { createWorld } from '../createWorld.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { createEconomyServer, type EconomyPort, type FromEconomy } from './economy.ts';

/** An in-process stand-in for the worker: messages are structured-cloned and queued. */
function fakeWorker() {
  const queue: (() => void)[] = [];
  let terminated = false;
  const listeners = {
    message: [] as ((e: { data: FromEconomy }) => void)[],
    error: [] as ((e: { message?: string }) => void)[],
  };
  const port: EconomyPort & { fail(message: string): void } = {
    addEventListener: ((type: 'message' | 'error', fn: never) => {
      listeners[type].push(fn);
    }) as EconomyPort['addEventListener'],
    fail: (message) => listeners.error.forEach((fn) => fn({ message })),
    postMessage: (msg) => {
      const copy = structuredClone(msg);
      queue.push(() => !terminated && handle(copy));
    },
    terminate: () => {
      terminated = true;
    },
  };
  const handle = createEconomyServer(
    (msg) => {
      const copy = structuredClone(msg);
      queue.push(() => {
        if (!terminated) for (const fn of listeners.message) fn({ data: copy });
      });
    },
    (fn) => queue.push(fn),
  );
  const pump = () => {
    while (queue.length) queue.shift()!();
  };
  return { port, pump, isTerminated: () => terminated };
}

/** JSON view of everything the UI reads. */
function view(w: LogisticsWorld) {
  const companies = [...w.companies.keys()];
  return JSON.stringify({
    jd: w.jd,
    ships: [...w.ships.values()],
    settlements: [...w.settlements.values()],
    companies: [...w.companies.values()],
    contracts: [...w.contracts.values()],
    hash: w.events.hash(),
    recent: w.events.recent(200),
    perShip: [...w.ships.keys()].map((id) => w.events.forEntity(id, 20)),
    worth: companies.map((id) => w.stats!.series('companyNetWorth', id)),
    prices: w.stats!.series('price:food', 'mars-colony'),
    flows: [...w.stats!.flows],
    volume: w.stats!.tradeVolume365,
  });
}

describe('economy worker', () => {
  it(
    'mirrors the economy into a replica identical to running it inline',
    { timeout: 60_000 },
    () => {
      const fake = fakeWorker();
      const sim = new Simulation({
        scenario: DEFAULT_SCENARIO,
        economy: 'worker',
        spawnWorker: () => fake.port,
        rate: 2_629_800, // a month per second
      });
      expect(sim.economyMode).toBe('worker');
      for (let frame = 0; frame < 600; frame++) {
        sim.step(1 / 30);
        fake.pump();
      }
      sim.step(0); // apply the last results
      const replica = sim.logistics!;
      expect(replica.jd).toBeGreaterThan(DEFAULT_SCENARIO.startJd + 300);

      const reference = createWorld(DEFAULT_SCENARIO, new Ephemeris(DEFAULT_CATALOG), {
        controllers: true,
      });
      reference.advanceTo(replica.jd);
      expect(view(replica)).toBe(view(reference));
    },
  );

  it('starts the worker on the first step, not on construction', () => {
    let spawned = 0;
    const fake = fakeWorker();
    const sim = new Simulation({
      scenario: DEFAULT_SCENARIO,
      economy: 'worker',
      spawnWorker: () => (spawned++, fake.port),
    });
    expect(spawned).toBe(0);
    sim.step(0.01);
    expect(spawned).toBe(1);
    sim.dispose();
    expect(fake.isTerminated()).toBe(true);
  });

  it('falls back to the main thread when the worker cannot start', () => {
    const sim = new Simulation({
      scenario: DEFAULT_SCENARIO,
      economy: 'worker',
      spawnWorker: () => {
        throw new Error('no workers here');
      },
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 4; i++) sim.step(0.25); // 1 day/s: a full day of ticks
    } finally {
      console.warn = warn;
    }
    expect(sim.economyMode).toBe('inline');
    expect(sim.logistics!.jd).toBeGreaterThan(DEFAULT_SCENARIO.startJd);
  });

  it('reports a worker that fails after starting', () => {
    const fake = fakeWorker();
    const sim = new Simulation({
      scenario: DEFAULT_SCENARIO,
      economy: 'worker',
      spawnWorker: () => fake.port,
    });
    sim.step(0.1);
    fake.pump();
    sim.step(0.1);
    fake.port.fail('boom');
    sim.step(0.1);
    expect(sim.economyMode).toBe('worker');
    expect(sim.economyError).toBe('boom');
  });
});
