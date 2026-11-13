import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';
import { vec3, type Simulation, type Vec3 } from '../sim/index.ts';

/** Per-frame render state shared between scene components (mutable, never triggers renders). */
export interface RenderFrame {
  /** Floating origin: heliocentric km position of the focused body this frame. */
  origin: Vec3;
  /** DOM label elements by body id, positioned each frame by the scene. */
  labels: Map<string, HTMLElement>;
}

interface SimulationContextValue {
  sim: Simulation;
  frame: RenderFrame;
}

const SimulationContext = createContext<SimulationContextValue | null>(null);

export function SimulationProvider({ sim, children }: { sim: Simulation; children: ReactNode }) {
  useEffect(() => () => sim.dispose(), [sim]);

  // Frame object is stable per simulation instance.
  const value = useMemo<SimulationContextValue>(() => ({ sim, frame: frameFor(sim) }), [sim]);
  return <SimulationContext value={value}>{children}</SimulationContext>;
}

const frames = new WeakMap<Simulation, RenderFrame>();
function frameFor(sim: Simulation): RenderFrame {
  let f = frames.get(sim);
  if (!f) {
    f = { origin: vec3(), labels: new Map() };
    frames.set(sim, f);
  }
  return f;
}

function useCtx(): SimulationContextValue {
  const ctx = use(SimulationContext);
  if (!ctx) throw new Error('useSimulation must be used within <SimulationProvider>');
  return ctx;
}

export const useSimulation = (): Simulation => useCtx().sim;
export const useRenderFrame = (): RenderFrame => useCtx().frame;
