import { TICK_DAYS } from '../core/time.ts';
import { sortedIds } from '../core/sortedIds.ts';
import type { LogisticsWorld } from '../core/world.ts';
import { penaltyFor } from '../core/commands.ts';
import { askPrice, quoteBuy, quoteSell, recordDeepTrade, spareStock } from './markets.ts';
import { companyPays, creditSettlement } from './money.ts';
import { availableFunds, commit, outstanding, release } from './treasury.ts';
import { GOOD_IDS, type Contract, type GoodId, type Settlement } from './types.ts';

/** Contracts are generated once per this many days. */
const GENERATION_INTERVAL_DAYS = 1;
/** Finished contracts are forgotten after this many days. */
const PRUNE_AFTER_DAYS = 90;
/**
 * Hauls are priced from orbital geometry at the start of the current week of this many days.
 * Fees are estimates anyway, and re-solving every pair daily dominated the tick cost.
 */
const HAUL_PRICING_BUCKET_DAYS = 7;

/** Tonnes already contracted (open, accepted or loaded) to a settlement for a good. */
export function inboundQty(world: LogisticsWorld, settlementId: string, good: GoodId): number {
  return liveOrders(world).inbound.get(orderKey(settlementId, good)) ?? 0;
}

const orderKey = (settlementId: string, good: GoodId) => `${settlementId}|${good}`;

/**
 * Tonnes on live buy orders per (settlement, good), and the pairs with a live sell order, in
 * one pass over the contract table. Sums accumulate in table order, so each total matches a
 * per-pair scan exactly.
 */
function liveOrders(world: LogisticsWorld): { inbound: Map<string, number>; selling: Set<string> } {
  const inbound = new Map<string, number>();
  const selling = new Set<string>();
  for (const c of world.contracts.values()) {
    if (c.status !== 'open' && c.status !== 'accepted' && c.status !== 'loaded') continue;
    const key = orderKey(c.settlementId, c.good);
    if (c.kind === 'export') selling.add(key);
    else inbound.set(key, (inbound.get(key) ?? 0) + c.qty);
  }
  return { inbound, selling };
}

/**
 * Price a haul with the cheapest-to-run tier 1–2 class that can carry the load and fly the
 * route (falls back through progressively costlier classes).
 */
function tripCostAndDays(world: LogisticsWorld, from: Settlement, to: Settlement, qty: number) {
  const bulk = [...world.shipClasses.values()]
    .filter((c) => c.tier <= 2 && c.cargoT >= qty)
    .toSorted((a, b) => a.upkeepPerDay - b.upkeepPerDay || a.id.localeCompare(b.id));
  const fuelPrice = world.goods.get('fuel')?.basePrice ?? 0;
  const start = world.config.startJd;
  const pricedJd =
    start +
    Math.floor((world.jd - start) / HAUL_PRICING_BUCKET_DAYS + 1e-9) * HAUL_PRICING_BUCKET_DAYS;
  for (const cls of bulk) {
    const est = world.nav.estimateCached(cls, from, to, pricedJd, qty);
    if (!est) continue;
    const days = est.arriveJd - pricedJd;
    // A carrier makes the whole trip regardless of load size, so price the full trip.
    const cost =
      est.fuelT * fuelPrice +
      est.exoticCost +
      cls.upkeepPerDay * days +
      2 * world.constants.ships.dockingFee;
    return { days, cost: Math.max(cost, world.constants.contracts.minHaulCost) };
  }
  return null;
}

/** A same-body neighbour with spare stock, if any (cheapest ask). */
function bestLocalSource(world: LogisticsWorld, buyer: Settlement, good: GoodId, qty: number) {
  let best: { s: Settlement; price: number } | null = null;
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.id === buyer.id || s.site.bodyId !== buyer.site.bodyId) continue;
    const spare = spareStock(s, good, world.constants.contracts.sourceReserveFraction);
    if (spare < qty) continue;
    const price = quoteBuy(world, s, good, qty);
    if (!best || price < best.price) best = { s, price };
  }
  return best;
}

interface SourceOption {
  s: Settlement;
  price: number;
  trip: { days: number; cost: number };
  landed: number;
}

