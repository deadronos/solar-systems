import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ClockState, SimClock } from '../sim/index.ts';

/** Discrete clock state (rate / paused). Re-renders only when those change. */
export const useClockState = (clock: SimClock): ClockState =>
  useSyncExternalStore(clock.subscribe, clock.getState);

/**
 * Poll a value derived from the running simulation at a fixed cadence.
 * The sim advances every animation frame; the DOM doesn't need to.
 */
export function usePolled<T>(read: () => T, hz = 10): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const id = window.setInterval(() => setValue(read()), 1000 / hz);
    return () => window.clearInterval(id);
  }, [read, hz]);
  return value;
}
