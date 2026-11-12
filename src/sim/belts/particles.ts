import { AU_KM, GAUSS_MEAN_MOTION_DEG_PER_DAY, J2000 } from '../constants.ts';
import { DEG } from '../math/vec3.ts';
import { solveKepler } from '../orbits/kepler.ts';

/**
 * Structure-of-arrays storage for many heliocentric Kepler orbits.
 * Angles in radians, a in km, mean motion in rad/day, all referenced to J2000.
 */
export class ParticleOrbits {
  readonly count: number;
  readonly a: Float64Array;
  readonly e: Float64Array;
  readonly i: Float64Array;
  readonly Omega: Float64Array;
  readonly omega: Float64Array;
  readonly M0: Float64Array;
  readonly n: Float64Array;

  constructor(count: number) {
    this.count = count;
    this.a = new Float64Array(count);
    this.e = new Float64Array(count);
    this.i = new Float64Array(count);
    this.Omega = new Float64Array(count);
    this.omega = new Float64Array(count);
    this.M0 = new Float64Array(count);
    this.n = new Float64Array(count);
  }

  /** Set particle `k` from elements in AU/degrees. Mean motion follows Kepler's third law. */
  set(
    k: number,
    aAU: number,
    e: number,
    iDeg: number,
    OmegaDeg: number,
    omegaDeg: number,
    M0Deg: number,
  ): void {
    this.a[k] = aAU * AU_KM;
    this.e[k] = e;
    this.i[k] = iDeg * DEG;
    this.Omega[k] = OmegaDeg * DEG;
    this.omega[k] = omegaDeg * DEG;
    this.M0[k] = M0Deg * DEG;
    this.n[k] = (GAUSS_MEAN_MOTION_DEG_PER_DAY / aAU ** 1.5) * DEG;
  }

  /** Write heliocentric ecliptic positions (km) at `jd` into `out` (length ≥ count·3). */
  propagate(jd: number, out: Float64Array): void {
    const dt = jd - J2000;
    const { a, e, i, Omega, omega, M0, n } = this;
    for (let k = 0; k < this.count; k++) {
      const ek = e[k]!;
      const ak = a[k]!;
      const E = solveKepler(M0[k]! + n[k]! * dt, ek, 1e-8);
      const xp = ak * (Math.cos(E) - ek);
      const yp = ak * Math.sqrt(1 - ek * ek) * Math.sin(E);
      const cO = Math.cos(Omega[k]!);
      const sO = Math.sin(Omega[k]!);
      const cw = Math.cos(omega[k]!);
      const sw = Math.sin(omega[k]!);
      const ci = Math.cos(i[k]!);
      const si = Math.sin(i[k]!);
      const o = k * 3;
      out[o] = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
      out[o + 1] = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
      out[o + 2] = sw * si * xp + cw * si * yp;
    }
  }
}
