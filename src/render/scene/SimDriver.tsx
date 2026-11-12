import { useFrame } from '@react-three/fiber';
import { copy } from '../../sim/index.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';

/** Frame priorities: the driver runs first, then everything that reads sim state. */
export const PRIORITY_SIM = -2;
export const PRIORITY_SCENE = -1;

/** Advances the simulation once per frame and updates the floating origin. */
export function SimDriver() {
  const sim = useSimulation();
  const frame = useRenderFrame();
  useFrame((_, dt) => {
    sim.step(dt);
    const { focusId } = useViewStore.getState();
    copy(frame.origin, sim.ephemeris.position(focusId));
  }, PRIORITY_SIM);
  return null;
}
