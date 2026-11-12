import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, Color, Line, LineBasicMaterial } from 'three';
import { vec3 } from '../../sim/index.ts';
import {
  evaluatePlan,
  type LogisticsWorld,
  type TrajectoryPlan,
} from '../../sim/logistics/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { UNITS_PER_KM } from '../coords.ts';
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

function Trajectory({ shipId }: { shipId: string }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const cache = useRef<{ plan: TrajectoryPlan | null; samples: Float64Array; times: Float64Array }>(
    {
      plan: null,
      samples: new Float64Array(SAMPLES * 3),
      times: new Float64Array(SAMPLES),
    },
  );
  const line = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(SAMPLES * 3), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(SAMPLES * 3), 3));
    const m = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const l = new Line(g, m);
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
  const color = useMemo(() => new Color(), []);
  const p = useMemo(() => vec3(), []);

  useFrame(() => {
    const l = ref.current;
    const world = sim.logistics;
    const ship = world?.ships.get(shipId);
    if (!l || !ship?.plan) {
      if (l) l.visible = false;
      return;
    }
    l.visible = true;
    const c = cache.current;
    if (c.plan !== ship.plan) {
      // Resample in heliocentric float64 once per plan.
      c.plan = ship.plan;
      const { departJd, arriveJd } = ship.plan;
      for (let i = 0; i < SAMPLES; i++) {
        const t = departJd + ((arriveJd - departJd) * i) / (SAMPLES - 1);
        c.times[i] = t;
        evaluatePlan(ship.plan, t, sim.ephemeris, p);
        c.samples[i * 3] = p.x;
        c.samples[i * 3 + 1] = p.y;
        c.samples[i * 3 + 2] = p.z;
      }
      const company = world!.companies.get(ship.companyId);
      color.set(company?.color ?? '#ffffff');
    }
    const pos = l.geometry.attributes.position as BufferAttribute;
    const col = l.geometry.attributes.color as BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;
    const o = frame.origin;
    const now = sim.clock.jd;
    for (let i = 0; i < SAMPLES; i++) {
      const k = i * 3;
      pa[k] = (c.samples[k]! - o.x) * UNITS_PER_KM;
      pa[k + 1] = (c.samples[k + 2]! - o.z) * UNITS_PER_KM;
      pa[k + 2] = -(c.samples[k + 1]! - o.y) * UNITS_PER_KM;
      const f = c.times[i]! < now ? PAST_DIM : 1;
      ca[k] = color.r * f;
      ca[k + 1] = color.g * f;
      ca[k + 2] = color.b * f;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }, PRIORITY_SCENE);

  return <primitive ref={ref} object={line} />;
}
