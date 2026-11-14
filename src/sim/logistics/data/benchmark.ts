import type { ScenarioConfig } from '../economy/types.ts';

/**
 * A copy of `scenario` whose companies start with about `fleet` ships in total (each starting
 * ship is repeated, with cash scaled to match), for rendering and sync benchmarks.
 */
export function withFleetSize(scenario: ScenarioConfig, fleet: number): ScenarioConfig {
  const base = scenario.companies.reduce((n, c) => n + c.ships.length, 0);
  const copies = Math.max(1, Math.ceil(fleet / Math.max(base, 1)));
  return {
    ...scenario,
    companies: scenario.companies.map((c) => ({
      ...c,
      cash: c.cash * copies,
      ships: Array.from({ length: copies }, (_, k) =>
        c.ships.map((s) => (k === 0 ? s : { ...s, name: `${s.name} ${k + 1}` })),
      ).flat(),
    })),
  };
}
