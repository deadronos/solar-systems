import { poleToEcliptic, type Vec3 } from '../sim/index.ts';
import { BRIGHT_STAR_COUNT, BRIGHT_STARS_B64 } from './data/brightStars.ts';

export interface StarField {
  count: number;
  /** Unit directions in the J2000 ecliptic frame, xyz per star. */
  dir: Float32Array;
  /** Visual magnitude per star. */
  mag: Float32Array;
  /** Linear RGB tint per star (from B−V), xyz per star. */
  color: Float32Array;
}

/** B−V used when the catalogue has none: a sun-like white. */
const BV_DEFAULT = 0.6;

/** B−V → tint stops: hot blue-white through white to cool orange. Kept subtle on purpose. */
const BV_STOPS: readonly (readonly [number, number, number, number])[] = [
  [-0.4, 0.62, 0.72, 1],
  [0, 0.82, 0.88, 1],
  [0.4, 1, 0.98, 0.94],
  [0.8, 1, 0.9, 0.76],
  [1.2, 1, 0.8, 0.6],
  [2, 1, 0.66, 0.42],
];

/** Tint for a B−V colour index, interpolated between `BV_STOPS`. */
export function bvToColor(bv: number, out: Vec3): Vec3 {
  const first = BV_STOPS[0]!;
  const last = BV_STOPS.at(-1)!;
  const x = Math.min(last[0], Math.max(first[0], bv));
  for (let i = 1; i < BV_STOPS.length; i++) {
    const a = BV_STOPS[i - 1]!;
    const b = BV_STOPS[i]!;
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      out.x = a[1] + (b[1] - a[1]) * t;
      out.y = a[2] + (b[2] - a[2]) * t;
      out.z = a[3] + (b[3] - a[3]) * t;
      return out;
    }
  }
  out.x = last[1];
  out.y = last[2];
  out.z = last[3];
  return out;
}

/** Decode the packed Bright Star Catalogue (layout in `scripts/build-stars.mjs`). */
export function decodeBrightStars(): StarField {
  const bin = atob(BRIGHT_STARS_B64);
  const view = new DataView(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)).buffer);
  const n = BRIGHT_STAR_COUNT;
  const dir = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const color = new Float32Array(n * 3);
  const tint = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const raDeg = (view.getUint16(o, true) / 65_536) * 360;
    const decDeg = (view.getInt16(o + 2, true) / 32_767) * 90;
    const d = poleToEcliptic(raDeg, decDeg);
    dir.set([d.x, d.y, d.z], i * 3);
    mag[i] = view.getUint8(o + 4) / 25 - 2;
    const bvRaw = view.getInt8(o + 5);
    bvToColor(bvRaw === 127 ? BV_DEFAULT : bvRaw / 50, tint);
    color.set([tint.x, tint.y, tint.z], i * 3);
  }
  return { count: n, dir, mag, color };
}

/**
 * Galactic (l, b) in degrees → unit vector in the J2000 ecliptic frame. Uses the IAU
 * galactic-to-ICRS rotation (Hipparcos, ESA 1997), then the ecliptic tilt via `poleToEcliptic`.
 */
export function galacticToEcliptic(lDeg: number, bDeg: number): Vec3 {
  const l = (lDeg * Math.PI) / 180;
  const b = (bDeg * Math.PI) / 180;
  const gx = Math.cos(b) * Math.cos(l);
  const gy = Math.cos(b) * Math.sin(l);
  const gz = Math.sin(b);
  // r_icrs = A_Gᵀ · r_gal, with A_G the ICRS → galactic matrix.
  const x = -0.054_875_560_4 * gx + 0.494_109_427_9 * gy - 0.867_666_149 * gz;
  const y = -0.873_437_090_2 * gx - 0.444_829_63 * gy - 0.198_076_373_4 * gz;
  const z = -0.483_835_015_5 * gx + 0.746_982_244_5 * gy + 0.455_983_776_2 * gz;
  const raDeg = (Math.atan2(y, x) * 180) / Math.PI;
  const decDeg = (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI;
  return poleToEcliptic(raDeg, decDeg);
}

/**
 * A faint, seeded point cloud tracing the Milky Way: concentrated on the galactic plane, thicker
 * and denser towards the bulge at l = 0, sparser towards the anticentre. Presentation only.
 */
export function milkyWayPoints(
  count: number,
  seed = 7,
): { dir: Float32Array; weight: Float32Array } {
  let s = seed;
  const rnd = () => (s = (s * 16_807) % 2_147_483_647) / 2_147_483_647;
  const gauss = () =>
    Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  const dir = new Float32Array(count * 3);
  const weight = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Longitude: uniform disc plus a bulge component around the galactic centre.
    const bulge = rnd() < 0.35;
    const l = bulge ? gauss() * 28 : rnd() * 360 - 180;
    const centre = Math.cos((l * Math.PI) / 180) * 0.5 + 0.5; // 1 at l = 0, 0 at l = 180
    const thickness = bulge ? 7 : 3 + 3 * centre;
    const b = gauss() * thickness;
    const d = galacticToEcliptic(l, b);
    dir.set([d.x, d.y, d.z], i * 3);
    weight[i] = (0.35 + 0.65 * centre) * Math.exp(-Math.abs(b) / (thickness * 2.5));
  }
  return { dir, weight };
}
