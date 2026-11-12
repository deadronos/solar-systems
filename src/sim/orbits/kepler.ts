import { TAU, type Vec3 } from '../math/vec3.ts';

/** Classical (osculating) Keplerian elements. Distances in km, angles in radians. */
export interface KeplerElements {
  /** Semi-major axis (km). */
  a: number;
  /** Eccentricity (0 ≤ e < 1). */
  e: number;
  /** Inclination. */
  i: number;
  /** Longitude of the ascending node. */
  Omega: number;
  /** Argument of periapsis. */
  omega: number;
  /** Mean anomaly. */
  M: number;
}

/** Wrap an angle to (-π, π]. */
export function wrapPi(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/**
 * Solve Kepler's equation M = E − e·sin E for the eccentric anomaly E using Newton–Raphson.
 * Converges for all elliptic orbits (e < 1), including highly eccentric ones.
 */
export function solveKepler(meanAnomaly: number, e: number, tolerance = 1e-12): number {
  const M = wrapPi(meanAnomaly);
  let E = e < 0.8 ? M : M >= 0 ? Math.PI : -Math.PI;
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - M;
    const delta = f / (1 - e * Math.cos(E));
    E -= delta;
    if (Math.abs(delta) < tolerance) break;
  }
  return E;
}

/**
 * Rotate a point from the perifocal (orbital-plane) frame into the reference frame
 * using the 3-1-3 rotation (Ω, i, ω).
 */
export function perifocalToReference(
  xp: number,
  yp: number,
  i: number,
  Omega: number,
  omega: number,
  out: Vec3,
): Vec3 {
  const cO = Math.cos(Omega);
  const sO = Math.sin(Omega);
  const cw = Math.cos(omega);
  const sw = Math.sin(omega);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  out.x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
  out.y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
  out.z = sw * si * xp + cw * si * yp;
  return out;
}

/** Position at eccentric anomaly E, in the elements' reference frame (km). */
export function positionAtEccentricAnomaly(el: KeplerElements, E: number, out: Vec3): Vec3 {
  const xp = el.a * (Math.cos(E) - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  return perifocalToReference(xp, yp, el.i, el.Omega, el.omega, out);
}

/** Position for the elements' current mean anomaly, in the elements' reference frame (km). */
export function positionFromElements(el: KeplerElements, out: Vec3): Vec3 {
  return positionAtEccentricAnomaly(el, solveKepler(el.M, el.e), out);
}
