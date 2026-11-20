import { useFrame, useThree } from '@react-three/fiber';
import { Vector3, type PerspectiveCamera } from 'three';
import type { Settlement } from '../../sim/logistics/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { pixelsPerUnit, relativeToScene, UNITS_PER_KM } from '../coords.ts';
import { placeLabel } from '../labelPlacement.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';
import { clusterLabelKey, settlementLabelKey } from './LogisticsOverlay.tsx';

const scene = new Vector3();
const parent = new Vector3();
/** Moon settlements closer than this (px) to their planet stack under the planet. */
const MERGE_PX = 40;
/** Vertical spacing (px) between markers stacked at the same body. */
const STACK_PX = 15;
/** Settlement markers sit below the body's own label. */
const SITE_OFFSET_PX = 14;
/** Collapse a multi-site stack into a single badge while the host body is smaller than this (px). */
const CLUSTER_EXPAND_RADIUS_PX = 10;

type Health = '' | 'ok' | 'warn' | 'bad';
const HEALTH_RANK: Record<Health, number> = { '': 0, ok: 1, warn: 2, bad: 3 };

function settlementHealth(s: Settlement, shortages: boolean): Health {
  if (!shortages || s.isDeepMarket) return '';
  if (s.inShortage) return 'bad';
  return s.satisfaction.survival < 0.97 ? 'warn' : 'ok';
}

interface StackEntry {
  settlement: Settlement;
  el: HTMLElement;
  health: Health;
}

/** Positions the settlement markers every frame (ships: `ShipLayer`). */
export function MarkerLayer() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  useFrame(() => {
    const world = sim.logistics;
    if (!world) return;
    const { overlays, selected } = useSelectionStore.getState();
    const shortages = overlays.shortages;
    const selectedSettlement = selected?.kind === 'settlement' ? selected.id : null;

    // Group settlements by the body they currently stack under.
    const stacks = new Map<string, StackEntry[]>();
    const clusterBodies = new Set<string>();
    for (const s of world.settlements.values()) {
      const body = sim.ephemeris.get(s.site.bodyId);
      clusterBodies.add(s.site.bodyId);
      if (body.parentId && body.parentId !== 'sun') clusterBodies.add(body.parentId);
      const el = frame.labels.get(settlementLabelKey(s.id));
      if (!el) continue;

      let stackBody = s.site.bodyId;
      relativeToScene(sim.ephemeris.position(s.site.bodyId), frame.origin, scene);
      if (body.parentId && body.parentId !== 'sun') {
        relativeToScene(sim.ephemeris.position(body.parentId), frame.origin, parent);
        const ppu = pixelsPerUnit(
          camera as PerspectiveCamera,
          camera.position.distanceTo(parent),
          size.height,
        );
        if (parent.distanceTo(scene) * ppu < MERGE_PX) stackBody = body.parentId;
      }

      const health = settlementHealth(s, shortages);
      const list = stacks.get(stackBody);
      const entry: StackEntry = { settlement: s, el, health };
      if (list) list.push(entry);
      else stacks.set(stackBody, [entry]);
    }

    for (const bodyId of clusterBodies) {
      const entries = stacks.get(bodyId);
      const clusterEl = frame.labels.get(clusterLabelKey(bodyId));
      if (!entries || entries.length === 0) {
        if (clusterEl) placeLabel(clusterEl, scene, camera, size, false);
        continue;
      }

      const body = sim.ephemeris.get(bodyId);
      relativeToScene(sim.ephemeris.position(bodyId), frame.origin, scene);
      const ppu = pixelsPerUnit(
        camera as PerspectiveCamera,
        camera.position.distanceTo(scene),
        size.height,
      );
      const bodyRadiusPx = body.radiusKm * UNITS_PER_KM * ppu;
      const hasSelected =
        selectedSettlement !== null && entries.some((e) => e.settlement.id === selectedSettlement);
      const collapsed =
        !!clusterEl &&
        entries.length >= 2 &&
        !hasSelected &&
        bodyRadiusPx < CLUSTER_EXPAND_RADIUS_PX;

      if (collapsed && clusterEl) {
        let worst: Health = '';
        for (const e of entries) {
          placeLabel(e.el, scene, camera, size, false);
          if (HEALTH_RANK[e.health] > HEALTH_RANK[worst]) worst = e.health;
        }
        const label = `${entries.length} sites`;
        const span = clusterEl.firstElementChild;
        if (span && span.textContent !== label) span.textContent = label;
        if (clusterEl.dataset.health !== worst) clusterEl.dataset.health = worst;
        placeLabel(clusterEl, scene, camera, size, true, 0, SITE_OFFSET_PX);
      } else {
        if (clusterEl) placeLabel(clusterEl, scene, camera, size, false);
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          placeLabel(e.el, scene, camera, size, true, 0, SITE_OFFSET_PX + i * STACK_PX);
          if (e.el.dataset.health !== e.health) e.el.dataset.health = e.health;
        }
      }
    }
  }, PRIORITY_SCENE);

  return null;
}
