import { copy, type Simulation, type Vec3 } from '../../sim/index.ts';
import { evaluatePlan, type Ship } from '../../sim/logistics/index.ts';
import type { EntityRef } from '../../state/selectionStore.ts';

/**
 * The body a ship is sitting at on `jd`, or null while it is actually travelling.
 * A ship waiting for its launch window is still at its origin, and a ship whose arrival the
 * economy has not processed yet (the clock may run ahead of it) is already at its destination.
 */
export function shipAnchorBody(sim: Simulation, ship: Readonly<Ship>, jd: number): string | null {
  const world = sim.logistics;
  if (!world) return null;
  const bodyOf = (siteId: string | null | undefined) =>
    (siteId && world.settlements.get(siteId)?.site.bodyId) || null;
  const plan = ship.plan;
  if (!plan || ship.state === 'docked' || ship.state === 'building') return bodyOf(ship.siteId);
  if (jd < plan.departJd) return bodyOf(ship.siteId ?? plan.fromSiteId);
  if (jd > plan.arriveJd) return bodyOf(plan.toSiteId);
  return null;
}

/** Heliocentric position (km) of a ship at `jd`: the body it is at, or its trajectory. */
export function shipPosition(
  sim: Simulation,
  ship: Readonly<Ship>,
  jd: number,
  out: Vec3,
): Vec3 | null {
  if (!sim.logistics) return null;
  const anchor = shipAnchorBody(sim, ship, jd);
  if (anchor) return copy(out, sim.ephemeris.position(anchor));
  if (ship.plan) return evaluatePlan(ship.plan, jd, sim.ephemeris, out);
  return null;
}

/**
 * The body an entity is at (a settlement's body, a docked ship's port…), or null for a ship
 * in flight or an entity that no longer exists.
 */
export function entityAnchorBody(
  sim: Simulation,
  ref: EntityRef,
  jd = sim.clock.jd,
): string | null {
  const world = sim.logistics;
  switch (ref.kind) {
    case 'body':
      return sim.ephemeris.has(ref.id) ? ref.id : null;
    case 'settlement':
      return world?.settlements.get(ref.id)?.site.bodyId ?? null;
    case 'ship': {
      const ship = world?.ships.get(ref.id);
      return ship ? shipAnchorBody(sim, ship, jd) : null;
    }
    case 'company': {
      const id = world?.companies.get(ref.id)?.shipIds[0];
      const ship = id ? world?.ships.get(id) : undefined;
      return ship ? shipAnchorBody(sim, ship, jd) : null;
    }
    case 'contract': {
      const c = world?.contracts.get(ref.id);
      return (c && world?.settlements.get(c.settlementId)?.site.bodyId) || null;
    }
  }
}

/** The ship whose trajectory the camera tracks for an entity, if any. */
export function trackedShip(sim: Simulation, ref: EntityRef): Readonly<Ship> | undefined {
  const world = sim.logistics;
  if (ref.kind === 'ship') return world?.ships.get(ref.id);
  if (ref.kind === 'company') {
    const id = world?.companies.get(ref.id)?.shipIds[0];
    return id ? world?.ships.get(id) : undefined;
  }
  return undefined;
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
  if (ref) {
    const anchor = entityAnchorBody(sim, ref, jd);
    if (anchor) return copy(out, sim.ephemeris.position(anchor));
    const ship = trackedShip(sim, ref);
    if (ship && shipPosition(sim, ship, jd, out)) return out;
  }
  return copy(out, sim.ephemeris.position(fallbackBodyId));
}

/** What the camera centres on: the followed entity, or else the focused body. */
export function cameraTarget(
  follow: boolean,
  selected: EntityRef | null,
  focusId: string,
): EntityRef {
  return follow && selected ? selected : { kind: 'body', id: focusId };
}
