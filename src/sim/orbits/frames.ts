import { OBLIQUITY_J2000_DEG } from '../constants.ts';
import { cross, DEG, fromColumns, normalize, vec3, type Mat3, type Vec3 } from '../math/vec3.ts';

const EPS = OBLIQUITY_J2000_DEG * DEG;
const ECLIPTIC_NORTH = vec3(0, 0, 1);

/**
 * Convert a rotation pole given in ICRF/J2000 equatorial coordinates (RA/Dec, degrees)
 * into a unit vector in the J2000 ecliptic frame.
 */
export function poleToEcliptic(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const x = Math.cos(dec) * Math.cos(ra);
  const y = Math.cos(dec) * Math.sin(ra);
  const z = Math.sin(dec);
  // Rotate about the x-axis (vernal equinox) by -ε: equatorial → ecliptic.
  return vec3(x, y * Math.cos(EPS) + z * Math.sin(EPS), -y * Math.sin(EPS) + z * Math.cos(EPS));
}

/**
 * Matrix mapping vectors expressed in a body's equatorial frame into the ecliptic frame.
 * The equatorial frame's x-axis points to the ascending node of the body's equator on the
 * ecliptic; z is the body's (positive / angular-momentum) pole.
 */
export function equatorialToEcliptic(pole: Vec3): Mat3 {
  const z = normalize(vec3(), pole);
  const x = cross(vec3(), ECLIPTIC_NORTH, z);
  if (Math.hypot(x.x, x.y, x.z) < 1e-9) {
    x.x = 1;
    x.y = 0;
    x.z = 0;
  }
  normalize(x, x);
  const y = cross(vec3(), z, x);
  return fromColumns(x, y, z);
}
