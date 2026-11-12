import { copy, vec3, type Simulation, type Vec3 } from '../../sim/index.ts';
import { evaluatePlan, type Ship } from '../../sim/logistics/index.ts';
import type { EntityRef } from '../../state/selectionStore.ts';

/** Heliocentric position (km) of a ship at `jd`: its trajectory, or the body it is docked at. */
export function shipPosition(
  sim: Simulation,
  ship: Readonly<Ship>,
  jd: number,
  out: Vec3,
): Vec3 | null {
  const world = sim.logistics;
  if (!world) return null;
  if (ship.plan && ship.state !== 'docked') return evaluatePlan(ship.plan, jd, sim.ephemeris, out);
  const site = ship.siteId ? world.settlements.get(ship.siteId) : undefined;
  if (!site) return null;
  return copy(out, sim.ephemeris.position(site.site.bodyId));
}

/**
 * Where the camera should centre for a selected entity (heliocentric km). Unknown or removed
 * entities fall back to the given body, so following a ship that was sold never breaks.
 */
export function resolveFocusPosition(
  sim: Simulation,
  ref: EntityRef | null,
  fallbackBodyId: string,
  out: Vec3,
  jd = sim.clock.jd,
): Vec3 {
  const world = sim.logistics;
  const fallback = () => copy(out, sim.ephemeris.position(fallbackBodyId));
  if (!ref) return fallback();
  switch (ref.kind) {
    case 'body':
      return sim.ephemeris.has(ref.id) ? copy(out, sim.ephemeris.position(ref.id)) : fallback();
    case 'settlement': {
      const s = world?.settlements.get(ref.id);
      return s ? copy(out, sim.ephemeris.position(s.site.bodyId)) : fallback();
    }
    case 'ship': {
      const ship = world?.ships.get(ref.id);
      return (ship && shipPosition(sim, ship, jd, out)) || fallback();
    }
    case 'company': {
      const id = world?.companies.get(ref.id)?.shipIds[0];
      const ship = id ? world?.ships.get(id) : undefined;
      return (ship && shipPosition(sim, ship, jd, out)) || fallback();
    }
    case 'contract': {
      const c = world?.contracts.get(ref.id);
      const s = c ? world?.settlements.get(c.settlementId) : undefined;
      return s ? copy(out, sim.ephemeris.position(s.site.bodyId)) : fallback();
    }
  }
}

/** Scratch vector for per-frame use. */
export const focusScratch = vec3();
