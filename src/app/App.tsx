import { useState } from 'react';
import {
  LabelOverlay,
  LogisticsOverlay,
  SimulationProvider,
  SolarSystemScene,
} from '../render/index.ts';
import { DEFAULT_SCENARIO } from '../sim/logistics/index.ts';
import { Simulation } from '../sim/index.ts';
import { Hud } from '../ui/Hud.tsx';

export function App() {
  const [sim] = useState(
    () =>
      new Simulation({
        scenario: DEFAULT_SCENARIO,
        rate: 86_400,
        // The economy runs in a Web Worker (main-thread fallback); `?economy=inline` forces it here.
        economy:
          new URLSearchParams(location.search).get('economy') === 'inline' ? 'inline' : 'worker',
      }),
  );
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
