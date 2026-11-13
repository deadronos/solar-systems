import type { EconomyConstants } from '../economy/types.ts';

/** Default balance settings for the standard scenario. */
export const ECONOMY_CONSTANTS: EconomyConstants = {
  markets: {
    elasticity: 1,
    priceClampMin: 0.25,
    priceClampMax: 4,
    spread: 0.08,
    /** Days of consumption targeted in normal market stock. */
    bufferDays: 120,
    deepMarketStock: 1_000_000_000,
    /** Settlements stop buying above this multiple of target stock. */
    maxStockMultiple: 3,
    /** Days of output producers keep before stock counts as surplus. */
    producerBufferDays: 15,
    /** Deep market: net tonnes sold that move its price as far as 2× target stock would. */
    deepMarketDepthT: 20_000,
    /** Deep market: days for a trade's price impact to fade. */
    deepMarketRecoveryDays: 90,
    /** Deep market price clamps, as multiples of its reference price. */
    deepPriceClampMin: 0.5,
    deepPriceClampMax: 2,
    /** Earth charter bounty to the origin colony, as a share of base price per tonne sold to Earth. */
    earthExportBounty: 0.2,
  },
  population: {
    /** Smoothing window for need satisfaction and market flow estimates. */
    satisfactionEmaDays: 30,
    emigrationThreshold: 0.9,
    maxGrowthPerYear: 0.04,
    maxEmigrationPerYear: 0.15,
    workforceFraction: 0.5,
    stipendPerCapitaPerDay: 5,
    /** Extra stipend as a share of the colony's daily output value at base prices. */
    stipendGdpFraction: 0.05,
    /** Minimum starting stock expressed as days of survival demand. */
    initialReserveDays: 365,
    /** Days over which to spread demand for housing materials. */
    housingDemandDays: 60,
    baselineGrowthWeight: 0.25,
    basicGrowthWeight: 0.4,
    comfortGrowthWeight: 0.35,
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
  },
  contracts: {
    contractPremium: 0.25,
    /** Post when stock plus inbound falls below this fraction of desired stock. */
    postThreshold: 0.5,
    /** Maximum share of available treasury committed to one survival order. */
    maxTreasuryFraction: 0.5,
    minDeadlineDays: 120,
    deadlineTripMultiple: 3,
    escalationStep: 1.5,
    escalationCap: 8,
    freightFeeMarkup: 1.5,
    /** Floor on estimated haul cost, so short hops are worth a ship. */
    minHaulCost: 50_000,
    /** Share of target stock a source must keep for itself. */
    sourceReserveFraction: 0.5,
    /** Cap on tonnes in a single posted contract. */
    maxContractQtyT: 800,
    /** Lead time assumed when no supplier can be routed. */
    defaultLeadDays: 365,
    shortagePremiumFactor: 2,
    /** Maximum share of funds beyond the survival reserve committed to one non-survival order. */
    nonSurvivalTreasuryFraction: 0.15,
    /** Days of survival imports to reserve at the maximum market price. */
    survivalTreasuryReserveDays: 365,
    /** Share of the reward charged for abandonment or expiry after acceptance. */
    penaltyFraction: 0.1,
    /** A producer posts a sell order for stock above this multiple of its target stock. */
    sellOrderStockMultiple: 2,
    /** Discount on the local ask that a sell order offers carriers. */
    sellOrderDiscount: 0.15,
    /** Smallest sell order worth posting (tonnes). */
    minSellOrderT: 50,
  },
  ships: {
    dockingFee: 5_000,
    /** Share of a new ship's price paid to the shipyard settlement; the rest buys Earth-made parts. */
    shipyardShare: 0.5,
    /** Multiplier on base fuel price for emergency refuelling. */
    emergencyFuelFactor: 3,
    /** Share of the ship list price recovered by resale. */
    resaleFraction: 0.6,
  },
  companies: {
    bankruptcyGraceDays: 90,
    entrantDelayDays: 180,
    entrantSeedCash: 300_000_000,
  },
  ai: {
    idleRetryDays: 5,
    jobRetryDays: 2,
    minLoadFraction: 0.05,
    /** Days of upkeep the AI reserves in cash. */
    reserveDays: 30,
    fleetReviewDays: 30,
    /** Trip duration at which the AI applies its full risk discount. */
    riskHorizonDays: 365,
    buyPriceLimitFactor: 1.05,
    preferredGoodWeight: 1.25,
    outerRegionWeight: 1.3,
    beltRegionWeight: 1.2,
    innerRegionWeight: 1.2,
    contractBiasScale: 0.5,
    repositionMarginWeight: 0.7,
    lowCashThresholdFraction: 0.1,
    lowUtilisationThreshold: 0.4,
    shipPurchaseCashFraction: 0.5,
  },
  nav: {
    /** Hold duration for ascent or descent. */
    surfaceLegDays: 0.25,
    sameBodyDays: 0.5,
    /** Surface ascent/descent delta-v as a multiple of surface circular speed. */
    surfaceDvFactor: 1.2,
    /** Local transfer parking radius as a multiple of body radius. */
    lowOrbitFactor: 1.05,
    /** Days added per km/s of delta-v when scoring Lambert launch windows. */
    transferDaysPerKmS: 0.5,
  },
};
