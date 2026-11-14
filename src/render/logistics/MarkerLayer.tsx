import { useFrame, useThree } from '@react-three/fiber';
import { Vector3, type PerspectiveCamera } from 'three';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { pixelsPerUnit, relativeToScene } from '../coords.ts';
import { placeLabel } from '../labelPlacement.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';
import { settlementLabelKey } from './LogisticsOverlay.tsx';

const scene = new Vector3();
const parent = new Vector3();
/** Moon settlements closer than this (px) to their planet stack under the planet. */
const MERGE_PX = 40;
/** Vertical spacing (px) between markers stacked at the same body. */
const STACK_PX = 15;
/** Settlement markers sit below the body's own label. */
const SITE_OFFSET_PX = 14;

/** Positions the settlement markers every frame (ships: `ShipLayer`). */
export function MarkerLayer() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  useFrame(() => {
    const world = sim.logistics;
    if (!world) return;
    const shortages = useSelectionStore.getState().overlays.shortages;

    // Settlements: stacked under their body.
    const perBody = new Map<string, number>();
    for (const s of world.settlements.values()) {
      const el = frame.labels.get(settlementLabelKey(s.id));
      if (!el) continue;
      // Moons too close to their planet on screen share the planet's stack.
      const body = sim.ephemeris.get(s.site.bodyId);
      let stackBody = s.site.bodyId;
      relativeToScene(sim.ephemeris.position(s.site.bodyId), frame.origin, scene);
      if (body.parentId && body.parentId !== 'sun') {
        relativeToScene(sim.ephemeris.position(body.parentId), frame.origin, parent);
        const ppu = pixelsPerUnit(
          camera as PerspectiveCamera,
          camera.position.distanceTo(parent),
          size.height,
        );
        if (parent.distanceTo(scene) * ppu < MERGE_PX) {
          stackBody = body.parentId;
          scene.copy(parent);
        }
      }
      const n = perBody.get(stackBody) ?? 0;
      perBody.set(stackBody, n + 1);
      placeLabel(el, scene, camera, size, true, 0, SITE_OFFSET_PX + n * STACK_PX);
      const state =
        !shortages || s.isDeepMarket
          ? ''
          : s.inShortage
            ? 'bad'
            : s.satisfaction.survival < 0.97
              ? 'warn'
              : 'ok';
      if (el.dataset.health !== state) el.dataset.health = state;
    }
  }, PRIORITY_SCENE);

  return null;
}
