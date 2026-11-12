import { vec3, type Vec3 } from '../../math/vec3.ts';
import type { Ephemeris } from '../../world/ephemeris.ts';
import { stumpffC, stumpffS } from './kepler2.ts';

const MIN_ANGLE_FROM_SINGULAR = 0.5 * (Math.PI / 180);
const Z_MAX = 4 * Math.PI * Math.PI - 1e-6;

/**
 * Lambert's problem (universal variables, single revolution, prograde w.r.t. +z).
 * Returns departure/arrival velocities, or null for (near-)collinear geometry or no solution.
 */
export function solveLambert(
  r1: Vec3,
  r2: Vec3,
  tofSeconds: number,
  mu: number,
): { v1: Vec3; v2: Vec3 } | null {
  if (!(tofSeconds > 0)) return null;
  const r1m = Math.hypot(r1.x, r1.y, r1.z);
  const r2m = Math.hypot(r2.x, r2.y, r2.z);
  const cz = r1.x * r2.y - r1.y * r2.x;
  const cosT = Math.min(1, Math.max(-1, (r1.x * r2.x + r1.y * r2.y + r1.z * r2.z) / (r1m * r2m)));
  let theta = Math.acos(cosT);
  if (cz < 0) theta = 2 * Math.PI - theta;
  if (
    Math.abs(theta - Math.PI) < MIN_ANGLE_FROM_SINGULAR ||
    theta < MIN_ANGLE_FROM_SINGULAR ||
    2 * Math.PI - theta < MIN_ANGLE_FROM_SINGULAR
  ) {
    return null;
  }
  const A = Math.sin(theta) * Math.sqrt((r1m * r2m) / (1 - Math.cos(theta)));
  const y = (z: number) => r1m + r2m + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const sqrtMuT = Math.sqrt(mu) * tofSeconds;
  const F = (z: number) => {
    const yz = y(z);
    if (yz < 0) return -sqrtMuT;
    return (yz / stumpffC(z)) ** 1.5 * stumpffS(z) + A * Math.sqrt(yz) - sqrtMuT;
  };

  // Lower bound: where y(z) becomes non-negative (y is increasing in z).
  let lo = -4 * Math.PI * Math.PI;
  while (y(lo) > 0 && lo > -1e7) lo *= 2;
  if (y(lo) > 0) return null;
  let hi = Z_MAX;
  if (F(hi) < 0) return null;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (F(mid) > 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  const z = 0.5 * (lo + hi);
  const yz = y(z);
  if (!(yz > 0)) return null;
  const f = 1 - yz / r1m;
  const g = A * Math.sqrt(yz / mu);
  const gdot = 1 - yz / r2m;
  if (!Number.isFinite(g) || Math.abs(g) < 1e-12) return null;
  const v1 = vec3((r2.x - f * r1.x) / g, (r2.y - f * r1.y) / g, (r2.z - f * r1.z) / g);
  const v2 = vec3((gdot * r2.x - r1.x) / g, (gdot * r2.y - r1.y) / g, (gdot * r2.z - r1.z) / g);
  if (![v1.x, v1.y, v1.z, v2.x, v2.y, v2.z].every(Number.isFinite)) return null;
  return { v1, v2 };
}

const FD_DAYS = 0.01;
const a = vec3();
const b = vec3();

/** Heliocentric velocity of a body by central finite difference (km/s). */
export function bodyVelocity(eph: Ephemeris, id: string, jd: number, out: Vec3): Vec3 {
  eph.positionAt(id, jd - FD_DAYS, a);
  eph.positionAt(id, jd + FD_DAYS, b);
  const dt = 2 * FD_DAYS * 86_400;
  out.x = (b.x - a.x) / dt;
  out.y = (b.y - a.y) / dt;
  out.z = (b.z - a.z) / dt;
  return out;
}
