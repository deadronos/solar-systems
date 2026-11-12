import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, type Points } from 'three';
import type { Belt } from '../../sim/index.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { BELT_COLORS } from '../appearance.ts';
import { UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

/** Renders a belt as a point cloud; every particle is propagated on its own Kepler orbit. */
export function BeltPoints({ belt }: { belt: Belt }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const count = belt.orbits.count;
  const helio = useMemo(() => new Float64Array(count * 3), [count]);
  const last = useRef({ jd: Number.NaN, ox: 0, oy: 0, oz: 0 });

  const ref = useRef<Points>(null);
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const points = ref.current;
    if (!points) return;
    points.visible = useViewStore.getState().layers.belts;
    if (!points.visible) return;
    const jd = sim.ephemeris.jd;
    const o = frame.origin;
    const l = last.current;
    if (jd === l.jd && o.x === l.ox && o.y === l.oy && o.z === l.oz) return;
    if (jd !== l.jd) belt.orbits.propagate(jd, helio);
    l.jd = jd;
    l.ox = o.x;
    l.oy = o.y;
    l.oz = o.z;

    const attr = points.geometry.attributes.position as BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let k = 0; k < helio.length; k += 3) {
      arr[k] = (helio[k]! - o.x) * UNITS_PER_KM;
      arr[k + 1] = (helio[k + 2]! - o.z) * UNITS_PER_KM;
      arr[k + 2] = -(helio[k + 1]! - o.y) * UNITS_PER_KM;
    }
    attr.needsUpdate = true;
  }, PRIORITY_SCENE);

  return (
    <points ref={ref} geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        color={BELT_COLORS[belt.def.id] ?? '#aaaaaa'}
        size={1.6}
        sizeAttenuation={false}
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </points>
  );
}
