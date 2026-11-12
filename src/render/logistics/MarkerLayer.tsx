import { useFrame, useThree } from '@react-three/fiber';
import { Vector3, type PerspectiveCamera } from 'three';
import { vec3 } from '../../sim/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { pixelsPerUnit, relativeToScene } from '../coords.ts';
import { placeLabel } from '../labelPlacement.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';
import { shipPosition } from './focus.ts';
import { settlementLabelKey, shipLabelKey } from './LogisticsOverlay.tsx';

const helio = vec3();
const scene = new Vector3();
const parent = new Vector3();
/** Moon settlements closer than this (px) to their planet stack under the planet. */
const MERGE_PX = 40;
/** Vertical spacing (px) between markers stacked at the same body. */
const STACK_PX = 15;
/** Settlement markers sit below the body's own label. */
const SITE_OFFSET_PX = 14;

/** Positions the DOM markers for settlements and ships every frame. */
export function MarkerLayer() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  useFrame(() => {
    const world = sim.logistics;
    if (!world) return;
    const { companyFilter, overlays, selected } = useSelectionStore.getState();
    const shortages = overlays.shortages;

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

    // Ships: docked ships fan out to the right of their site.
    const docked = new Map<string, number>();
    const jd = sim.clock.jd;
    for (const ship of world.ships.values()) {
      const el = frame.labels.get(shipLabelKey(ship.id));
      if (!el) continue;
      const visible =
        overlays.ships &&
        ship.state !== 'building' &&
        (!companyFilter ||
          ship.companyId === companyFilter ||
          (selected?.kind === 'ship' && selected.id === ship.id));
      if (!visible || !shipPosition(sim, ship, jd, helio)) {
        placeLabel(el, scene, camera, size, false);
        continue;
      }
      let dx = 0;
      if (ship.state === 'docked' || ship.state === 'waiting') {
        const key = ship.siteId ?? '';
        const n = docked.get(key) ?? 0;
        docked.set(key, n + 1);
        dx = -14 - n * 9;
      }
      relativeToScene(helio, frame.origin, scene);
      placeLabel(el, scene, camera, size, true, dx, 0);
    }
  }, PRIORITY_SCENE);

  return null;
}
