/** Fixed economy tick: 6 simulated hours. Ticks are never skipped or resized. */
export const TICK_DAYS = 0.25;

/** 2040-01-01T00:00Z — scenario start date. */
export const START_JD = 2_466_154.5;

/** Max time rate in logistics mode: 1 year per real second. */
export const MAX_RATE_SECONDS_PER_SECOND = 31_557_600;

/** Tolerance for comparing Julian dates built from repeated tick additions. */
export const JD_EPSILON = 1e-9;