/** Cheapest place to source `qty` by landed cost (goods + haul), excluding the buyer. */
function bestSource(
  world: LogisticsWorld,
  buyer: Settlement,
  good: GoodId,
  qty: number,
): SourceOption | null {
  let best: SourceOption | null = null;
  for (const id of sortedIds(world.settlements)) {
    if (id === buyer.id) continue;
    const s = world.settlements.get(id)!;
    const e = s.market[good];
    const spare = spareStock(s, good, world.constants.contracts.sourceReserveFraction);
    if (spare < qty || (!s.isDeepMarket && e.productionPerDay <= 0)) continue;
    const trip = tripCostAndDays(world, s, buyer, qty);
    if (!trip) continue;
    const price = quoteBuy(world, s, good, qty);
    const landed = price * qty + trip.cost * world.constants.contracts.freightFeeMarkup;
    if (!best || landed < best.landed) best = { s, price, trip, landed };
  }
  return best;
}

/** Money a settlement keeps back for a year of survival imports at worst-case prices. */
export function survivalReserve(world: LogisticsWorld, s: Settlement): number {
  const c = world.constants;
  let perDay = 0;
  for (const [g, perCapita] of Object.entries(c.population.needsPerCapitaPerDay.survival)) {
    perDay +=
      s.population *
      (perCapita ?? 0) *
      (world.goods.get(g as GoodId)?.basePrice ?? 0) *
      c.markets.priceClampMax;
  }
  return perDay * c.contracts.survivalTreasuryReserveDays;
}

/** Share (0..1) of a settlement's use of a good that is its population's survival needs. */
export function lifeSupportShare(world: LogisticsWorld, s: Settlement, good: GoodId): number {
  const perCapita = world.constants.population.needsPerCapitaPerDay.survival[good] ?? 0;
  const consumption = s.market[good].consumptionPerDay;
  if (!(consumption > 0)) return 1;
  return Math.min(1, (s.population * perCapita) / consumption);
}

/** Money a settlement may commit to one more buy order for a good. */
function orderBudget(world: LogisticsWorld, buyer: Settlement, good: GoodId): number {
  const c = world.constants.contracts;
  // Only money not already promised to other orders may be committed.
  const funds = availableFunds(buyer);
  const guarded =
    Math.max(0, funds - survivalReserve(world, buyer)) * c.nonSurvivalTreasuryFraction;
  // Only the population's own use of a survival good gets the life-support budget. Industry
  // using it as an input (water for electrolysis) must not spend the reserve kept for food.
  const survival = world.goods.get(good)?.category === 'survival';
  const lifeShare = survival ? lifeSupportShare(world, buyer, good) : 0;
  return lifeShare * funds * c.maxTreasuryFraction + (1 - lifeShare) * guarded;
}

/** Unit reward a delivery order offers: the local price plus the contract premium. */
function deliveryUnitReward(world: LogisticsWorld, buyer: Settlement, good: GoodId): number {
  const c = world.constants.contracts;
  const premium = c.contractPremium * (buyer.inShortage ? c.shortagePremiumFactor : 1);
  return buyer.market[good].price * (1 + premium);
}

/** Delivery reward for `qty`: the goods at local value plus the expected cost of hauling them. */
function deliveryReward(
  world: LogisticsWorld,
  buyer: Settlement,
  good: GoodId,
  qty: number,
  trip: { cost: number } | null,
): number {
  const escalation = buyer.orderEscalation[good] ?? 1;
  return (
    deliveryUnitReward(world, buyer, good) * qty +
    (trip?.cost ?? 0) * world.constants.contracts.freightFeeMarkup * escalation
  );
}

/** Raise an open order's reward only when the fresh price beats it by this factor. */
const REPRICE_ABOVE = 1.1;

/**
 * An open survival order nobody has taken follows its settlement's price up: the goods part
 * of the reward is raised to the current local price plus premium, if the settlement can
 * afford it. Rewards used to be fixed when posted, so an order placed in a glut sat
 * unaccepted for years while its colony ran out of food (#15). The haul part is left alone,
 * or freight escalation would compound across every open order.
 */
