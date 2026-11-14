import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  LineBasicMaterial,
  LineSegments,
  NearestFilter,
  RGBAFormat,
  Vector3,
  type Group,
} from 'three';
import { vec3, type Simulation, type Vec3 } from '../../sim/index.ts';
import { evaluatePlan, type TrajectoryPlan } from '../../sim/logistics/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { relativeToScene, UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';

const SAMPLES = 256;
/** Vertices per trajectory: one segment (two vertices) between consecutive samples. */
const VERTS = (SAMPLES - 1) * 2;
const INITIAL_SLOTS = 64;
/** Brightness of the flown part right behind the ship, and far behind it. */
const TRAIL_NEAR = 0.7;
const TRAIL_FAR = 0.12;
/** The trail fades over this fraction of the trip. */
const TRAIL_SPAN = 0.4;

/**
 * Identity of a plan by value: in worker mode a ship that changes in any way (its stats tick
 * daily) arrives as a fresh copy carrying a fresh copy of the same plan.
 */
const planKey = (p: TrajectoryPlan) => `${p.fromSiteId}>${p.toSiteId}@${p.departJd}/${p.arriveJd}`;

interface Slot {
  index: number;
  key: string;
  departJd: number;
  arriveJd: number;
  /** Heliocentric km of the first sample: positions are stored relative to it. */
  anchor: Vec3;
  /** Frame on which the ship was last visible. */
  seen: number;
}

/**
 * The shader reads per-trajectory state from a 2-row float texture, one column per slot:
 * row 0 = anchor relative to the floating origin (scene units) and trip progress (0..1),
 * row 1 = company colour and visibility. The CPU writes `slots × 8` floats per frame.
 */
