import type { Recipe } from '../economy/types.ts';

/**
 * Production recipes. Extraction recipes have no inputs; chains are just recipes whose
 * inputs are other recipes' outputs. Quantities in tonnes per batch.
 */
export const RECIPES: Recipe[] = [
  // Extraction
  {
    id: 'harvest_ice',
    name: 'Ice harvesting',
    inputs: [],
    outputs: [{ good: 'ice', qty: 1 }],
    workersPerUnitPerDay: 0.8,
  },
  {
    id: 'mine_regolith',
    name: 'Regolith mining',
    inputs: [],
    outputs: [{ good: 'regolith', qty: 1 }],
    workersPerUnitPerDay: 0.2,
  },
  {
    id: 'mine_ore',
    name: 'Ore mining',
    inputs: [],
    outputs: [{ good: 'ore', qty: 1 }],
    workersPerUnitPerDay: 0.5,
  },
  {
    id: 'mine_rare',
    name: 'Rare-metal extraction',
    inputs: [],
    outputs: [{ good: 'rare_metals', qty: 1 }],
    workersPerUnitPerDay: 25,
  },
  // Life support & agriculture
  {
    id: 'melt_ice',
    name: 'Ice processing',
    inputs: [{ good: 'ice', qty: 1 }],
    outputs: [{ good: 'water', qty: 0.9 }],
    workersPerUnitPerDay: 0.2,
  },
  {
    id: 'electrolysis',
    name: 'Electrolysis',
    inputs: [{ good: 'water', qty: 1.2 }],
    outputs: [{ good: 'oxygen', qty: 1 }],
    workersPerUnitPerDay: 0.5,
  },
  {
    id: 'regolith_oxygen',
    name: 'Regolith oxygen extraction',
    inputs: [{ good: 'regolith', qty: 3 }],
    outputs: [{ good: 'oxygen', qty: 1 }],
    workersPerUnitPerDay: 1,
  },
  {
    id: 'grow_food',
    name: 'Hydroponics',
    inputs: [{ good: 'water', qty: 2 }],
    outputs: [{ good: 'food', qty: 1 }],
    workersPerUnitPerDay: 6,
  },
  // Fuel
  {
    id: 'make_fuel',
    name: 'Propellant plant',
    inputs: [{ good: 'ice', qty: 1.3 }],
    outputs: [{ good: 'fuel', qty: 1 }],
    workersPerUnitPerDay: 0.6,
  },
  {
    id: 'water_fuel',
    name: 'Water electrolysis (fuel)',
    inputs: [{ good: 'water', qty: 1.1 }],
    outputs: [{ good: 'fuel', qty: 1 }],
    workersPerUnitPerDay: 0.5,
  },
  {
    id: 'he3_fuel',
    name: 'He-3 refining',
    inputs: [{ good: 'regolith', qty: 40 }],
    outputs: [{ good: 'fuel', qty: 1 }],
    workersPerUnitPerDay: 3,
  },
  // Industry
  {
    id: 'smelt_steel',
    name: 'Steel mill',
    inputs: [
      { good: 'ore', qty: 1.5 },
      { good: 'fuel', qty: 0.05 },
    ],
    outputs: [{ good: 'steel', qty: 1 }],
    workersPerUnitPerDay: 2,
  },
  {
    id: 'make_electronics',
    name: 'Electronics fab',
    inputs: [
      { good: 'rare_metals', qty: 0.2 },
      { good: 'steel', qty: 0.3 },
    ],
    outputs: [{ good: 'electronics', qty: 1 }],
    workersPerUnitPerDay: 60,
  },
  {
    id: 'make_machinery',
    name: 'Machine shop',
    inputs: [
      { good: 'steel', qty: 1 },
      { good: 'electronics', qty: 0.05 },
    ],
    outputs: [{ good: 'machinery', qty: 1 }],
    workersPerUnitPerDay: 12,
  },
  {
    id: 'make_habitat',
    name: 'Habitat factory',
    inputs: [
      { good: 'steel', qty: 1 },
      { good: 'machinery', qty: 0.2 },
    ],
    outputs: [{ good: 'habitat_modules', qty: 1 }],
    workersPerUnitPerDay: 10,
  },
];
