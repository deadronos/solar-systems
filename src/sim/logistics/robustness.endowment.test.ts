import { describe, expect, it } from 'vitest';
import { runSoak, variantScenario } from './soakHarness.ts';

// Perturbed 20-year soaks, split across files so they run in parallel (see soakHarness.ts).
describe('20-year soak, perturbed', () => {
  for (const name of ['thinner stocks', 'poorer colonies']) {
    it(name, { timeout: 180_000 }, () => {
      expect(runSoak(variantScenario(name)).violations).toEqual([]);
    });
  }
});
