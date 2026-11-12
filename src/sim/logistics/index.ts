/** Public API of the logistics simulation layer. */
export * from './core/time.ts';
export * from './core/events.ts';
export { Scheduler } from './core/scheduler.ts';
export * from './core/world.ts';
export * from './economy/types.ts';
export type * from './navigation/plan.ts';
export { DEFAULT_SCENARIO } from './data/scenario.ts';
export { evaluatePlan } from './navigation/plan.ts';
export { NavContext, estimateTrip, planTrip, type TripEstimate } from './navigation/planner.ts';
