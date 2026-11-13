import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useRef, type ComponentRef } from 'react';
import { AU_KM, type BodyDefinition, type Simulation } from '../../sim/index.ts';
import { useSelectionStore, type EntityRef } from '../../state/selectionStore.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { UNITS_PER_KM } from '../coords.ts';
import { cameraTarget, entityAnchorBody, trackedShip } from '../logistics/focus.ts';
import { useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

const TRANSITION_SECONDS = 1.4;
/** Camera distance when following a ship in flight (scene units = 1M km). */
const SHIP_VIEW_UNITS = 3;
/** Closest approach to a ship in flight (scene units). */
const SHIP_MIN_UNITS = 1e-6;

/** Good viewing distance when focusing a body (scene units). */
function viewDistance(def: BodyDefinition): number {
  if (def.kind === 'star') return 3.2 * AU_KM * UNITS_PER_KM; // inner system overview
  return def.radiusKm * UNITS_PER_KM * (def.radiusKm < 100 ? 12 : 6);
}

interface View {
  distance: number;
  minDistance: number;
}

const bodyView = (def: BodyDefinition): View => ({
  distance: viewDistance(def),
  minDistance: def.radiusKm * UNITS_PER_KM * 1.15,
});

/**
 * Viewing distance for a camera target: entities sitting at a body (settlements, docked or
 * waiting ships) are framed like that body, ships in flight get a close-up, and entities that
 * no longer exist fall back to the focused body (where `resolveFocusPosition` puts the origin).
 */
function viewFor(sim: Simulation, target: EntityRef, anchor: string | null, focusId: string): View {
  if (anchor) return bodyView(sim.ephemeris.get(anchor));
  if (trackedShip(sim, target)) return { distance: SHIP_VIEW_UNITS, minDistance: SHIP_MIN_UNITS };
  return bodyView(sim.ephemeris.get(focusId));
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Orbit camera around the floating origin (= the camera target, always at 0,0,0).
 * Whenever the target changes — a new focus body, following or unfollowing an entity, or a
 * followed ship docking / departing — the camera distance animates logarithmically, which reads
 * well across the ~10 orders of magnitude between Phobos and the Kuiper belt.
 */
export function CameraRig() {
  const sim = useSimulation();
  const camera = useThree((s) => s.camera);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const anim = useRef<{ from: number; to: number; t: number; minDistance: number } | null>(null);
  const lastKey = useRef<string | null>(null);

  useFrame((_, dt) => {
    const c = controls.current;
    const { follow, selected } = useSelectionStore.getState();
    const { focusId } = useViewStore.getState();
    const target = cameraTarget(follow, selected, focusId);
    const anchor = entityAnchorBody(sim, target);
    const key = `${target.kind}:${target.id}@${anchor ?? ''}`;
    if (key !== lastKey.current) {
      lastKey.current = key;
      const view = viewFor(sim, target, anchor, focusId);
      if (c) c.minDistance = 1e-9;
      anim.current = {
        from: camera.position.length(),
        to: view.distance,
        t: 0,
        minDistance: view.minDistance,
      };
    }

    const a = anim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / TRANSITION_SECONDS);
    const d = Math.exp(Math.log(a.from) + (Math.log(a.to) - Math.log(a.from)) * ease(a.t));
    camera.position.setLength(d);
    if (a.t >= 1) {
      if (c) c.minDistance = a.minDistance;
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