function repriceOpenOrders(world: LogisticsWorld): void {
  for (const id of sortedIds(world.contracts)) {
    const c = world.contracts.get(id)!;
    if (c.kind !== 'delivery' || c.status !== 'open' || c.unitReward === undefined) continue;
    if (world.goods.get(c.good)?.category !== 'survival') continue;
    const buyer = world.settlements.get(c.settlementId);
    if (!buyer || buyer.isDeepMarket) continue;
    const unit = deliveryUnitReward(world, buyer, c.good);
    if (unit <= c.unitReward * REPRICE_ABOVE) continue;
    const raise = Math.min((unit - c.unitReward) * c.qty, orderBudget(world, buyer, c.good));
    if (!(raise > 0)) continue;
    c.reward += raise;
    c.unitReward += raise / c.qty;
    commit(buyer, raise);
  }
}

function post(
  world: LogisticsWorld,
  buyer: Settlement,
  good: GoodId,
  inbound: ReadonlyMap<string, number>,
): void {
  const c = world.constants.contracts;
  const { dockingFee } = world.constants.ships;
  const e = buyer.market[good];
  if (e.targetStock <= 0) return;
  // Self-supplied goods (local output keeps up with use) are never imported.
  if (e.productionPerDay >= e.consumptionPerDay) return;
  const survival = world.goods.get(good)?.category === 'survival';
  if (!survival && buyer.inShortage) return;
  const budget = orderBudget(world, buyer, good);

  // Local shuttle: neighbours on the same body (e.g. Gateway ↔ Earth Exchange) are one
  // economy — top up straight from them whenever stock in hand runs low. No ship needed.
  if (e.stock < c.postThreshold * e.targetStock) {
    const want = Math.ceil(e.targetStock - e.stock);
    const local = bestLocalSource(world, buyer, good, want);
    if (local) {
      // The quote for `want` bounds the price per tonne of any smaller order.
      const qty = Math.min(want, Math.floor((budget - 2 * dockingFee) / local.price));
      if (qty >= 1) {
        // The neighbour is paid for the goods and its port fees.
        const cost = quoteBuy(world, local.s, good, qty) * qty + 2 * dockingFee;
        creditSettlement(world, buyer, -cost);
        creditSettlement(world, local.s, cost);
        e.stock += qty;
        if (!local.s.isDeepMarket) local.s.market[good].stock -= qty;
        recordDeepTrade(local.s, good, -qty);
        world.events.append(world.jd, {
          type: 'LocalShuttle',
          settlementId: buyer.id,
          pickupSettlementId: local.s.id,
          good,
          qty,
          cost,
        });
      }
      return;
    }
  }

  // Cover consumption during the delivery lead time as well as the normal buffer.
  const lead = bestSource(world, buyer, good, Math.min(c.maxContractQtyT, e.targetStock));
  const leadDays = lead ? lead.trip.days : c.defaultLeadDays;
  const desired = e.targetStock + e.consumptionPerDay * leadDays;
  const projected = e.stock + (inbound.get(orderKey(buyer.id, good)) ?? 0);
  if (projected >= c.postThreshold * desired) return;
  let qty = Math.min(c.maxContractQtyT, Math.ceil(desired - projected));
  const unitReward = deliveryUnitReward(world, buyer, good);
  const escalation = buyer.orderEscalation[good] ?? 1;
  qty = Math.min(qty, Math.floor(budget / unitReward));
  if (qty < 1) return;

  // Freight: reserve the goods at the best source now and pay a carrier only to haul them.
  // The buyer pays for the goods when they are loaded (escrow) and the fee on delivery.
  const source = bestSource(world, buyer, good, qty);
  if (source) {
    const trip = source.trip;
    {
      const fee = trip.cost * c.freightFeeMarkup * escalation;
      const total = source.price * qty + fee;
      if (total < e.price * qty && total <= budget) {
        if (!source.s.isDeepMarket) source.s.market[good].stock -= qty;
        addContract(world, {
          escrowCost: source.price * qty,
          kind: 'freight',
          settlementId: buyer.id,
          pickupSettlementId: source.s.id,
          good,
          qty,
          reward: fee,
          deadlineDays: Math.max(c.minDeadlineDays, c.deadlineTripMultiple * trip.days),
        });
        return;
      }
    }
  }

  // Delivery: the carrier sources the cargo wherever it likes. The reward covers the
  // goods at local value plus the premium and the expected cost of hauling them.
  const trip = source?.trip ?? null;
  const reward = deliveryReward(world, buyer, good, qty, trip);
  if (reward > budget) return;
  addContract(world, {
    escrowCost: 0,
    kind: 'delivery',
    settlementId: buyer.id,
    pickupSettlementId: null,
    good,
    qty,
    reward,
    unitReward,
    deadlineDays: Math.max(c.minDeadlineDays, c.deadlineTripMultiple * (trip?.days ?? 0)),
  });
}

