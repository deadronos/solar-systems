import { describe, expect, it } from 'vitest';
import { Ephemeris } from '../../world/ephemeris.ts';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { createWorld } from '../createWorld.ts';
import { withFleetSize } from './benchmark.ts';
import { DEFAULT_SCENARIO } from './scenario.ts';

describe('withFleetSize', () => {
  it('starts a world with at least the requested fleet', () => {
    const world = createWorld(withFleetSize(DEFAULT_SCENARIO, 300), new Ephemeris(DEFAULT_CATALOG));
    expect(world.ships.size).toBeGreaterThanOrEqual(300);
    expect(new Set([...world.ships.values()].map((s) => s.name)).size).toBe(world.ships.size);
    world.advanceTo(world.jd + 30);
  });
});
