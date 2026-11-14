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
  /** Rolling share of capacity actually run (absent until the first production tick). */
  utilisation?: number;
}

/** A facility a settlement is building or expanding, waiting for its build kit (#14). */
export interface InvestmentProject {
  recipeId: string;
  /** Batches per day the project adds. */
  addRatePerDay: number;
  /** A new facility rather than an expansion. */
  isNew: boolean;
  /** Goods consumed when the project completes. */
  kit: RecipeLine[];
  startedJd: number;
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
  /**
   * Extraction recipes (no inputs) the site's deposits allow building, besides the ones it
   * already runs. Processing recipes can be built anywhere.
   */
  deposits?: string[];
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
  /** Date of that announcement; absent until the first one (and in older snapshots). */
  lastAnnouncedJd?: number;
  /**
   * Deep market only: recent net tonnes traders sold to it (negative: bought), decaying over
   * `markets.deepMarketRecoveryDays`. Moves its price, so Earth is not a fixed anchor.
   */
  netSoldT?: number;
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
  /** Fee multiplier per good, raised each time an order expires unfilled (reset on acceptance). */
  orderEscalation: Partial<Record<GoodId, number>>;
  /**
   * Treasury promised to live contracts (delivery rewards and freight fees, plus freight
   * escrow held until loading). Spending decisions use `treasury − committed`.
   */
  committed: number;
  /** Workers left unemployed by the last production tick (absent in older snapshots). */
  idleWorkers?: number;
  /** Facility being built or expanded, if any (absent in older snapshots). */
  project?: InvestmentProject | null;
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
  /**
   * 0..1: share of rivals' inbound cargo the company assumes lands before its own, cutting
   * the demand and price it expects at a destination (#16). Defaults to
   * `ai.defaultCompetitionWeight`.
   */
  competitionWeight?: number;
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
  /**
   * Colony each cargo good was last bought at, for the Earth charter's export bounty. Absent
   * for goods bought at a deep market (and in older snapshots).
   */
  cargoOrigin?: Partial<Record<GoodId, string>>;
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

/**
 * `delivery` and `freight` are buy orders. `export` is a colony's sell order: `settlementId`
 * (= `pickupSettlementId`) is the seller, the goods are reserved, and the carrier pays
 * `escrowCost` for them on loading, which completes the order.
 */
export type ContractKind = 'delivery' | 'freight' | 'export';
export type ContractStatus = 'open' | 'accepted' | 'loaded' | 'completed' | 'expired';

export interface Contract {
  id: string;
  kind: ContractKind;
  /** Buyer and destination (the seller for an export order). */
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
  /**
   * Freight: what the buyer pays the pickup for the goods at loading. Export: what the
   * carrier pays the seller at loading.
   */
  escrowCost: number;
  /** Past its deadline but still deliverable (loaded freight); the penalty was charged. */
  late: boolean;
}

export interface EconomyConstants {
  markets: {
    elasticity: number;
    priceClampMin: number;
    priceClampMax: number;
    spread: number;
    bufferDays: number;
    deepMarketStock: number;
    maxStockMultiple: number;
    producerBufferDays: number;
    deepMarketDepthT: number;
    deepMarketRecoveryDays: number;
    deepPriceClampMin: number;
    deepPriceClampMax: number;
    earthExportBounty: number;
  };
  population: {
    satisfactionEmaDays: number;
    emigrationThreshold: number;
    maxGrowthPerYear: number;
    maxEmigrationPerYear: number;
    workforceFraction: number;
    stipendPerCapitaPerDay: number;
    stipendGdpFraction: number;
    initialReserveDays: number;
    housingDemandDays: number;
    baselineGrowthWeight: number;
    basicGrowthWeight: number;
    comfortGrowthWeight: number;
    needsPerCapitaPerDay: Record<NeedTier, Partial<Record<GoodId, number>>>;
    housingBatch: { inputs: RecipeLine[]; capacityGainFraction: number; occupancyTrigger: number };
  };
  contracts: {
    contractPremium: number;
    postThreshold: number;
    maxTreasuryFraction: number;
    minDeadlineDays: number;
    deadlineTripMultiple: number;
    escalationStep: number;
    escalationCap: number;
    freightFeeMarkup: number;
    minHaulCost: number;
    sourceReserveFraction: number;
    maxContractQtyT: number;
    defaultLeadDays: number;
    shortagePremiumFactor: number;
    nonSurvivalTreasuryFraction: number;
    survivalTreasuryReserveDays: number;
    penaltyFraction: number;
    sellOrderStockMultiple: number;
    sellOrderDiscount: number;
    minSellOrderT: number;
  };
  industry: {
    reviewDays: number;
    expansionFraction: number;
    newFacilityWorkers: number;
    kitPerWorker: RecipeLine[];
    kitDemandDays: number;
    projectTimeoutDays: number;
    maxPaybackDays: number;
    exportNetback: number;
    survivalMargin: number;
    minUtilisation: number;
    maintenancePerWorkerDay: number;
    wearPerYear: number;
    minRatePerDay: number;
    survivalInputReserveDays: number;
  };
  ships: {
    dockingFee: number;
    shipyardShare: number;
    emergencyFuelFactor: number;
    resaleFraction: number;
  };
  companies: {
    bankruptcyGraceDays: number;
    entrantDelayDays: number;
    entrantSeedCash: number;
  };
  ai: {
    idleRetryDays: number;
    jobRetryDays: number;
    minLoadFraction: number;
    reserveDays: number;
    fleetReviewDays: number;
    riskHorizonDays: number;
    buyPriceLimitFactor: number;
    preferredGoodWeight: number;
    outerRegionWeight: number;
    beltRegionWeight: number;
    innerRegionWeight: number;
    contractBiasScale: number;
    repositionMarginWeight: number;
    lowCashThresholdFraction: number;
    lowUtilisationThreshold: number;
    shipPurchaseCashFraction: number;
    defaultCompetitionWeight: number;
  };
  nav: {
    surfaceLegDays: number;
    sameBodyDays: number;
    surfaceDvFactor: number;
    lowOrbitFactor: number;
    transferDaysPerKmS: number;
  };
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
