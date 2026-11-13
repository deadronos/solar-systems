import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SimulationProvider } from '../../../render/index.ts';
import { DEFAULT_SCENARIO } from '../../../sim/logistics/index.ts';
import { Simulation } from '../../../sim/simulation.ts';
import { ContractInspector } from './ContractInspector.tsx';
import { ShipInspector } from './ShipInspector.tsx';

describe('inspectors', () => {
  it('render a "no longer exists" note instead of crashing for removed entities', () => {
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    const html = renderToString(
      <SimulationProvider sim={sim}>
        <ShipInspector id="ship-gone" />
        <ContractInspector id="contract-gone" />
      </SimulationProvider>,
    );
    expect(html).toContain('This ship no longer exists');
    expect(html).toContain('This order no longer exists');
  });
});
