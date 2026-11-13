import type { Good } from '../economy/types.ts';

/** Prices are Earth reference prices in credits (₡) per tonne. */
export const GOODS: Good[] = [
  { id: 'water', name: 'Water', category: 'survival', basePrice: 200 },
  { id: 'oxygen', name: 'Oxygen', category: 'survival', basePrice: 400 },
  { id: 'food', name: 'Food', category: 'survival', basePrice: 1_500 },
  { id: 'ice', name: 'Ice', category: 'raw', basePrice: 120 },
  { id: 'regolith', name: 'Regolith', category: 'raw', basePrice: 30 },
  { id: 'ore', name: 'Metal ore', category: 'raw', basePrice: 250 },
  { id: 'rare_metals', name: 'Rare metals', category: 'raw', basePrice: 6_000 },
  { id: 'steel', name: 'Steel', category: 'industrial', basePrice: 900 },
  { id: 'fuel', name: 'Fuel', category: 'industrial', basePrice: 800 },
  { id: 'electronics', name: 'Electronics', category: 'comfort', basePrice: 25_000 },
  { id: 'machinery', name: 'Machinery', category: 'industrial', basePrice: 8_000 },
  { id: 'medicine', name: 'Medicine', category: 'basic', basePrice: 40_000 },
  { id: 'consumer_goods', name: 'Consumer goods', category: 'basic', basePrice: 5_000 },
  { id: 'habitat_modules', name: 'Habitat modules', category: 'industrial', basePrice: 12_000 },
];
