import { describe, expect, it } from 'vitest';
import { AU_KM, J2000, SECONDS_PER_DAY } from './constants.ts';
import { distance, length } from './math/vec3.ts';
import { solveKepler } from './orbits/kepler.ts';
import { Simulation } from './simulation.ts';
import { SimClock } from './time/clock.ts';
import { dateToJd, jdToDate } from './time/julian.ts';

describe('solveKepler', () => {
  it('satisfies M = E − e sin E across eccentricities', () => {
    for (const e of [0, 0.0167, 0.2, 0.6, 0.9, 0.99]) {
      for (let M = -3; M <= 3; M += 0.37) {
        const E = solveKepler(M, e);
        expect(E - e * Math.sin(E)).toBeCloseTo(M, 10);
      }
    }
  });
});

describe('julian dates', () => {
  it('maps J2000 to 2000-01-01T12:00Z and back', () => {
    expect(jdToDate(J2000).toISOString()).toBe('2000-01-01T12:00:00.000Z');
    expect(dateToJd(new Date('2000-01-01T12:00:00Z'))).toBe(J2000);
  });
});

describe('Ephemeris', () => {
  const sim = new Simulation({ startJd: J2000 });
  const eph = sim.ephemeris;
  const au = (id: string) => {
    const p = eph.position(id);
    return { x: p.x / AU_KM, y: p.y / AU_KM, z: p.z / AU_KM };
  };

  it('places Earth near its known J2000 heliocentric position', () => {
    // JPL Horizons EMB at J2000: x ≈ −0.1771, y ≈ 0.9672 AU.
    const e = au('earth');
    expect(e.x).toBeCloseTo(-0.177, 2);
    expect(e.y).toBeCloseTo(0.967, 2);
    expect(Math.abs(e.z)).toBeLessThan(1e-3);
  });

  it('places Jupiter near its known J2000 heliocentric position', () => {
    // JPL Horizons: (4.001, 2.939, −0.102) AU.
    const j = au('jupiter');
    expect(distance(j, { x: 4.001, y: 2.939, z: -0.102 })).toBeLessThan(0.05);
  });

  it('keeps moons at their semi-major axis from the parent', () => {
    const rel = length(eph.localPosition('moon'));
    expect(rel).toBeGreaterThan(356_000);
    expect(rel).toBeLessThan(407_000);
    const titanRel = length(eph.localPosition('titan'));
    expect(titanRel / 1_221_865).toBeCloseTo(1, 1);
  });

  it('returns to the same relative position after one orbital period', () => {
    const period = eph.orbitalPeriodDays('io')!;
    eph.update(J2000);
    const a = { ...eph.localPosition('io') };
    eph.update(J2000 + period);
    expect(distance(a, eph.localPosition('io'))).toBeLessThan(1);
  });
});

describe('SimClock', () => {
  it('advances by rate and respects pause', () => {
    const clock = new SimClock(J2000, SECONDS_PER_DAY);
    clock.tick(0.1);
    expect(clock.jd).toBeCloseTo(J2000 + 0.1, 10);
    clock.setPaused(true);
    clock.tick(0.1);
    expect(clock.jd).toBeCloseTo(J2000 + 0.1, 10);
  });
});
