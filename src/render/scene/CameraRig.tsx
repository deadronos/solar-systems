import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ComponentRef } from 'react';
import { AU_KM, type BodyDefinition } from '../../sim/index.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { UNITS_PER_KM } from '../coords.ts';
import { useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

const TRANSITION_SECONDS = 1.4;

/** Good viewing distance when focusing a body (scene units). */
function viewDistance(def: BodyDefinition): number {
  if (def.kind === 'star') return 3.2 * AU_KM * UNITS_PER_KM; // inner system overview
  return def.radiusKm * UNITS_PER_KM * (def.radiusKm < 100 ? 12 : 6);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Orbit camera around the floating origin (= the focused body, always at 0,0,0).
 * Focus changes animate the camera distance logarithmically, which reads well across the
 * ~10 orders of magnitude between Phobos and the Kuiper belt.
 */
export function CameraRig() {
  const sim = useSimulation();
  const camera = useThree((s) => s.camera);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const focusId = useViewStore((s) => s.focusId);
  const anim = useRef<{ from: number; to: number; t: number; minDistance: number } | null>(null);

  useEffect(() => {
    const def = sim.ephemeris.get(focusId);
    const c = controls.current;
    if (!c) return;
    c.minDistance = 1e-9;
    anim.current = {
      from: camera.position.length(),
      to: viewDistance(def),
      t: 0,
      minDistance: def.radiusKm * UNITS_PER_KM * 1.15,
    };
  }, [focusId, sim, camera]);

  useFrame((_, dt) => {
    const a = anim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / TRANSITION_SECONDS);
    const d = Math.exp(Math.log(a.from) + (Math.log(a.to) - Math.log(a.from)) * ease(a.t));
    camera.position.setLength(d);
    if (a.t >= 1) {
      if (controls.current) controls.current.minDistance = a.minDistance;
      anim.current = null;
    }
  }, PRIORITY_SCENE);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      zoomSpeed={1.6}
      rotateSpeed={0.6}
      maxDistance={2e5}
      target={[0, 0, 0]}
    />
  );
}
