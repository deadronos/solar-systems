import type { EconomyPort } from './economy.ts';

/** Whether this environment can run the economy in a module Web Worker. */
export const canUseWorkers = (): boolean => typeof Worker === 'function';

/** Start the economy worker (bundled by Vite from the `new URL(…)` reference). */
export function spawnEconomyWorker(): EconomyPort {
  return new Worker(new URL('./economy.worker.ts', import.meta.url), {
    type: 'module',
    name: 'economy',
  }) as unknown as EconomyPort;
}