/**
 * Local shuttle, outbound: a producer on the same body as a deep market (Gateway above Earth
 * Exchange) sells stock above `sellOrderStockMultiple` × target straight to it at its bid,
 * paying both port fees. Without this a station's exports waited for a passing trader, and
 * investment valued them at an Earth netback the station could never collect. Returns true
 * when it sold, so no sell order is posted for the same goods.
 */
function shuttleSurplus(world: LogisticsWorld, seller: Settlement, good: GoodId): boolean {
  const c = world.constants.contracts;
  const e = seller.market[good];
  if (e.targetStock <= 0 || e.productionPerDay <= e.consumptionPerDay) return false;
  const qty = Math.floor(e.stock - c.sellOrderStockMultiple * e.targetStock);
  if (qty < c.minSellOrderT) return false;
  let buyer: Settlement | null = null;
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.isDeepMarket && s.site.bodyId === seller.site.bodyId) {
      buyer = s;
      break;
    }
  }
  if (!buyer) return false;
  const proceeds =
    quoteSell(world, buyer, good, qty, Number.POSITIVE_INFINITY) * qty -
    2 * world.constants.ships.dockingFee;
  if (!(proceeds > 0)) return false;
  creditSettlement(world, buyer, -proceeds);
  creditSettlement(world, seller, proceeds);
  e.stock -= qty;
  recordDeepTrade(buyer, good, qty);
  world.events.append(world.jd, {
    type: 'LocalShuttle',
    settlementId: buyer.id,
    pickupSettlementId: seller.id,
    good,
    qty,
    cost: proceeds,
  });
  return true;
}

/**
 * A producer offers stock above `sellOrderStockMultiple` × target to carriers at a discount
 * (a sell order), at most one live order per good. The goods are reserved until it ends.
 */
function postSellOrder(
  world: LogisticsWorld,
  seller: Settlement,
  good: GoodId,
  selling: ReadonlySet<string>,
): void {
  const c = world.constants.contracts;
  const e = seller.market[good];
  if (e.targetStock <= 0 || e.productionPerDay <= e.consumptionPerDay) return;
  if (selling.has(orderKey(seller.id, good))) return;
  const qty = Math.min(
    c.maxContractQtyT,
    Math.floor(e.stock - c.sellOrderStockMultiple * e.targetStock),
  );
  if (qty < c.minSellOrderT) return;
  const unitPrice = askPrice(e, world.constants.markets) * (1 - c.sellOrderDiscount);
  e.stock -= qty;
  addContract(world, {
    escrowCost: unitPrice * qty,
    kind: 'export',
    settlementId: seller.id,
    pickupSettlementId: seller.id,
    good,
    qty,
    reward: 0,
    deadlineDays: c.minDeadlineDays,
  });
}

function addContract(
  world: LogisticsWorld,
  p: Pick<
    Contract,
    'kind' | 'settlementId' | 'pickupSettlementId' | 'good' | 'qty' | 'reward' | 'escrowCost'
  > &
    Partial<Pick<Contract, 'unitReward'>> & {
      deadlineDays: number;
    },
): void {
  const contract: Contract = {
    id: world.nextId('contract'),
    kind: p.kind,
    settlementId: p.settlementId,
    pickupSettlementId: p.pickupSettlementId,
    good: p.good,
    qty: p.qty,
    reward: p.reward,
    postedJd: world.jd,
    deadlineJd: world.jd + p.deadlineDays,
    status: 'open',
    companyId: null,
    shipId: null,
    escrowCost: p.escrowCost,
    late: false,
    ...(p.unitReward === undefined ? {} : { unitReward: p.unitReward }),
  };
  world.contracts.set(contract.id, contract);
  const buyer = world.settlements.get(contract.settlementId);
  if (buyer) commit(buyer, outstanding(contract));
  world.events.append(world.jd, {
    type: 'ContractPosted',
    contractId: contract.id,
    settlementId: contract.settlementId,
    good: contract.good,
    qty: contract.qty,
    reward: contract.reward,
    kind: contract.kind,
    ...(contract.pickupSettlementId ? { pickupSettlementId: contract.pickupSettlementId } : {}),
    ...(contract.kind === 'export' ? { price: contract.escrowCost } : {}),
  });
  world.schedule(contract.deadlineJd, { kind: 'expireContract', contractId: contract.id });
}

