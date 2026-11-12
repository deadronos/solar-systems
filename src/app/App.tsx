import { useState } from 'react';
import { LabelOverlay, SimulationProvider, SolarSystemScene } from '../render/index.ts';
import { Simulation } from '../sim/index.ts';
import { Hud } from '../ui/Hud.tsx';

export function App() {
  const [sim] = useState(() => new Simulation({ rate: 86_400 }));
  return (
    <SimulationProvider sim={sim}>
      <div className="app">
        <SolarSystemScene />
        <LabelOverlay />
        <Hud />
      </div>
    </SimulationProvider>
  );
}
