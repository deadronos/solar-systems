import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from 'three';
import { vec3 } from '../../sim/index.ts';
import {
  evaluatePlan,
  type LogisticsWorld,
  type TrajectoryPlan,
} from '../../sim/logistics/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { relativeToScene, UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';
import { usePolledKeyed } from './usePolled.ts';

const SAMPLES = 256;
const PAST_DIM = 0.25;

/** Ships whose planned paths are drawn: the selected ship, plus all (filtered) ships in flight. */
function visibleIds(world: LogisticsWorld): string[] {
  const { selected, overlays, companyFilter } = useSelectionStore.getState();
  const ids = new Set<string>();
  if (selected?.kind === 'ship' && world.ships.get(selected.id)?.plan) ids.add(selected.id);
  if (overlays.allTrajectories) {
    for (const s of world.ships.values()) {
      if (s.plan && (!companyFilter || s.companyId === companyFilter)) ids.add(s.id);
    }
  }
  return [...ids].toSorted();
}

export function TrajectoryLayer() {
  const sim = useSimulation();
  const world = sim.logistics;
  const ids = usePolledKeyed(
    () => (world ? visibleIds(world) : []),
    (v) => v.join(','),
    4,
  );
  if (!world) return null;
  return (
    <>
      {ids.map((id) => (
        <Trajectory key={id} shipId={id} />
      ))}
    </>
  );
}

/**
 * Identity of a plan by value: the economy may live in a worker, in which case every update
 * brings a fresh copy of the same plan.
 */
const planKey = (p: TrajectoryPlan) => `${p.fromSiteId}>${p.toSiteId}@${p.departJd}/${p.arriveJd}`;

/**
 * A line material that dims the part of the path already flown on the GPU: each vertex
 * carries its time (days after departure) and `uNow` is the clock, so the CPU only sets two
 * uniforms per frame.
 */
function trajectoryMaterial(): { material: LineBasicMaterial; uNow: { value: number } } {
  const uNow = { value: 0 };
  const material = new LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNow = uNow;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aTime;\nuniform float uNow;\nvarying float vPast;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPast = step(aTime, uNow);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPast;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse * mix( 1.0, ${PAST_DIM.toFixed(2)}, vPast ), opacity );`,
      );
  };
  material.customProgramCacheKey = () => 'trajectory';
  material.userData.uNow = uNow;
  return { material, uNow };
}

function Trajectory({ shipId }: { shipId: string }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const line = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(SAMPLES * 3), 3));
    g.setAttribute('aTime', new BufferAttribute(new Float32Array(SAMPLES), 1));
    const l = new Line(g, trajectoryMaterial().material);
    l.frustumCulled = false;
    return l;
  }, []);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    },
    [line],
  );
  const ref = useRef<Line>(null);
  /** Plan currently uploaded, and its heliocentric anchor (km; the first sample). */
  const state = useRef({ key: '', departJd: 0, anchor: vec3() });

  useFrame(() => {
    const l = ref.current;
    const world = sim.logistics;
    const ship = world?.ships.get(shipId);
    if (!l || !ship?.plan) {
      if (l) l.visible = false;
      return;
    }
    l.visible = true;
    const plan = ship.plan;
    const s = state.current;
    const key = planKey(plan);
    if (s.key !== key) {
      // Upload once per plan: float64 samples relative to the anchor, then float32.
      s.key = key;
      s.departJd = plan.departJd;
      const pos = l.geometry.attributes.position as BufferAttribute;
      const time = l.geometry.attributes.aTime as BufferAttribute;
      const pa = pos.array as Float32Array;
      const ta = time.array as Float32Array;
      const p = vec3();
      for (let i = 0; i < SAMPLES; i++) {
        const t = plan.departJd + ((plan.arriveJd - plan.departJd) * i) / (SAMPLES - 1);
        evaluatePlan(plan, t, sim.ephemeris, p);
        if (i === 0) Object.assign(s.anchor, p);
        // Ecliptic (x, y, z) → scene (x, z, −y), in scene units.
        pa[i * 3] = (p.x - s.anchor.x) * UNITS_PER_KM;
        pa[i * 3 + 1] = (p.z - s.anchor.z) * UNITS_PER_KM;
        pa[i * 3 + 2] = -(p.y - s.anchor.y) * UNITS_PER_KM;
        ta[i] = t - plan.departJd;
      }
      pos.needsUpdate = true;
      time.needsUpdate = true;
      const company = world!.companies.get(ship.companyId);
      (l.material as LineBasicMaterial).color.set(company?.color ?? '#ffffff');
    }
    relativeToScene(s.anchor, frame.origin, l.position);
    (l.material as LineBasicMaterial).userData.uNow.value = sim.clock.jd - s.departJd;
  }, PRIORITY_SCENE);

  return <primitive ref={ref} object={line} />;
}