/**
 * Deadline handler: open → expired; accepted/loaded → expired with a carrier penalty, paid
 * to the settlement that posted the order.
 */
export function expireContract(world: LogisticsWorld, contractId: string): void {
  const c = world.contracts.get(contractId);
  if (!c || c.status === 'completed' || c.status === 'expired' || c.late) return;
  let penalty = 0;
  const companyId = c.companyId;
  if (c.status === 'accepted' || c.status === 'loaded') {
    penalty = penaltyFor(world, c);
    const company = companyId ? world.companies.get(companyId) : undefined;
    const poster = world.settlements.get(c.settlementId);
    if (company && poster) companyPays(world, company, null, poster, penalty);
    else penalty = 0;
  }
  // Loaded freight belongs to the buyer: it stays deliverable (late) instead of becoming
  // the carrier's cargo to sell.
  if (c.status === 'loaded') {
    c.late = true;
    world.events.append(world.jd, {
      type: 'ContractExpired',
      contractId: c.id,
      settlementId: c.settlementId,
      ...(companyId ? { companyId } : {}),
      penalty,
    });
    return;
  }
  if (c.status === 'accepted') {
    const ship = c.shipId ? world.ships.get(c.shipId) : undefined;
    if (ship && ship.contractId === c.id) ship.contractId = null;
  }
  const buyer = world.settlements.get(c.settlementId);
  // The buyer's promise lapses (nothing was paid yet: escrow is only paid at loading).
  if (buyer) release(buyer, outstanding(c));
  // Reserved goods that were never loaded go back to the pickup's stock.
  if (c.kind !== 'delivery' && c.pickupSettlementId) {
    const pickup = world.settlements.get(c.pickupSettlementId);
    if (pickup && !pickup.isDeepMarket) pickup.market[c.good].stock += c.qty;
  }
  if (c.status === 'open' && c.kind !== 'export') {
    if (buyer) {
      buyer.orderEscalation[c.good] = Math.min(
        world.constants.contracts.escalationCap,
        (buyer.orderEscalation[c.good] ?? 1) * world.constants.contracts.escalationStep,
      );
    }
  }
  c.status = 'expired';
  world.events.append(world.jd, {
    type: 'ContractExpired',
    contractId: c.id,
    settlementId: c.settlementId,
    ...(companyId ? { companyId } : {}),
    penalty,
  });
}

/** Post buy orders for shortages and sell orders for surpluses (once per day). */
export function generateContracts(world: LogisticsWorld): void {
  const ticksPerRun = Math.round(GENERATION_INTERVAL_DAYS / TICK_DAYS);
  const tick = Math.round((world.jd - world.config.startJd) / TICK_DAYS);
  if (tick % ticksPerRun !== 0) return;
  // Forget old finished contracts.
  for (const [id, c] of world.contracts) {
    if (
      (c.status === 'completed' || c.status === 'expired') &&
      c.deadlineJd < world.jd - PRUNE_AFTER_DAYS
    ) {
      world.contracts.delete(id);
    }
  }
  // Each post() adds contracts only for its own (settlement, good), so totals taken once here
  // stay exact for every pair visited after it.
  repriceOpenOrders(world);
  const { inbound, selling } = liveOrders(world);
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.isDeepMarket) continue;
    for (const g of GOOD_IDS) {
      // Open orders count as inbound, so this posts more only while still short.
      if (s.market[g].consumptionPerDay > 0) post(world, s, g, inbound);
      if (!shuttleSurplus(world, s, g)) postSellOrder(world, s, g, selling);
    }
  }
}
