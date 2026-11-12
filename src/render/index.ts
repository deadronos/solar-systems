/** Public API of the presentation (three.js / R3F) layer. */
export { SimulationProvider, useSimulation, useRenderFrame } from './SimulationContext.tsx';
export { SolarSystemScene } from './scene/SolarSystemScene.tsx';
export { appearanceFor } from './appearance.ts';
export { LabelOverlay } from './LabelOverlay.tsx';
export { LogisticsOverlay } from './logistics/LogisticsOverlay.tsx';
export { resolveFocusPosition, shipPosition } from './logistics/focus.ts';
export { usePolledKeyed } from './logistics/usePolled.ts';
