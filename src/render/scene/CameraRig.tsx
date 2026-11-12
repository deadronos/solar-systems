import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ComponentRef } from 'react';
import { AU_KM, type BodyDefinition } from '../../sim/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { UNITS_PER_KM } from '../coords.ts';
import { useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

const TRANSITION_SECONDS = 1.4;
/** Camera distance when following a ship (scene units = 1M km). */
const SHIP_VIEW_UNITS = 3;

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
  const follow = useSelectionStore((s) => s.follow);
  const followed = useSelectionStore((s) => (s.follow ? s.selected : null));
  const followKey = followed ? `${followed.kind}:${followed.id}` : '';
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

  // Following a ship/settlement: glide to a viewing distance suited to it.
  useEffect(() => {
    const c = controls.current;
    if (!c || !followKey || !followed) return;
    const world = sim.logistics;
    let to = SHIP_VIEW_UNITS;
    let min = 1e-6;
    if (followed.kind === 'settlement') {
      const s = world?.settlements.get(followed.id);
      const body = s ? sim.ephemeris.get(s.site.bodyId) : undefined;
      if (body) {
        to = viewDistance(body);
        min = body.radiusKm * UNITS_PER_KM * 1.15;
      }
    } else if (followed.kind === 'body' && sim.ephemeris.has(followed.id)) {
      const body = sim.ephemeris.get(followed.id);
      to = viewDistance(body);
      min = body.radiusKm * UNITS_PER_KM * 1.15;
    }
    c.minDistance = 1e-9;
    anim.current = { from: camera.position.length(), to, t: 0, minDistance: min };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey, sim, camera]);
  void follow;

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
