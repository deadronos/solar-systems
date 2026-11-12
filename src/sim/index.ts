/** Public API of the simulation layer. Presentation code imports only from here. */
export * from './constants.ts';
export * from './math/vec3.ts';
export * from './time/julian.ts';
export { SimClock, type ClockState } from './time/clock.ts';
export * from './orbits/kepler.ts';
export * from './orbits/models.ts';
export * from './orbits/frames.ts';
export type * from './data/types.ts';
export { DEFAULT_CATALOG, topologicalOrder } from './data/catalog.ts';
export { Ephemeris, type Orientation } from './world/ephemeris.ts';
export { ParticleOrbits } from './belts/particles.ts';
export { DEFAULT_BELTS, createBelt, type Belt, type BeltDefinition } from './belts/belts.ts';
export { Simulation, type SimulationOptions } from './simulation.ts';
