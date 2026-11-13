import { describe, expect, it } from 'vitest';
import { AU_KM } from '../../constants.ts';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { DEG, distance, length, vec3 } from '../../math/vec3.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { MU_SUN_KM3_S2, propagateUniversal } from './kepler2.ts';
import { bodyVelocity, solveLambert } from './lambert.ts';

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
