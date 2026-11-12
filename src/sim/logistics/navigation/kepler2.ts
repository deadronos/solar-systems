import type { Vec3 } from '../../math/vec3.ts';

/** Heliocentric gravitational parameter (km³/s²). */
export const MU_SUN_KM3_S2 = 1.327_124_400_18e11;

/** Stumpff functions C(z), S(z) for universal-variable formulations. */
export function stumpffC(z: number): number {
  if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24;
}

export function stumpffS(z: number): number {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120;
}

/**
 * Two-body propagation with universal variables (elliptic and hyperbolic).
 * Returns the position after `dtSeconds` given position/velocity at t0 (km, km/s).
 */
export function propagateUniversal(
  r0: Vec3,
  v0: Vec3,
  dtSeconds: number,
  mu: number,
  outR: Vec3,
): Vec3 {
  const r0m = Math.hypot(r0.x, r0.y, r0.z);
  const v0m2 = v0.x * v0.x + v0.y * v0.y + v0.z * v0.z;
  const vr0 = (r0.x * v0.x + r0.y * v0.y + r0.z * v0.z) / r0m;
  const alpha = 2 / r0m - v0m2 / mu;
  const sqrtMu = Math.sqrt(mu);

  let chi = sqrtMu * Math.abs(alpha) * dtSeconds;
  if (!Number.isFinite(chi) || chi === 0) chi = (sqrtMu * dtSeconds) / r0m;
  for (let k = 0; k < 100; k++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F =
      ((r0m * vr0) / sqrtMu) * chi * chi * C +
      (1 - alpha * r0m) * chi * chi * chi * S +
      r0m * chi -
      sqrtMu * dtSeconds;
    const dF =
      ((r0m * vr0) / sqrtMu) * chi * (1 - alpha * chi * chi * S) +
      (1 - alpha * r0m) * chi * chi * C +
      r0m;
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-8) break;
  }
  const z = alpha * chi * chi;
  const f = 1 - ((chi * chi) / r0m) * stumpffC(z);
  const g = dtSeconds - (chi * chi * chi * stumpffS(z)) / sqrtMu;
  outR.x = f * r0.x + g * v0.x;
  outR.y = f * r0.y + g * v0.y;
  outR.z = f * r0.z + g * v0.z;
  return outR;
}
