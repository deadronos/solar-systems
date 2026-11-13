import { vec3, type Vec3 } from '../../math/vec3.ts';
import type { Ephemeris } from '../../world/ephemeris.ts';

const MIN_ANGLE_FROM_SINGULAR = 0.5 * (Math.PI / 180);
const Z_MAX = 4 * Math.PI * Math.PI - 1e-6;
/** Reject solutions with absurd speeds (numerical blow-ups near singular geometry). */
const MAX_SPEED_KM_S = 100_000;

/** Stumpff C(z) and S(z) together (same formulas as `stumpffC`/`stumpffS`, one sqrt/trig pass). */
let stC = 0;
let stS = 0;
function stumpff(z: number): void {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    stC = (1 - Math.cos(s)) / z;
    stS = (s - Math.sin(s)) / (s * s * s);
  } else if (z < -1e-8) {
    const s = Math.sqrt(-z);
    stC = (Math.cosh(s) - 1) / -z;
    stS = (Math.sinh(s) - s) / (s * s * s);
  } else {
    stC = 0.5 - z / 24;
    stS = 1 / 6 - z / 120;
  }
}

/**
 * Lambert's problem (universal variables, single revolution, prograde w.r.t. +z).
 * Returns departure/arrival velocities, or null for (near-)collinear geometry or no solution.
 *
 * The time-of-flight function F(z) increases monotonically for single-revolution transfers, so
 * the root is bracketed once and found with Newton steps (analytic F′, Curtis eq. 5.43) that
 * fall back to bisection whenever a step would leave the bracket. Typically 4–8 evaluations.
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
  const sqrtMuT = Math.sqrt(mu) * tofSeconds;
  const tol = 1e-9 * sqrtMuT;

  // F(z) with C, S and y(z) left in `C`, `S`, `y` for the derivative.
  let C = 0;
  let S = 0;
  let y = 0;
  const F = (z: number): number => {
    stumpff(z);
    C = stC;
    S = stS;
    y = r1m + r2m + (A * (z * S - 1)) / Math.sqrt(C);
    if (y < 0) return -sqrtMuT;
    return (y / C) ** 1.5 * S + A * Math.sqrt(y) - sqrtMuT;
  };
  /** dF/dz at the z last passed to F (requires y > 0). */
  const dF = (z: number): number => {
    if (Math.abs(z) < 1e-8) {
      return (Math.SQRT2 / 40) * y ** 1.5 + (A / 8) * (Math.sqrt(y) + A * Math.sqrt(1 / (2 * y)));
    }
    return (
      (y / C) ** 1.5 * ((1 / (2 * z)) * (C - (1.5 * S) / C) + (0.75 * S * S) / C) +
      (A / 8) * ((3 * S * Math.sqrt(y)) / C + A * Math.sqrt(C / y))
    );
  };

  // Bracket: a low bound with F ≤ 0 and the single-revolution limit with F > 0.
  let lo = -4 * Math.PI * Math.PI;
  let fLo = F(lo);
  for (let k = 0; k < 40 && fLo > 0; k++) fLo = F((lo *= 2));
  if (fLo > 0) return null;
  let hi = Z_MAX;
  if (!(F(hi) > 0)) return null;

  let z = lo < 0 && hi > 0 ? 0 : (lo + hi) / 2;
  let f = F(z);
  for (let k = 0; k < 100 && Math.abs(f) >= tol && hi - lo >= 1e-12; k++) {
    if (f > 0) hi = z;
    else lo = z;
    const d = y > 0 ? dF(z) : 0;
    let next = z - f / d;
    if (!(d > 0) || !(next > lo && next < hi)) next = (lo + hi) / 2;
    z = next;
    f = F(z);
  }
  if (!(y > 0)) return null;
  const yz = y;
  const f1 = 1 - yz / r1m;
  const g = A * Math.sqrt(yz / mu);
  const gdot = 1 - yz / r2m;
  if (!Number.isFinite(g) || Math.abs(g) < 1e-12) return null;
  const v1 = vec3((r2.x - f1 * r1.x) / g, (r2.y - f1 * r1.y) / g, (r2.z - f1 * r1.z) / g);
  const v2 = vec3((gdot * r2.x - r1.x) / g, (gdot * r2.y - r1.y) / g, (gdot * r2.z - r1.z) / g);
  if (![v1.x, v1.y, v1.z, v2.x, v2.y, v2.z].every(Number.isFinite)) return null;
  if (Math.hypot(v1.x, v1.y, v1.z) > MAX_SPEED_KM_S) return null;
  return { v1, v2 };
}

const FD_DAYS = 0.01;
const a = vec3();
const b = vec3();

/**
 * Heliocentric velocity of a body (km/s): analytic for bodies orbiting the Sun, else by
 * central finite difference.
 */
export function bodyVelocity(eph: Ephemeris, id: string, jd: number, out: Vec3): Vec3 {
  if (eph.helioStateAt(id, jd, a, out)) return out;
  eph.positionAt(id, jd - FD_DAYS, a);
  eph.positionAt(id, jd + FD_DAYS, b);
  const dt = 2 * FD_DAYS * 86_400;
  out.x = (b.x - a.x) / dt;
  out.y = (b.y - a.y) / dt;
  out.z = (b.z - a.z) / dt;
  return out;
}

/**
 * Position of `posBody` and heliocentric velocity of `velBody` (its Sun-orbiting primary) at
 * `jd`. When they are the same body, one Kepler solve gives both.
 */
export function bodyState(
  eph: Ephemeris,
  posBody: string,
  velBody: string,
  jd: number,
  pos: Vec3,
  vel: Vec3,
): void {
  if (posBody === velBody && eph.helioStateAt(posBody, jd, pos, vel)) return;
  eph.positionAt(posBody, jd, pos);
  bodyVelocity(eph, velBody, jd, vel);
}
