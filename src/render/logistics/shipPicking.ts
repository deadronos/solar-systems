import { Vector3, type Camera } from 'three';

const ndc = new Vector3();

/**
 * Index of the point nearest to a pointer position (CSS px within the canvas), or -1 when
 * none lies within `maxPx`. `positions` holds `count` scene-space points (xyz).
 */
export function pickNearest(
  positions: Float32Array,
  count: number,
  camera: Camera,
  size: { width: number; height: number },
  px: number,
  py: number,
  maxPx: number,
): number {
  let best = -1;
  let bestD2 = maxPx * maxPx;
  for (let i = 0; i < count; i++) {
    ndc.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!).project(camera);
    if (ndc.z >= 1 || ndc.z <= -1) continue;
    const dx = (ndc.x * 0.5 + 0.5) * size.width - px;
    const dy = (-ndc.y * 0.5 + 0.5) * size.height - py;
    const d2 = dx * dx + dy * dy;
    // Ties go to the later point: it is drawn on top.
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
