import type { Vec3 } from '../../math/vec3.ts';
import { propagateUniversal } from './kepler2.ts';

export type HoldLabel = 'waiting' | 'ascent' | 'descent' | 'charging' | 'docking';

/** One segment of a trip. Times are Julian dates. */
export type Leg =
  | { kind: 'hold'; bodyId: string; t0: number; t1: number; label: HoldLabel }
  | {
      kind: 'conic';
      t0: number;
      t1: number;
      /** State at t0, relative to `centralBodyId` (null = Sun, heliocentric). km, km/s. */
      r0: Vec3;
      v0: Vec3;
      mu: number;
      centralBodyId: string | null;
    }
  | {
      kind: 'torch';
      t0: number;
      t1: number;
      from: Vec3;
      to: Vec3;
      accelKmS2: number;
      vMaxKmS: number;
      /** Waypoint the path bends through to stay clear of the Sun (#21); straight if absent. */
      via?: Vec3;
    }
  | { kind: 'jump'; t0: number; t1: number; from: Vec3; to: Vec3 };

export interface TrajectoryPlan {
  classId: string;
  fromSiteId: string;
  toSiteId: string;
  departJd: number;
  arriveJd: number;
  legs: Leg[];
  deltaVKmS: number;
  fuelT: number;
  /** Credits for exotic fuel (tiers 4–5). */
  exoticCost: number;
}

const scratchCentral = { x: 0, y: 0, z: 0 };

/** Distance travelled after `t` seconds on an accel/coast/decel profile covering `d` km. */
export function torchDistance(
  t: number,
  total: number,
  d: number,
  a: number,
  vMax: number,
): number {
  const tAcc = Math.min(total / 2, vMax / a);
  const dAcc = 0.5 * a * tAcc * tAcc;
  if (t <= tAcc) return 0.5 * a * t * t;
  const tCoastEnd = total - tAcc;
  if (t <= tCoastEnd) return dAcc + a * tAcc * (t - tAcc);
  const td = total - t;
  return d - 0.5 * a * td * td;
}

/** Heliocentric ship position (km, ecliptic) at `jd`, clamped to the plan's time span. */
export function evaluatePlan(
  plan: TrajectoryPlan,
  jd: number,
  eph: { positionAt(id: string, jd: number, out: Vec3): Vec3 },
  out: Vec3,
): Vec3 {
  const t = Math.min(Math.max(jd, plan.departJd), plan.arriveJd);
  let leg = plan.legs[plan.legs.length - 1];
  for (const l of plan.legs) {
    if (t <= l.t1) {
      leg = l;
      break;
    }
  }
  if (!leg) {
    out.x = out.y = out.z = 0;
    return out;
  }
  switch (leg.kind) {
    case 'hold':
      return eph.positionAt(leg.bodyId, t, out);
    case 'conic': {
      propagateUniversal(leg.r0, leg.v0, (t - leg.t0) * 86_400, leg.mu, out);
      if (leg.centralBodyId) {
        eph.positionAt(leg.centralBodyId, t, scratchCentral);
        out.x += scratchCentral.x;
        out.y += scratchCentral.y;
        out.z += scratchCentral.z;
      }
      return out;
    }
    case 'torch': {
      // One accelerate/flip/decelerate profile along from → (via →) to.
      const mid = leg.via ?? leg.to;
      const d1 = Math.hypot(mid.x - leg.from.x, mid.y - leg.from.y, mid.z - leg.from.z);
      const d2 = leg.via ? Math.hypot(leg.to.x - mid.x, leg.to.y - mid.y, leg.to.z - mid.z) : 0;
      const d = d1 + d2;
      const total = (leg.t1 - leg.t0) * 86_400;
      const along =
        d > 0 ? torchDistance((t - leg.t0) * 86_400, total, d, leg.accelKmS2, leg.vMaxKmS) : d;
      const [a, b, s] =
        along <= d1 || d2 <= 0
          ? [leg.from, mid, d1 > 0 ? along / d1 : 1]
          : [mid, leg.to, (along - d1) / d2];
      out.x = a.x + (b.x - a.x) * s;
      out.y = a.y + (b.y - a.y) * s;
      out.z = a.z + (b.z - a.z) * s;
      return out;
    }
    case 'jump': {
      const span = leg.t1 - leg.t0;
      const s = span > 0 ? (t - leg.t0) / span : 1;
      out.x = leg.from.x + (leg.to.x - leg.from.x) * s;
      out.y = leg.from.y + (leg.to.y - leg.from.y) * s;
      out.z = leg.from.z + (leg.to.z - leg.from.z) * s;
      return out;
    }
  }
}
