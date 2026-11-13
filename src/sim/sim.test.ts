import { describe, expect, it } from 'vitest';
import { AU_KM, DAYS_PER_JULIAN_CENTURY, J2000, SECONDS_PER_DAY } from './constants.ts';
import { DEG, distance, length, vec3 } from './math/vec3.ts';
import { elementsAt } from './orbits/models.ts';
import { positionFromElements, solveKepler } from './orbits/kepler.ts';
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

  it('applies the long-range mean anomaly correction to Jupiter', () => {
    const orbit = eph.get('jupiter').orbit!;
    const jd = J2000 + DAYS_PER_JULIAN_CENTURY;
    // Standish Tables 2a and 2b, evaluated at T = 1.
    const correction =
      -0.00012452 + 0.0606406 * Math.cos(38.35125 * DEG) - 0.35635438 * Math.sin(38.35125 * DEG);
    const meanLongitude = 34.33479152 + 3034.90371757;
    const perihelion = 14.27495244 + 0.18199196;
    expect(elementsAt(orbit, jd).M).toBeCloseTo(
      (meanLongitude - perihelion + correction) * DEG,
      10,
    );
  });

  // JPL Horizons geometric vectors, Sun center (500@10), J2000 ecliptic, JD 2488069.5 TDB.
  it.each([
    ['earth', -23_551_897, 145_213_160, -32_559, 40_000],
    ['mars', 91_203_206, 206_557_598, 2_112_857, 150_000],
    ['jupiter', -803_903_147, -135_906_851, 18_533_339, 2_000_000],
    ['saturn', -1_369_282_077, -460_610_820, 62_567_810, 8_000_000],
    ['neptune', -4_347_198_940, 1_231_964_350, 74_827_976, 10_000_000],
    ['pluto', 5_935_341_284, 3_725_700_243, -2_115_792_370, 12_000_000],
  ])('places %s near its Horizons position in 2100', (id, x, y, z, toleranceKm) => {
    const position = eph.positionAt(id, 2_488_069.5, vec3());
    expect(distance(position, vec3(x, y, z))).toBeLessThan(toleranceKm);
  });

  it.each([
    ['earth', 'moon', 4_000, 5_300],
    ['pluto', 'charon', 2_000, 2_300],
  ])('offsets %s from its barycenter with %s', (primary, partner, minKm, maxKm) => {
    const jd = J2000 + 1_234.5;
    const p = eph.positionAt(primary, jd, vec3());
    const m = eph.positionAt(partner, jd, vec3());
    const gmP = eph.get(primary).gm!;
    const gmM = eph.get(partner).gm!;
    // The mass-weighted centre is exactly the barycenter the orbit elements describe.
    const bary = vec3(
      (gmP * p.x + gmM * m.x) / (gmP + gmM),
      (gmP * p.y + gmM * m.y) / (gmP + gmM),
      (gmP * p.z + gmM * m.z) / (gmP + gmM),
    );
    const orbit = positionFromElements(elementsAt(eph.get(primary).orbit!, jd), vec3());
    expect(distance(bary, orbit)).toBeLessThan(1e-3);
    expect(distance(p, orbit)).toBeGreaterThan(minKm);
    expect(distance(p, orbit)).toBeLessThan(maxKm);
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
