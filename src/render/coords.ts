import { Vector3, type PerspectiveCamera } from 'three';
import type { Vec3 } from '../sim/index.ts';

/**
 * Scene scale: 1 scene unit = 1,000,000 km. Distances and radii are both true-to-scale.
 * Precision is preserved with a floating origin: everything is rendered relative to the
 * focused body, computed in float64 before converting to float32 scene space.
 */
export const KM_PER_UNIT = 1_000_000;
export const UNITS_PER_KM = 1 / KM_PER_UNIT;

/**
 * Sim uses the J2000 ecliptic frame (z = ecliptic north). three.js is y-up, so map
 * ecliptic (x, y, z) → scene (x, z, −y).
 */
export function eclipticToScene(x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x * UNITS_PER_KM, z * UNITS_PER_KM, -y * UNITS_PER_KM);
}

/** Scene position of `p` (heliocentric km) relative to the floating `origin` (km). */
export function relativeToScene(p: Readonly<Vec3>, origin: Readonly<Vec3>, out: Vector3): Vector3 {
  return eclipticToScene(p.x - origin.x, p.y - origin.y, p.z - origin.z, out);
}

/** Direction (unitless) from ecliptic to scene axes. */
export const eclipticDirToScene = (v: Readonly<Vec3>, out: Vector3): Vector3 =>
  out.set(v.x, v.z, -v.y).normalize();

/** Pixels per scene unit at a given distance from a perspective camera. */
export function pixelsPerUnit(camera: PerspectiveCamera, distance: number, viewportHeight: number) {
  const halfFov = (camera.fov * Math.PI) / 360;
  return viewportHeight / (2 * Math.tan(halfFov) * Math.max(distance, 1e-12));
}

export const scratchVec = new Vector3();
