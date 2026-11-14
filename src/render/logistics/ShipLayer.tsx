import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type Group,
  Points,
  PointsMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { vec3 } from '../../sim/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { pixelsPerUnit, relativeToScene } from '../coords.ts';
import { placeLabel } from '../labelPlacement.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';
import { shipPosition } from './focus.ts';
import { shipLabelKey } from './LogisticsOverlay.tsx';
import { pickNearest } from './shipPicking.ts';

/** Marker size (CSS px). */
const SIZE_PX = 11;
/** Pointer distance (CSS px) within which a ship is picked. */
const PICK_PX = 8;
/** A press that moves further than this (CSS px) is a camera drag, not a click. */
const DRAG_PX = 4;
/** Docked ships fan out to the left of their site, this far apart (CSS px). */
const DOCK_START_PX = 14;
const DOCK_STEP_PX = 9;
const INITIAL_CAPACITY = 256;

const helio = vec3();
const scene = new Vector3();
const right = new Vector3();
const color = new Color();
/** Docked ships counted so far this frame, per site. */
const docked = new Map<string, number>();

/** One `Points` object for every ship, with room for `capacity` of them. */
function createShipPoints(capacity: number): Points {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 3), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(capacity * 3), 3));
  g.setDrawRange(0, 0);
  const material = new PointsMaterial({
    size: SIZE_PX,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  // A diamond with a dark rim, like the old DOM marker.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 q = abs(gl_PointCoord - 0.5) * 2.0;
      float d = q.x + q.y;
      if (d > 1.0) discard;
      diffuseColor.rgb *= mix(1.0, 0.25, smoothstep(0.7, 0.8, d));`,
    );
  };
  material.customProgramCacheKey = () => 'ship-points';
  const points = new Points(g, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  return points;
}

/**
 * All ship markers as one draw call. Each frame writes the visible ships' scene positions
 * and company colours; picking projects the same positions on the CPU. Only the selected and
 * hovered ships keep a DOM label (rendered by `LogisticsOverlay`, positioned here).
 */
export function ShipLayer() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const group = useRef<Group>(null);
  /** The live batch, and which ship each drawn point is. */
  const batch = useRef({ points: createShipPoints(INITIAL_CAPACITY), ids: [] as string[] });

  useEffect(() => {
    const g = group.current;
    const b = batch.current;
    g?.add(b.points);
    return () => {
      // The batch may have grown since mount: dispose whichever one is live.
      g?.remove(b.points);
      b.points.geometry.dispose();
      (b.points.material as PointsMaterial).dispose();
    };
  }, []);

  // Picking: pointer events on the canvas, ahead of R3F's own handlers on its wrapper.
  useEffect(() => {
    const canvas = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const pick = (e: MouseEvent): string | null => {
      const b = batch.current;
      const rect = canvas.getBoundingClientRect();
      const pos = b.points.geometry.attributes.position as BufferAttribute;
      const i = pickNearest(
        pos.array as Float32Array,
        b.points.geometry.drawRange.count,
        camera,
        { width: rect.width, height: rect.height },
        e.clientX - rect.left,
        e.clientY - rect.top,
        PICK_PX,
      );
      return i >= 0 ? (b.ids[i] ?? null) : null;
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return; // dragging the camera
      const id = pick(e);
      useSelectionStore.getState().setHoveredShip(id);
      canvas.style.cursor = id ? 'pointer' : '';
    };
    const onLeave = () => {
      useSelectionStore.getState().setHoveredShip(null);
      canvas.style.cursor = '';
    };
    const onClick = (e: MouseEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) return;
      const id = pick(e);
      if (!id) return;
      e.stopPropagation(); // the ship wins over the body behind it
      const store = useSelectionStore.getState();
      store.select({ kind: 'ship', id });
      if (e.type === 'dblclick') store.setFollow(true);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('dblclick', onClick);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onClick);
      canvas.style.cursor = '';
      useSelectionStore.getState().setHoveredShip(null);
    };
  }, [gl, camera]);

  useFrame(() => {
    const world = sim.logistics;
    const b = batch.current;
    if (!world) return;
    const { companyFilter, overlays, selected, hoveredShip } = useSelectionStore.getState();
    const selectedShip = selected?.kind === 'ship' ? selected.id : null;
    const selectedEl = selectedShip ? frame.labels.get(shipLabelKey(selectedShip)) : undefined;
    const hoveredEl = hoveredShip ? frame.labels.get(shipLabelKey(hoveredShip)) : undefined;
    let placedSelected = false;
    let placedHovered = false;

    if (world.ships.size > capacityOf(b.points)) {
      // Grow: a fresh batch twice the size (old buffers are disposed).
      const old = b.points;
      b.points = createShipPoints(2 ** Math.ceil(Math.log2(world.ships.size)));
      group.current?.remove(old);
      group.current?.add(b.points);
      old.geometry.dispose();
      (old.material as PointsMaterial).dispose();
    }
    const pos = b.points.geometry.attributes.position as BufferAttribute;
    const col = b.points.geometry.attributes.color as BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;

    right.setFromMatrixColumn(camera.matrixWorld, 0);
    docked.clear();
    const jd = sim.clock.jd;
    let n = 0;
    for (const ship of world.ships.values()) {
      const visible =
        overlays.ships &&
        ship.state !== 'building' &&
        (!companyFilter || ship.companyId === companyFilter || ship.id === selectedShip);
      if (!visible || !shipPosition(sim, ship, jd, helio)) continue;
      relativeToScene(helio, frame.origin, scene);
      if (ship.state === 'docked' || ship.state === 'waiting') {
        const key = ship.siteId ?? '';
        const k = docked.get(key) ?? 0;
        docked.set(key, k + 1);
        const ppu = pixelsPerUnit(
          camera as PerspectiveCamera,
          camera.position.distanceTo(scene),
          size.height,
        );
        scene.addScaledVector(right, -(DOCK_START_PX + k * DOCK_STEP_PX) / ppu);
      }
      pa[n * 3] = scene.x;
      pa[n * 3 + 1] = scene.y;
      pa[n * 3 + 2] = scene.z;
      color.set(world.companies.get(ship.companyId)?.color ?? '#ffffff');
      ca[n * 3] = color.r;
      ca[n * 3 + 1] = color.g;
      ca[n * 3 + 2] = color.b;
      b.ids[n] = ship.id;
      n++;
      if (ship.id === selectedShip && selectedEl) {
        placeLabel(selectedEl, scene, camera, size, true);
        placedSelected = true;
      }
      if (ship.id === hoveredShip && hoveredEl && hoveredEl !== selectedEl) {
        placeLabel(hoveredEl, scene, camera, size, true);
        placedHovered = true;
      }
    }
    b.ids.length = n;
    b.points.geometry.setDrawRange(0, n);
    pos.clearUpdateRanges();
    pos.addUpdateRange(0, n * 3);
    pos.needsUpdate = true;
    col.clearUpdateRanges();
    col.addUpdateRange(0, n * 3);
    col.needsUpdate = true;
    (b.points.material as PointsMaterial).size = SIZE_PX * gl.getPixelRatio();
    if (selectedEl && !placedSelected) placeLabel(selectedEl, scene, camera, size, false);
    if (hoveredEl && hoveredEl !== selectedEl && !placedHovered) {
      placeLabel(hoveredEl, scene, camera, size, false);
    }
  }, PRIORITY_SCENE);

  return <group ref={group} />;
}

const capacityOf = (p: Points) => (p.geometry.attributes.position as BufferAttribute).count;
