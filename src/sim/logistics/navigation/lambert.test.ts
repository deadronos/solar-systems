import { describe, expect, it } from 'vitest';
import { AU_KM } from '../../constants.ts';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { DEG, distance, length, vec3 } from '../../math/vec3.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { MU_SUN_KM3_S2, propagateUniversal } from './kepler2.ts';
import { bodyVelocity, solveLambert } from './lambert.ts';
import { solveLambertReference } from './lambertReference.ts';

const DAY = 86_400;

describe('Ephemeris.positionAt', () => {
  it('matches update() and does not disturb cached state', () => {
    const eph = new Ephemeris(DEFAULT_CATALOG);
    eph.update(START_JD);
    const cached = { ...eph.position('moon') };
    const at = eph.positionAt('moon', START_JD + 100, vec3());
    expect(eph.position('moon')).toEqual(cached);
    eph.update(START_JD + 100);
    expect(distance(at, eph.position('moon'))).toBeLessThan(1e-6);
  });
});

describe('solveLambert', () => {
  const r1 = vec3(AU_KM, 0, 0);
  const a2 = 179 * DEG;
  const r2 = vec3(1.524 * AU_KM * Math.cos(a2), 1.524 * AU_KM * Math.sin(a2), 0);

  it('reproduces a Hohmann-like Earth→Mars arc', () => {
    const sol = solveLambert(r1, r2, 258.8 * DAY, MU_SUN_KM3_S2)!;
    expect(sol).not.toBeNull();
    expect(length(sol.v1)).toBeCloseTo(32.73, 0);
    expect(sol.v1.y).toBeGreaterThan(0); // prograde
  });

  it('returns null for collinear (180°) geometry', () => {
    const opposite = vec3(-1.524 * AU_KM, 0, 0);
    expect(solveLambert(r1, opposite, 258.8 * DAY, MU_SUN_KM3_S2)).toBeNull();
  });

  it('propagating v1 for the time of flight reaches r2', () => {
    const tof = 200 * DAY;
    const sol = solveLambert(r1, r2, tof, MU_SUN_KM3_S2)!;
    const end = propagateUniversal(r1, sol.v1, tof, MU_SUN_KM3_S2, vec3());
    expect(distance(end, r2)).toBeLessThan(1_000);
  });

  it('works for short, fast (hyperbolic) transfers', () => {
    const tof = 30 * DAY;
    const sol = solveLambert(r1, r2, tof, MU_SUN_KM3_S2)!;
    const end = propagateUniversal(r1, sol.v1, tof, MU_SUN_KM3_S2, vec3());
    expect(distance(end, r2)).toBeLessThan(1_000);
  });
});

describe('bodyVelocity', () => {
  it('gives Earth ~29.8 km/s', () => {
    const eph = new Ephemeris(DEFAULT_CATALOG);
    expect(length(bodyVelocity(eph, 'earth', START_JD, vec3()))).toBeCloseTo(29.8, 0);
  });
});

describe('solveLambert vs the original bracket-scan solver', () => {
  /** Deterministic pseudo-random geometries: inner/outer system, moons, short and long arcs. */
  function* cases() {
    let s = 12_345;
    const rnd = () => (s = (s * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (let k = 0; k < 4_000; k++) {
      const local = k % 4 === 0;
      const mu = local ? 37_931_187 * (0.01 + rnd()) : MU_SUN_KM3_S2; // Saturn-ish systems
      const scale = local ? 2e5 + rnd() * 3e6 : AU_KM * (0.3 + rnd() * 40);
      const r = (m: number) => {
        const a = rnd() * 2 * Math.PI;
        const z = (rnd() - 0.5) * 0.2;
        return vec3(m * Math.cos(a), m * Math.sin(a), m * z);
      };
      const r1 = r(scale * (0.3 + rnd()));
      const r2 = r(scale * (0.3 + rnd() * 2));
      const period = 2 * Math.PI * Math.sqrt(scale ** 3 / mu);
      const tof = period * (0.01 + rnd() * 0.8);
      yield { r1, r2, tof, mu };
    }
  }

  it('returns the same transfers', () => {
    let solved = 0;
    for (const { r1, r2, tof, mu } of cases()) {
      const want = solveLambertReference(r1, r2, tof, mu);
      const got = solveLambert(r1, r2, tof, mu);
      expect(got === null).toBe(want === null);
      if (!want || !got) continue;
      solved++;
      const scale = length(want.v1) + length(want.v2);
      expect(distance(got.v1, want.v1) / scale).toBeLessThan(1e-7);
      expect(distance(got.v2, want.v2) / scale).toBeLessThan(1e-7);
    }
    expect(solved).toBeGreaterThan(3_000);
  });
});

describe('Ephemeris.helioStateAt', () => {
  const eph = new Ephemeris(DEFAULT_CATALOG);
  const helio = eph.bodies.filter((d) => d.parentId === 'sun');

  it('matches positionAt and a finite-difference velocity for every Sun-orbiting body', () => {
    expect(helio.length).toBeGreaterThan(10);
    const h = 0.003; // days: small enough for Mercury, large enough for Sedna's round-off
    for (const def of helio) {
      for (const jd of [START_JD, START_JD + 9_000, START_JD + 40_000]) {
        const pos = vec3();
        const vel = vec3();
        expect(eph.helioStateAt(def.id, jd, pos, vel)).toBe(true);
        expect(distance(pos, eph.positionAt(def.id, jd, vec3()))).toBe(0);
        const a = eph.positionAt(def.id, jd - h, vec3());
        const b = eph.positionAt(def.id, jd + h, vec3());
        // jd ± h is only representable to ~5e-10 days, so divide by the step actually taken.
        const dt = (jd + h - (jd - h)) * DAY;
        const fd = vec3((b.x - a.x) / dt, (b.y - a.y) / dt, (b.z - a.z) / dt);
        expect(distance(vel, fd) / length(fd)).toBeLessThan(1e-7);
      }
    }
  });

  it('declines moons and the Sun', () => {
    expect(eph.helioStateAt('moon', START_JD, vec3(), vec3())).toBe(false);
    expect(eph.helioStateAt('sun', START_JD, vec3(), vec3())).toBe(false);
  });
});
