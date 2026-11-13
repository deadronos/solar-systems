import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, type Points, type PointsMaterial } from 'three';
import type { Belt } from '../../sim/index.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { BELT_COLORS } from '../appearance.ts';
import { eclipticToScene, UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { createKeplerPointsMaterial, keplerUniforms } from './beltShader.ts';
import { PRIORITY_SCENE } from './SimDriver.tsx';

/** Re-anchor the GPU epoch after this many days, keeping `uDt` small for float32. */
const REBASE_DAYS = 365;

/**
 * Renders a belt as a point cloud; every particle follows its own Kepler orbit, solved in the
 * vertex shader. Per frame the CPU only sets one uniform and the cloud's offset from the
 * floating origin; once a simulated year it refreshes the mean anomalies (float64 → float32).
 */
export function BeltPoints({ belt }: { belt: Belt }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const orbits = belt.orbits;
  const epoch = useRef(Number.NaN);
  const ref = useRef<Points>(null);

  const geometry = useMemo(() => {
    const { count, P, Q, n, e } = orbits;
    const pos = new Float32Array(count * 3);
    const q = new Float32Array(count * 3);
    const kep = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const o = k * 3;
      // Ecliptic (x, y, z) → scene (x, z, −y), in scene units.
      pos[o] = P[o]! * UNITS_PER_KM;
      pos[o + 1] = P[o + 2]! * UNITS_PER_KM;
      pos[o + 2] = -P[o + 1]! * UNITS_PER_KM;
      q[o] = Q[o]! * UNITS_PER_KM;
      q[o + 1] = Q[o + 2]! * UNITS_PER_KM;
      q[o + 2] = -Q[o + 1]! * UNITS_PER_KM;
      kep[o + 1] = n[k]!;
      kep[o + 2] = e[k]!;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aQ', new BufferAttribute(q, 3));
    g.setAttribute('aKep', new BufferAttribute(kep, 3));
    return g;
  }, [orbits]);

  const material = useMemo(
    () =>
      createKeplerPointsMaterial({
        color: BELT_COLORS[belt.def.id] ?? '#aaaaaa',
        size: 1.6,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }).material,
    [belt.def.id],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(() => {
    const points = ref.current;
    if (!points) return;
    points.visible = useViewStore.getState().layers.belts;
    if (!points.visible) return;
    const jd = sim.ephemeris.jd;
    if (!(Math.abs(jd - epoch.current) <= REBASE_DAYS)) {
      epoch.current = jd;
      const kep = points.geometry.attributes.aKep as BufferAttribute;
      orbits.meanAnomaliesAt(jd, kep.array as Float32Array, 3, 0);
      kep.needsUpdate = true;
    }
    keplerUniforms(points.material as PointsMaterial).uDt.value = jd - epoch.current;
    // The cloud is heliocentric; shift it by the floating origin (float64 on the CPU).
    const o = frame.origin;
    eclipticToScene(-o.x, -o.y, -o.z, points.position);
  }, PRIORITY_SCENE);

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} />;
}
