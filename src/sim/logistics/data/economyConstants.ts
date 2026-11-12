import type { EconomyConstants } from '../economy/types.ts';

/** Economy tunables. Fixed by the design: elasticity, price clamps, bankruptcy grace. */
export const ECONOMY_CONSTANTS: EconomyConstants = {
  elasticity: 1,
  priceClampMin: 0.25,
  priceClampMax: 4,
  spread: 0.08,
  bufferDays: 120,
  satisfactionEmaDays: 30,
  emigrationThreshold: 0.9,
  maxGrowthPerYear: 0.04,
  maxEmigrationPerYear: 0.15,
  workforceFraction: 0.5,
  stipendPerCapitaPerDay: 5,
  dockingFee: 5_000,
  bankruptcyGraceDays: 90,
  entrantDelayDays: 180,
  entrantSeedCash: 300_000_000,
  contractPremium: 0.25,
  needsPerCapitaPerDay: {
    survival: { water: 0.004, oxygen: 0.0009, food: 0.0015 },
    basic: { medicine: 0.000_005, consumer_goods: 0.0002 },
    comfort: { electronics: 0.000_04 },
  },
  housingBatch: {
    inputs: [
      { good: 'habitat_modules', qty: 40 },
      { good: 'steel', qty: 80 },
      { good: 'machinery', qty: 8 },
    ],
    capacityGainFraction: 0.1,
    occupancyTrigger: 0.85,
  },
  deepMarketStock: 1_000_000_000,
};
