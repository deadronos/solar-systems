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

  // Initial guess (Vallado, Algorithm 8).
  let chi: number;
  if (alpha > 1e-9) {
    chi = sqrtMu * dtSeconds * alpha;
  } else if (alpha < -1e-9) {
    const a = 1 / alpha;
    const sgn = Math.sign(dtSeconds) || 1;
    const rdotv = r0m * vr0;
    const arg =
      (-2 * mu * alpha * dtSeconds) / (rdotv + sgn * Math.sqrt(-mu * a) * (1 - r0m * alpha));
    chi = sgn * Math.sqrt(-a) * Math.log(Math.max(arg, 1e-12));
  } else {
    chi = (sqrtMu * dtSeconds) / r0m;
  }
  if (!Number.isFinite(chi)) chi = (sqrtMu * dtSeconds) / r0m;
  for (let k = 0; k < 200; k++) {
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
    let step = F / dF;
    if (!Number.isFinite(step)) break;
    // Damp huge steps (protects the hyperbolic branch from overflow in cosh/sinh).
    const limit = Math.max(1, Math.abs(chi));
    if (Math.abs(step) > limit) step = Math.sign(step) * limit;
    chi -= step;
    if (Math.abs(step) < 1e-9 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi;
  const f = 1 - ((chi * chi) / r0m) * stumpffC(z);
  const g = dtSeconds - (chi * chi * chi * stumpffS(z)) / sqrtMu;
  outR.x = f * r0.x + g * v0.x;
  outR.y = f * r0.y + g * v0.y;
  outR.z = f * r0.z + g * v0.z;
  return outR;
}
