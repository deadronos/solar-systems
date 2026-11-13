/* @vitest-environment happy-dom */
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCENARIO } from '../sim/logistics/index.ts';
import { Simulation } from '../sim/simulation.ts';
import type { EconomyPort } from '../sim/logistics/sync/economy.ts';
import { SimulationProvider } from './SimulationContext.tsx';

describe('SimulationProvider', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => vi.unstubAllGlobals());

  it('disposes the economy worker when unmounted', () => {
    const terminate = vi.fn();
    const port: EconomyPort = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      terminate,
    };
    const sim = new Simulation({
      scenario: DEFAULT_SCENARIO,
      economy: 'worker',
      spawnWorker: () => port,
    });

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <StrictMode>
          <SimulationProvider sim={sim}>
            <div />
          </SimulationProvider>
        </StrictMode>,
      ),
    );
    sim.step(0);
    expect(terminate).not.toHaveBeenCalled();

    act(() => root.unmount());

    expect(terminate).toHaveBeenCalledOnce();
  });
});
