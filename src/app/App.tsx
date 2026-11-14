import { useState } from 'react';
import {
  LabelOverlay,
  LogisticsOverlay,
  SimulationProvider,
  SolarSystemScene,
} from '../render/index.ts';
import { DEFAULT_SCENARIO, withFleetSize } from '../sim/logistics/index.ts';
import { Simulation } from '../sim/index.ts';
import { Hud } from '../ui/Hud.tsx';

export function App() {
  const [sim] = useState(() => {
    const params = new URLSearchParams(location.search);
    // `?fleet=300` starts with ~300 ships, for rendering and sync benchmarks.
    const fleet = Number(params.get('fleet'));
    return new Simulation({
      scenario: fleet > 0 ? withFleetSize(DEFAULT_SCENARIO, fleet) : DEFAULT_SCENARIO,
      rate: 86_400,
      // The economy runs in a Web Worker (main-thread fallback); `?economy=inline` forces it here.
      economy: params.get('economy') === 'inline' ? 'inline' : 'worker',
    });
  });
  return (
    <SimulationProvider sim={sim}>
      <div className="app">
        <SolarSystemScene />
        <LabelOverlay />
        <LogisticsOverlay />
        <Hud />
      </div>
    </SimulationProvider>
  );
}
