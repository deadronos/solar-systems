import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { pickNearest } from './shipPicking.ts';

describe('pickNearest', () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const size = { width: 200, height: 200 };
  // At z = 0 (10 units away, 90° fov) the view spans ±10 units: 10 px per unit.
  const points = new Float32Array([0, 0, 0, 5, 0, 0, 0, 0, 20]);

  it('finds the nearest point on screen within the radius', () => {
    expect(pickNearest(points, 3, camera, size, 102, 98, 8)).toBe(0);
    expect(pickNearest(points, 3, camera, size, 151, 100, 8)).toBe(1);
  });

  it('misses beyond the radius, past count, and behind the camera', () => {
    expect(pickNearest(points, 3, camera, size, 125, 100, 8)).toBe(-1);
    expect(pickNearest(points, 1, camera, size, 150, 100, 8)).toBe(-1);
    const behind = new Float32Array([0, 0, 20]);
    expect(pickNearest(behind, 1, camera, size, 100, 100, 50)).toBe(-1);
  });
});
