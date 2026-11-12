import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  type PerspectiveCamera,
} from 'three';
import type { BodyDefinition } from '../../sim/index.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { pixelsPerUnit, relativeToScene, UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

/** Enough segments that chord error stays well below planet radii even at 30 AU. */
const SEGMENTS = 1024;
/** Hide orbits that would be smaller than this on screen (px, semi-major axis). */
const MIN_ORBIT_PX = 10;

export function OrbitPath({ def, color }: { def: BodyDefinition; color: string }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const lastJd = useRef(Number.NaN);
  const isMoon = def.kind === 'moon';

  const ref = useRef<Line>(null);
  const line = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const material = new LineBasicMaterial({
      color,
      transparent: true,
      opacity: isMoon ? 0.35 : 0.45,
      depthWrite: false,
    });
    return new Line(geometry, material);
  }, [color, isMoon]);

  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    },
    [line],
  );

  useFrame(() => {
    const l = ref.current;
    if (!l) return;
    const { layers } = useViewStore.getState();
    const enabled = layers.orbits && (!isMoon || layers.moonOrbits);
    if (!enabled || !def.parentId) {
      l.visible = false;
      return;
    }
    const eph = sim.ephemeris;
    relativeToScene(eph.position(def.parentId), frame.origin, l.position);

    // Hide orbits too small to read at the current zoom.
    const semiMajor = eph.semiMajorAxisKm(def.id) * UNITS_PER_KM;
    const ppu = pixelsPerUnit(camera, camera.position.distanceTo(l.position), size.height);
    l.visible = semiMajor * ppu > MIN_ORBIT_PX;
    if (!l.visible) return;

    // Rebuild geometry on first use and when secular drift has accumulated.
    const period = eph.orbitalPeriodDays(def.id) ?? 1;
    const stale =
      Number.isNaN(lastJd.current) ||
      (eph.orbitDrifts(def.id) && Math.abs(eph.jd - lastJd.current) > period / 8);
    if (stale) {
      lastJd.current = eph.jd;
      const pts = eph.orbitPath(def.id, SEGMENTS);
      const attr = l.geometry.attributes.position as BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let k = 0; k < pts.length; k += 3) {
        arr[k] = pts[k]! * UNITS_PER_KM;
        arr[k + 1] = pts[k + 2]! * UNITS_PER_KM;
        arr[k + 2] = -pts[k + 1]! * UNITS_PER_KM;
      }
      attr.needsUpdate = true;
      l.geometry.computeBoundingSphere();
    }
  }, PRIORITY_SCENE);

  return <primitive ref={ref} object={line} frustumCulled={false} />;
}
