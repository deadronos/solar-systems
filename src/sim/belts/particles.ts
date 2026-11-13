import { AU_KM, GAUSS_MEAN_MOTION_DEG_PER_DAY, J2000 } from '../constants.ts';
import { DEG } from '../math/vec3.ts';
import { solveKepler, wrapPi } from '../orbits/kepler.ts';

/**
 * Structure-of-arrays storage for many heliocentric Kepler orbits.
 * Angles in radians, a in km, mean motion in rad/day, all referenced to J2000.
 *
 * Each orbit is also stored as a fixed basis: the position at eccentric anomaly E is
 * `P·(cos E − e) + Q·sin E`, with P = a·(perifocal x axis) and Q = b·(perifocal y axis) in
 * ecliptic km. That leaves only Kepler's equation to solve per date, on the CPU
 * (`propagate`) or on the GPU (see the belt renderer).
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
  /** P basis vectors (xyz triplets, ecliptic km). */
  readonly P: Float64Array;
  /** Q basis vectors (xyz triplets, ecliptic km). */
  readonly Q: Float64Array;

  constructor(count: number) {
    this.count = count;
    this.a = new Float64Array(count);
    this.e = new Float64Array(count);
    this.i = new Float64Array(count);
    this.Omega = new Float64Array(count);
    this.omega = new Float64Array(count);
    this.M0 = new Float64Array(count);
    this.n = new Float64Array(count);
    this.P = new Float64Array(count * 3);
    this.Q = new Float64Array(count * 3);
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
    const a = aAU * AU_KM;
    const i = iDeg * DEG;
    const Omega = OmegaDeg * DEG;
    const omega = omegaDeg * DEG;
    this.a[k] = a;
    this.e[k] = e;
    this.i[k] = i;
    this.Omega[k] = Omega;
    this.omega[k] = omega;
    this.M0[k] = M0Deg * DEG;
    this.n[k] = (GAUSS_MEAN_MOTION_DEG_PER_DAY / aAU ** 1.5) * DEG;

    const cO = Math.cos(Omega);
    const sO = Math.sin(Omega);
    const cw = Math.cos(omega);
    const sw = Math.sin(omega);
    const ci = Math.cos(i);
    const si = Math.sin(i);
    const b = a * Math.sqrt(1 - e * e);
    const o = k * 3;
    this.P[o] = (cw * cO - sw * sO * ci) * a;
    this.P[o + 1] = (cw * sO + sw * cO * ci) * a;
    this.P[o + 2] = sw * si * a;
    this.Q[o] = (-sw * cO - cw * sO * ci) * b;
    this.Q[o + 1] = (-sw * sO + cw * cO * ci) * b;
    this.Q[o + 2] = cw * si * b;
  }

  /**
   * Mean anomaly of every particle at `jd`, wrapped to (−π, π] (radians). Computed in float64,
   * so the GPU only has to add a short time span to it in float32.
   */
  meanAnomaliesAt(jd: number, out: Float32Array | Float64Array, stride = 1, offset = 0): void {
    const dt = jd - J2000;
    for (let k = 0; k < this.count; k++) {
      out[k * stride + offset] = wrapPi(this.M0[k]! + this.n[k]! * dt);
    }
  }

  /** Write heliocentric ecliptic positions (km) at `jd` into `out` (length ≥ count·3). */
  propagate(jd: number, out: Float64Array): void {
    const dt = jd - J2000;
    const { e, M0, n, P, Q } = this;
    for (let k = 0; k < this.count; k++) {
      const ek = e[k]!;
      const E = solveKepler(M0[k]! + n[k]! * dt, ek, 1e-8);
      const x = Math.cos(E) - ek;
      const y = Math.sin(E);
      const o = k * 3;
      out[o] = P[o]! * x + Q[o]! * y;
      out[o + 1] = P[o + 1]! * x + Q[o + 1]! * y;
      out[o + 2] = P[o + 2]! * x + Q[o + 2]! * y;
    }
  }
}