function trajectoryMaterial(slots: DataTexture): LineBasicMaterial {
  const material = new LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSlots = { value: slots };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aFrac;
        attribute float aSlot;
        uniform sampler2D uSlots;
        varying float vLag;
        varying float vVis;
        varying vec3 vTrajColor;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 slotA = texelFetch(uSlots, ivec2(int(aSlot), 0), 0);
        vec4 slotB = texelFetch(uSlots, ivec2(int(aSlot), 1), 0);
        transformed += slotA.xyz;
        vLag = slotA.w - aFrac;
        vVis = slotB.a;
        vTrajColor = slotB.rgb;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vLag;
        varying float vVis;
        varying vec3 vTrajColor;`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `if (vVis < 0.5) discard;
        // Ahead of the ship: full colour. Behind it: a trail that fades with distance.
        float trail = mix(${TRAIL_NEAR.toFixed(2)}, ${TRAIL_FAR.toFixed(2)},
          smoothstep(0.0, ${TRAIL_SPAN.toFixed(2)}, vLag));
        vec4 diffuseColor = vec4( vTrajColor * (vLag > 0.0 ? trail : 1.0), opacity );`,
      );
  };
  material.customProgramCacheKey = () => 'trajectory-batch';
  return material;
}

/** Geometry, slot texture and material for `capacity` trajectories. */
function createBatch(capacity: number) {
  const g = new BufferGeometry();
  const frac = new Float32Array(capacity * VERTS);
  const slot = new Float32Array(capacity * VERTS);
  for (let s = 0; s < capacity; s++) {
    for (let k = 0; k < SAMPLES - 1; k++) {
      const v = s * VERTS + k * 2;
      frac[v] = k / (SAMPLES - 1);
      frac[v + 1] = (k + 1) / (SAMPLES - 1);
      slot[v] = slot[v + 1] = s;
    }
  }
  g.setAttribute('position', new BufferAttribute(new Float32Array(capacity * VERTS * 3), 3));
  g.setAttribute('aFrac', new BufferAttribute(frac, 1));
  g.setAttribute('aSlot', new BufferAttribute(slot, 1));
  g.setDrawRange(0, 0);
  const texture = new DataTexture(
    new Float32Array(capacity * 2 * 4),
    capacity,
    2,
    RGBAFormat,
    FloatType,
  );
  texture.magFilter = texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  const lines = new LineSegments(g, trajectoryMaterial(texture));
  lines.frustumCulled = false;
  return {
    capacity,
    lines,
    texture,
    slots: new Map<string, Slot>(),
    free: Array.from({ length: capacity }, (_, i) => capacity - 1 - i),
    dispose() {
      g.dispose();
      texture.dispose();
      (lines.material as LineBasicMaterial).dispose();
    },
  };
}
type Batch = ReturnType<typeof createBatch>;

const sample = vec3();
const color = new Color();
const anchorScene = new Vector3();

function writeColor(b: Batch, slot: Slot, hex: string): void {
  color.set(hex);
  const t = b.texture.image.data as Float32Array;
  const c = (b.capacity + slot.index) * 4;
  t[c] = color.r;
  t[c + 1] = color.g;
  t[c + 2] = color.b;
}

/** Write a plan's samples into its slot, relative to its first sample (float64 → float32). */
function upload(b: Batch, slot: Slot, plan: TrajectoryPlan, eph: Simulation['ephemeris']) {
  const pos = b.lines.geometry.attributes.position as BufferAttribute;
  const pa = pos.array as Float32Array;
  const base = slot.index * VERTS * 3;
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = plan.departJd + ((plan.arriveJd - plan.departJd) * i) / (SAMPLES - 1);
    evaluatePlan(plan, t, eph, sample);
    if (i === 0) Object.assign(slot.anchor, sample);
    // Ecliptic (x, y, z) → scene (x, z, −y), in scene units.
    const x = (sample.x - slot.anchor.x) * UNITS_PER_KM;
    const y = (sample.z - slot.anchor.z) * UNITS_PER_KM;
    const z = -(sample.y - slot.anchor.y) * UNITS_PER_KM;
    if (i > 0) {
      const v = base + (i - 1) * 6;
      pa[v] = px;
      pa[v + 1] = py;
      pa[v + 2] = pz;
      pa[v + 3] = x;
      pa[v + 4] = y;
      pa[v + 5] = z;
    }
    px = x;
    py = y;
    pz = z;
  }
  pos.addUpdateRange(base, VERTS * 3);
  pos.needsUpdate = true;
}

/**
 * Planned paths of the selected ship, plus every (filtered) ship in flight when "all routes"
 * is on, as one `LineSegments` draw call. Each plan is uploaded once into a fixed slot; per
 * frame the CPU only rewrites the slot texture (anchor and progress per trajectory).
 */
export function TrajectoryLayer() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const group = useRef<Group>(null);
  const batch = useRef<Batch | null>(null);
  const frameNo = useRef(0);

  useEffect(
    () => () => {
      batch.current?.lines.removeFromParent();
      batch.current?.dispose();
      batch.current = null;
    },
    [],
  );

  useFrame(() => {
    const world = sim.logistics;
    if (!world || !group.current) return;
    if (!batch.current) {
      batch.current = createBatch(INITIAL_SLOTS);
      group.current.add(batch.current.lines);
    }
    frameNo.current++;
    batch.current = update(batch.current, group.current, sim, frame.origin, frameNo.current);
  }, PRIORITY_SCENE);

  return <group ref={group} />;
}

/** One frame: (re)assign slots, upload changed plans, write the slot texture. */
function update(b: Batch, group: Group, sim: Simulation, origin: Vec3, now: number): Batch {
  const world = sim.logistics!;
  const { selected, overlays, companyFilter } = useSelectionStore.getState();
  const selectedShip = selected?.kind === 'ship' ? selected.id : null;

  // Assign slots to visible trajectories; upload new or changed plans.
  for (const ship of world.ships.values()) {
    const plan = ship.plan;
    if (!plan) continue;
    const visible =
      ship.id === selectedShip ||
      (overlays.allTrajectories && (!companyFilter || ship.companyId === companyFilter));
    if (!visible) continue;
    let slot = b.slots.get(ship.id);
    if (!slot) {
      if (b.free.length === 0) b = grow(b, group);
      slot = { index: b.free.pop()!, key: '', departJd: 0, arriveJd: 0, anchor: vec3(), seen: 0 };
      b.slots.set(ship.id, slot);
    }
    slot.seen = now;
    const key = planKey(plan);
    if (slot.key !== key) {
      slot.key = key;
      slot.departJd = plan.departJd;
      slot.arriveJd = plan.arriveJd;
      upload(b, slot, plan, sim.ephemeris);
      writeColor(b, slot, world.companies.get(ship.companyId)?.color ?? '#ffffff');
    }
  }

  // Per-frame slot state; free slots whose ship is no longer shown.
  const t = b.texture.image.data as Float32Array;
  const jd = sim.clock.jd;
  let top = 0;
  for (const [id, slot] of b.slots) {
    const row1 = (b.capacity + slot.index) * 4;
    if (slot.seen !== now) {
      t[row1 + 3] = 0;
      b.slots.delete(id);
      b.free.push(slot.index);
      continue;
    }
    relativeToScene(slot.anchor, origin, anchorScene);
    const row0 = slot.index * 4;
    t[row0] = anchorScene.x;
    t[row0 + 1] = anchorScene.y;
    t[row0 + 2] = anchorScene.z;
    t[row0 + 3] = (jd - slot.departJd) / Math.max(slot.arriveJd - slot.departJd, 1e-9);
    t[row1 + 3] = 1;
    top = Math.max(top, slot.index + 1);
  }
  b.texture.needsUpdate = true;
  b.lines.geometry.setDrawRange(0, top * VERTS);
  return b;
}

/** Replace a full batch with one twice the size; plans re-upload on the next pass. */
function grow(old: Batch, group: Group): Batch {
  const b = createBatch(old.capacity * 2);
  group.remove(old.lines);
  group.add(b.lines);
  old.dispose();
  // Keep slot numbers: they are all below the old capacity.
  b.free = b.free.filter((i) => i >= old.capacity);
  for (const [id, slot] of old.slots) {
    slot.key = '';
    b.slots.set(id, slot);
  }
  return b;
}
