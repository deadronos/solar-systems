import { describe, expect, it } from 'vitest';
import { distance, vec3 } from '../../sim/index.ts';
import { DEFAULT_SCENARIO, evaluatePlan } from '../../sim/logistics/index.ts';
import { Simulation } from '../../sim/simulation.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { resolveFocusPosition } from './focus.ts';

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
