import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments } from 'three';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from '../scene/SimDriver.tsx';

const MAX_FLOWS = 256;
const NEUTRAL = new Color('#8fb3ff');

interface Flow {
  from: string;
  to: string;
  tonnes: number;
  color: Color;
}

/**
 * Lines between settlements weighted by the last year's traded tonnage (brightness), coloured
 * by company when a company filter is active.
 */
export function TradeFlowLayer() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const flows = useRef<Flow[]>([]);
  const lastBuild = useRef(0);
  const lines = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(MAX_FLOWS * 6), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(MAX_FLOWS * 6), 3));
    const m = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const l = new LineSegments(g, m);
    l.frustumCulled = false;
    return l;
  }, []);
  useEffect(
    () => () => {
      lines.geometry.dispose();
      (lines.material as LineBasicMaterial).dispose();
    },
    [lines],
  );

  const ref = useRef<LineSegments>(null);

  useFrame((state) => {
    const seg = ref.current;
    if (!seg) return;
    const world = sim.logistics;
    const { overlays, companyFilter } = useSelectionStore.getState();
    seg.visible = !!world?.stats && overlays.tradeFlows;
    if (!world?.stats || !seg.visible) return;

    // Aggregate flows ~once a second.
    if (state.clock.elapsedTime - lastBuild.current > 1) {
      lastBuild.current = state.clock.elapsedTime;
      const agg = new Map<string, Flow>();
      for (const [key, tonnes] of world.stats.flows) {
        const [route, companyId] = key.split('|') as [string, string];
        if (companyFilter && companyId !== companyFilter) continue;
        const [from, to] = route.split('>') as [string, string];
        const k = companyFilter ? route : [from, to].toSorted().join('<>');
        const f = agg.get(k);
        if (f) f.tonnes += tonnes;
        else
          agg.set(k, {
            from,
            to,
            tonnes,
            color: companyFilter
              ? new Color(world.companies.get(companyId)?.color ?? '#fff')
              : NEUTRAL,
          });
      }
      flows.current = [...agg.values()].toSorted((a, b) => b.tonnes - a.tonnes).slice(0, MAX_FLOWS);
    }

    const pos = seg.geometry.attributes.position as BufferAttribute;
    const col = seg.geometry.attributes.color as BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;
    const max = flows.current[0]?.tonnes ?? 1;
    const o = frame.origin;
    let n = 0;
    for (const f of flows.current) {
      const a = world.settlements.get(f.from);
      const b = world.settlements.get(f.to);
      if (!a || !b) continue;
      const pa1 = sim.ephemeris.position(a.site.bodyId);
      const pb1 = sim.ephemeris.position(b.site.bodyId);
      const k = n * 6;
      pa[k] = (pa1.x - o.x) * UNITS_PER_KM;
      pa[k + 1] = (pa1.z - o.z) * UNITS_PER_KM;
      pa[k + 2] = -(pa1.y - o.y) * UNITS_PER_KM;
      pa[k + 3] = (pb1.x - o.x) * UNITS_PER_KM;
      pa[k + 4] = (pb1.z - o.z) * UNITS_PER_KM;
      pa[k + 5] = -(pb1.y - o.y) * UNITS_PER_KM;
      const w = 0.15 + 0.85 * Math.sqrt(f.tonnes / max);
      for (let j = 0; j < 2; j++) {
        ca[k + j * 3] = f.color.r * w;
        ca[k + j * 3 + 1] = f.color.g * w;
        ca[k + j * 3 + 2] = f.color.b * w;
      }
      n++;
    }
    seg.geometry.setDrawRange(0, n * 2);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }, PRIORITY_SCENE);

  return <primitive ref={ref} object={lines} />;
}
