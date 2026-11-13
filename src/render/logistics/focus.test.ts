import { describe, expect, it } from 'vitest';
import { distance, vec3 } from '../../sim/index.ts';
import { DEFAULT_SCENARIO, evaluatePlan } from '../../sim/logistics/index.ts';
import { Simulation } from '../../sim/simulation.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import {
  cameraTarget,
  entityAnchorBody,
  resolveFocusPosition,
  shipAnchorBody,
  shipPosition,
} from './focus.ts';

describe('resolveFocusPosition', () => {
  it('falls back to the given body for a removed ship', () => {
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    const out = resolveFocusPosition(
      sim,
      { kind: 'ship', id: 'ship-does-not-exist' },
      'sun',
      vec3(),
    );
    expect(out).toEqual(sim.ephemeris.position('sun'));
  });

  it('follows a ship along its plan mid-flight', () => {
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    const world = sim.logistics!;
    const ship = [...world.ships.values()].find((s) => s.classId === 'torch-courier')!;
    const company = ship.companyId;
    expect(
      world.issue(company, [{ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: 'mars-colony' }]),
    ).toEqual([true]);
    const mid = (ship.plan!.departJd + ship.plan!.arriveJd) / 2;
    const got = resolveFocusPosition(sim, { kind: 'ship', id: ship.id }, 'sun', vec3(), mid);
    const want = evaluatePlan(ship.plan!, mid, sim.ephemeris, vec3());
    expect(distance(got, want)).toBeLessThan(1e-6);
  });
});

describe('ships at a body', () => {
  /** Dispatch some ship whose launch window is still in the future. */
  function waitingShip() {
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    const world = sim.logistics!;
    for (const ship of world.ships.values()) {
      if (world.shipClassOf(ship).tier > 2 || ship.state !== 'docked') continue;
      for (const dest of ['mars-colony', 'ceres-colony']) {
        if (ship.siteId === dest) continue;
        const [ok] = world.issue(ship.companyId, [
          { type: 'PlanAndDispatch', shipId: ship.id, toSiteId: dest },
        ]);
        const state: string = ship.state; // mutated by the command
        if (ok && state === 'waiting' && ship.plan!.departJd > world.jd + 1) {
          return { sim, world, ship };
        }
      }
    }
    throw new Error('no ship with a future launch window');
  }

  it('draws a ship waiting for its launch window at its port, not its departure point', () => {
    const { sim, world, ship } = waitingShip();
    const body = world.settlements.get(ship.siteId!)!.site.bodyId;
    const got = shipPosition(sim, ship, sim.clock.jd, vec3())!;
    expect(distance(got, sim.ephemeris.position(body))).toBeLessThan(1e-6);
    expect(entityAnchorBody(sim, { kind: 'ship', id: ship.id })).toBe(body);
  });

  it('puts a ship at its destination once the clock passes its arrival', () => {
    const { sim, world, ship } = waitingShip();
    const dest = world.settlements.get(ship.plan!.toSiteId)!.site.bodyId;
    const after = ship.plan!.arriveJd + 1;
    expect(shipAnchorBody(sim, ship, after)).toBe(dest);
    expect(shipAnchorBody(sim, ship, (ship.plan!.departJd + ship.plan!.arriveJd) / 2)).toBe(null);
  });

  it('centres the camera on the followed entity, else the focused body', () => {
    const ship = { kind: 'ship' as const, id: 'x' };
    expect(cameraTarget(true, ship, 'mars')).toBe(ship);
    expect(cameraTarget(false, ship, 'mars')).toEqual({ kind: 'body', id: 'mars' });
    expect(cameraTarget(true, null, 'mars')).toEqual({ kind: 'body', id: 'mars' });
  });
});

describe('selection history', () => {
  it('behaves like browser back/forward', () => {
    const s = useSelectionStore.getState();
    const ref = (id: string) => ({ kind: 'ship' as const, id });
    s.select(ref('A'));
    s.select(ref('B'));
    s.select(ref('C'));
    useSelectionStore.getState().back();
    expect(useSelectionStore.getState().selected).toEqual(ref('B'));
    useSelectionStore.getState().forward();
    expect(useSelectionStore.getState().selected).toEqual(ref('C'));
    useSelectionStore.getState().back();
    useSelectionStore.getState().select(ref('D'));
    expect(useSelectionStore.getState().future).toEqual([]);
    useSelectionStore.getState().back();
    expect(useSelectionStore.getState().selected).toEqual(ref('B'));
  });
});
