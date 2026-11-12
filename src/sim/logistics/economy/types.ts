import type { TrajectoryPlan } from '../navigation/plan.ts';

export const GOOD_IDS = [
  'water',
  'oxygen',
  'food',
  'ice',
  'regolith',
  'ore',
  'rare_metals',
  'steel',
  'fuel',
  'electronics',
  'machinery',
  'medicine',
  'consumer_goods',
  'habitat_modules',
] as const;

export type GoodId = (typeof GOOD_IDS)[number];
export type GoodCategory = 'survival' | 'basic' | 'comfort' | 'raw' | 'industrial';
export type NeedTier = 'survival' | 'basic' | 'comfort';

export interface Good {
  id: GoodId;
  name: string;
  category: GoodCategory;
  /** Earth reference price, credits per tonne. */
  basePrice: number;
}

export interface RecipeLine {
  good: GoodId;
  qty: number;
}

export interface Recipe {
  id: string;
  name: string;
  inputs: RecipeLine[];
  outputs: RecipeLine[];
  /** Workers needed to run the recipe at 1 batch per day. */
  workersPerUnitPerDay: number;
}

export interface Facility {
  recipeId: string;
  /** Max batches per day. */
  maxRatePerDay: number;
}

export interface Site {
  bodyId: string;
  kind: 'surface' | 'orbit';
}

export interface SettlementDef {
  id: string;
  name: string;
  description: string;
  site: Site;
  population: number;
  housingCapacity: number;
  facilities: Facility[];
  initialStock: Partial<Record<GoodId, number>>;
  treasury: number;
  isShipyard: boolean;
  isDeepMarket: boolean;
  /** Deep market only: price multipliers vs base (e.g. bulk goods hauled up Earth's gravity well). */
  deepPriceFactors?: Partial<Record<GoodId, number>>;
}

export interface MarketEntry {
  stock: number;
  targetStock: number;
  price: number;
  /** Rolling daily consumption / production estimates used for target stock. */
  consumptionPerDay: number;
  productionPerDay: number;
  /** Last price announced via PriceChanged. */
  lastAnnouncedPrice: number;
}

export interface Satisfaction {
  survival: number;
  basic: number;
  comfort: number;
}

export interface Settlement extends SettlementDef {
  market: Record<GoodId, MarketEntry>;
  /** Per-tick demand/supply accumulators (tonnes), folded into market EMAs each tick. */
  flows: { demand: Partial<Record<GoodId, number>>; supply: Partial<Record<GoodId, number>> };
  satisfaction: Satisfaction;
  inShortage: boolean;
  lastMilestone: number;
}

export interface ShipClass {
  id: string;
  name: string;
  tier: 1 | 2 | 3 | 4 | 5;
  cargoT: number;
  /** Tiers 1–2: Δv budget per trip (km/s). */
  deltaVBudgetKmS?: number;
  /** Tiers 3–4: constant acceleration (g). */
  accelG?: number;
  /** Tier 4: velocity cap as a fraction of c. */
  maxSpeedFractionC?: number;
  /** Tier 5: charge time before a jump (hours). */
  jumpChargeHours?: number;
  /** Tier 5: effective jump speed in multiples of c. */
  jumpSpeedC?: number;
  /** Propellant mass per km/s of Δv (tonnes), bought as `fuel` at departure. */
  fuelTPerKmS: number;
  /** Tier 4: exotic fuel cost in credits per km/s (paid at shipyards). */
  exoticCostPerKmS?: number;
  /** Tier 5: exotic fuel cost in credits per jump. */
  exoticCostPerJump?: number;
  price: number;
  upkeepPerDay: number;
  buildDays: number;
}

export interface Personality {
  id: string;
  name: string;
  description: string;
  preferredTiers: number[];
  preferredGoods?: GoodId[];
  regionBias?: 'inner' | 'belt' | 'outer';
  /** 0..1 — discount on long/uncertain trades. */
  riskAversion: number;
  /** Minimum expected margin over costs (fraction). */
  minMarginPct: number;
  /** -1 = pure trader … +1 = pure contract carrier. */
  contractVsTradeBias: number;
  expansionCashThreshold: number;
  targetUtilisation: number;
}

export interface CompanyDef {
  id: string;
  name: string;
  color: string;
  personalityId: string;
  cash: number;
  ships: { classId: string; siteId: string; name: string }[];
}

export type ShipState = 'docked' | 'waiting' | 'in_transit' | 'building';

export interface Ship {
  id: string;
  companyId: string;
  classId: string;
  name: string;
  state: ShipState;
  /** Docked/waiting/building location; null while in transit. */
  siteId: string | null;
  plan: TrajectoryPlan | null;
  cargo: Partial<Record<GoodId, number>>;
  contractId: string | null;
  intent: string;
  pendingRemoval: boolean;
  /** Day the ship last became idle (for utilisation). */
  busyDays: number;
  stats: { trips: number; revenue: number; costs: number };
}

export type CompanyStatus = 'active' | 'distress' | 'bankrupt';

export interface Company {
  id: string;
  name: string;
  color: string;
  personalityId: string;
  cash: number;
  shipIds: string[];
  status: CompanyStatus;
  distressSinceJd: number | null;
  foundedJd: number;
  stats: { revenue: number; costs: number; tradesCompleted: number; contractsCompleted: number };
}

export type ContractKind = 'delivery' | 'freight';
export type ContractStatus = 'open' | 'accepted' | 'loaded' | 'completed' | 'expired';

export interface Contract {
  id: string;
  kind: ContractKind;
  /** Buyer and destination. */
  settlementId: string;
  /** Freight only: where the pre-purchased cargo waits. */
  pickupSettlementId: string | null;
  good: GoodId;
  qty: number;
  reward: number;
  postedJd: number;
  deadlineJd: number;
  status: ContractStatus;
  companyId: string | null;
  shipId: string | null;
}

export interface EconomyConstants {
  elasticity: number;
  priceClampMin: number;
  priceClampMax: number;
  spread: number;
  bufferDays: number;
  satisfactionEmaDays: number;
  emigrationThreshold: number;
  maxGrowthPerYear: number;
  maxEmigrationPerYear: number;
  workforceFraction: number;
  stipendPerCapitaPerDay: number;
  dockingFee: number;
  bankruptcyGraceDays: number;
  entrantDelayDays: number;
  entrantSeedCash: number;
  contractPremium: number;
  needsPerCapitaPerDay: Record<NeedTier, Partial<Record<GoodId, number>>>;
  housingBatch: { inputs: RecipeLine[]; capacityGainFraction: number; occupancyTrigger: number };
  deepMarketStock: number;
}

export interface ScenarioConfig {
  seed: number;
  startJd: number;
  goods: Good[];
  recipes: Recipe[];
  settlements: SettlementDef[];
  shipClasses: ShipClass[];
  personalities: Personality[];
  companies: CompanyDef[];
  constants: EconomyConstants;
}
