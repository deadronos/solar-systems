import { describe, expect, it } from 'vitest';
import { createBelt, DEFAULT_BELTS } from '../../sim/belts/belts.ts';
import { J2000 } from '../../sim/constants.ts';
import { positionFromElements } from '../../sim/orbits/kepler.ts';
import { vec3 } from '../../sim/math/vec3.ts';
import { solveKeplerFixed } from './beltShader.ts';

const belts = DEFAULT_BELTS.map(createBelt);

describe('belt orbit basis', () => {
  it('matches full Keplerian propagation', () => {
    const jd = J2000 + 15_000;
    for (const { orbits: o } of belts) {
      const out = new Float64Array(o.count * 3);
      o.propagate(jd, out);
      for (let k = 0; k < o.count; k += 97) {
        const want = positionFromElements(
          {
            a: o.a[k]!,
            e: o.e[k]!,
            i: o.i[k]!,
            Omega: o.Omega[k]!,
            omega: o.omega[k]!,
            M: o.M0[k]! + o.n[k]! * (jd - J2000),
          },
          vec3(),
        );
        const err = Math.hypot(
          out[k * 3]! - want.x,
          out[k * 3 + 1]! - want.y,
          out[k * 3 + 2]! - want.z,
        );
        expect(err).toBeLessThan(1); // km
      }
    }
  });
});

describe('epoch rebasing', () => {
  it('mean anomaly at an epoch plus n·Δt reproduces propagation (as the shader does)', () => {
    const epoch = J2000 + 20_000;
    const dt = 300;
    for (const { orbits: o } of belts) {
      const M = new Float32Array(o.count * 3);
      o.meanAnomaliesAt(epoch, M, 3, 0);
      const want = new Float64Array(o.count * 3);
      o.propagate(epoch + dt, want);
      for (let k = 0; k < o.count; k += 41) {
        const E = solveKeplerFixed(Math.fround(M[k * 3]! + o.n[k]! * dt), o.e[k]!);
        const x = Math.cos(E) - o.e[k]!;
        const y = Math.sin(E);
        const j = k * 3;
        const err = Math.hypot(
          o.P[j]! * x + o.Q[j]! * y - want[j]!,
          o.P[j + 1]! * x + o.Q[j + 1]! * y - want[j + 1]!,
          o.P[j + 2]! * x + o.Q[j + 2]! * y - want[j + 2]!,
        );
        // float32 mean anomaly: < 1e-5 of the orbit radius.
        expect(err / o.a[k]!).toBeLessThan(1e-5);
      }
    }
  });
});

describe('GPU Kepler solver (float32 mirror)', () => {
  it('converges for every belt particle over a rebase window', () => {
    let worst = 0;
    for (const { orbits: o } of belts) {
      const M = new Float32Array(o.count);
      o.meanAnomaliesAt(J2000 + 5_000, M);
      for (const dt of [0, 180, 365, -365]) {
        for (let k = 0; k < o.count; k++) {
          const f = Math.fround;
          let m = f(M[k]! + f(f(o.n[k]!) * dt));
          m = f(f(((m + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
          const e = f(o.e[k]!);
          const E = solveKeplerFixed(m, e);
          // Residual of Kepler's equation, in radians of mean anomaly.
          worst = Math.max(worst, Math.abs(E - e * Math.sin(E) - m));
        }
      }
    }
    // 1e-5 rad at 150 AU is ~0.2 Earth–Moon distances: far below a 1.6 px point.
    expect(worst).toBeLessThan(1e-5);
  });
});
