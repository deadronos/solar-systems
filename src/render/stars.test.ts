import { describe, expect, it } from 'vitest';
import { poleToEcliptic, type Vec3 } from '../sim/index.ts';
import { bvToColor, decodeBrightStars, galacticToEcliptic, milkyWayPoints } from './stars.ts';

const angleDeg = (a: Vec3, b: Vec3) =>
  (Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) * 180) / Math.PI;

describe('bright star catalogue', () => {
  const stars = decodeBrightStars();
  const dirOf = (i: number) => ({
    x: stars.dir[i * 3]!,
    y: stars.dir[i * 3 + 1]!,
    z: stars.dir[i * 3 + 2]!,
  });

  it('decodes the whole catalogue as unit vectors and plausible magnitudes', () => {
    expect(stars.count).toBeGreaterThan(9_000);
    for (let i = 0; i < stars.count; i++) {
      const d = dirOf(i);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 5);
      expect(stars.mag[i]).toBeGreaterThan(-2);
      expect(stars.mag[i]).toBeLessThan(8.5);
    }
  });

  it('puts Sirius, the brightest star, where it belongs', () => {
    let brightest = 0;
    for (let i = 1; i < stars.count; i++) if (stars.mag[i]! < stars.mag[brightest]!) brightest = i;
    expect(stars.mag[brightest]).toBeCloseTo(-1.46, 1);
    // Sirius: RA 06h45m08.9s, Dec −16°42′58″ (J2000).
    const sirius = poleToEcliptic(101.2875, -16.7161);
    expect(angleDeg(dirOf(brightest), sirius)).toBeLessThan(0.02);
    // A white A-type star: its tint is close to neutral.
    const r = stars.color[brightest * 3]!;
    const b = stars.color[brightest * 3 + 2]!;
    expect(Math.abs(r - b)).toBeLessThan(0.2);
  });

  it('tints by B−V: blue-white hot stars, orange cool ones', () => {
    const hot = bvToColor(-0.3, { x: 0, y: 0, z: 0 });
    const cool = bvToColor(1.6, { x: 0, y: 0, z: 0 });
    expect(hot.z).toBeGreaterThan(hot.x);
    expect(cool.x).toBeGreaterThan(cool.z);
  });
});

describe('galactic frame', () => {
  it('maps the galactic centre and north pole to their J2000 positions', () => {
    // Galactic centre: RA 266.405°, Dec −28.936°; north galactic pole: RA 192.860°, Dec 27.128°.
    expect(angleDeg(galacticToEcliptic(0, 0), poleToEcliptic(266.405, -28.936))).toBeLessThan(0.01);
    expect(angleDeg(galacticToEcliptic(0, 90), poleToEcliptic(192.86, 27.128))).toBeLessThan(0.01);
  });

  it('keeps the Milky Way cloud near the galactic plane', () => {
    const { dir, weight } = milkyWayPoints(2_000);
    const pole = galacticToEcliptic(0, 90);
    let near = 0;
    for (let i = 0; i < 2_000; i++) {
      const d = { x: dir[i * 3]!, y: dir[i * 3 + 1]!, z: dir[i * 3 + 2]! };
      if (Math.abs(90 - angleDeg(d, pole)) < 20) near++;
      expect(weight[i]).toBeGreaterThan(0);
    }
    expect(near / 2_000).toBeGreaterThan(0.95);
  });
});
