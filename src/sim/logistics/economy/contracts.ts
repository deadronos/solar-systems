import { CONTRACT_PENALTY_FRACTION } from '../core/commands.ts';
import { TICK_DAYS } from '../core/time.ts';
import { sortedIds, type LogisticsWorld } from '../core/world.ts';
import { askPrice, spareStock } from './markets.ts';
import { availableFunds, commit, outstanding, release } from './treasury.ts';
import { GOOD_IDS, type Contract, type GoodId, type Settlement } from './types.ts';

/** Post when projected stock (stock + inbound) falls below this fraction of target. */
const POST_THRESHOLD = 0.5;
/** A single contract may commit at most this fraction of the treasury. */
const MAX_TREASURY_FRACTION = 0.5;
/** Contracts are generated once per this many days. */
const GENERATION_INTERVAL_DAYS = 1;
const MIN_DEADLINE_DAYS = 120;
/** Deadline = this multiple of the expected haul (minimum MIN_DEADLINE_DAYS). */
const DEADLINE_TRIP_MULTIPLE = 3;
/** Unfilled orders are reposted with fees raised by this factor, up to the cap. */
const ESCALATION_STEP = 1.5;
const ESCALATION_CAP = 8;
const FREIGHT_FEE_MARKUP = 1.5;
/** Floor on the haul cost used to price a contract, so short hops are still worth a ship. */
const MIN_HAUL_COST = 50_000;
/** Finished contracts are forgotten after this many days. */
const PRUNE_AFTER_DAYS = 90;
/** Largest single contract (tonnes) — bigger needs are split over successive postings. */
const MAX_CONTRACT_QTY = 800;
/** Lead time assumed when no source can currently be routed (days). */
const DEFAULT_LEAD_DAYS = 365;
/** Premium multiplier while the buyer is short of survival goods. */
const SHORTAGE_PREMIUM_FACTOR = 2;
/** Non-survival orders may only commit this fraction of the treasury (survival comes first). */
const NON_SURVIVAL_TREASURY_FRACTION = 0.15;

/** Tonnes already contracted (open, accepted or loaded) to a settlement for a good. */
export function inboundQty(world: LogisticsWorld, settlementId: string, good: GoodId): number {
  let q = 0;
  for (const c of world.contracts.values()) {
    if (
      c.settlementId === settlementId &&
      c.good === good &&
      (c.status === 'open' || c.status === 'accepted' || c.status === 'loaded')
    ) {
      q += c.qty;
    }
  }
  return q;
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
  for (const cls of bulk) {
    const est = world.nav.estimateCached(cls, from, to, world.jd);
    if (!est) continue;
    const days = est.arriveJd - world.jd;
    // A carrier makes the whole trip regardless of load size, so price the full trip.
    const cost =
      est.fuelT * fuelPrice +
      est.exoticCost +
      cls.upkeepPerDay * days +
      2 * world.constants.dockingFee;
    return { days, cost: Math.max(cost, MIN_HAUL_COST) };
  }
  return null;
}

/** A same-body neighbour with spare stock, if any (cheapest ask). */
function bestLocalSource(world: LogisticsWorld, buyer: Settlement, good: GoodId, qty: number) {
  let best: { s: Settlement; price: number } | null = null;
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.id === buyer.id || s.site.bodyId !== buyer.site.bodyId) continue;
    const e = s.market[good];
    const spare = spareStock(s, good);
    if (spare < qty) continue;
    const price = askPrice(e, world.constants);
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
    const spare = spareStock(s, good);
    if (spare < qty || (!s.isDeepMarket && e.productionPerDay <= 0)) continue;
    const trip = tripCostAndDays(world, s, buyer, qty);
    if (!trip) continue;
    const price = askPrice(e, world.constants);
    const landed = price * qty + trip.cost * FREIGHT_FEE_MARKUP;
    if (!best || landed < best.landed) best = { s, price, trip, landed };
  }
  return best;
}

/** Money a settlement keeps back for a year of survival imports at worst-case prices. */
function survivalReserve(world: LogisticsWorld, s: Settlement): number {
  const c = world.constants;
  let perDay = 0;
  for (const [g, perCapita] of Object.entries(c.needsPerCapitaPerDay.survival)) {
    perDay +=
      s.population *
      (perCapita ?? 0) *
      (world.goods.get(g as GoodId)?.basePrice ?? 0) *
      c.priceClampMax;
  }
  return perDay * 365;
}

function post(world: LogisticsWorld, buyer: Settlement, good: GoodId): void {
  const c = world.constants;
  const e = buyer.market[good];
  if (e.targetStock <= 0) return;
  // Self-supplied goods (local output keeps up with use) are never imported.
  if (e.productionPerDay >= e.consumptionPerDay) return;
  const survival = world.goods.get(good)?.category === 'survival';
  if (!survival && buyer.inShortage) return;
  // Only money not already promised to other orders may be committed.
  const funds = availableFunds(buyer);
  const budget = survival
    ? funds * MAX_TREASURY_FRACTION
    : Math.max(0, funds - survivalReserve(world, buyer)) * NON_SURVIVAL_TREASURY_FRACTION;

  // Local shuttle: neighbours on the same body (e.g. Gateway ↔ Earth Exchange) are one
  // economy — top up straight from them whenever stock in hand runs low. No ship needed.
  if (e.stock < POST_THRESHOLD * e.targetStock) {
    const want = Math.ceil(e.targetStock - e.stock);
    const local = bestLocalSource(world, buyer, good, want);
    if (local) {
      const qty = Math.min(want, Math.floor((budget - 2 * c.dockingFee) / local.price));
      if (qty >= 1) {
        const cost = local.price * qty + 2 * c.dockingFee;
        buyer.treasury -= cost;
        e.stock += qty;
        if (!local.s.isDeepMarket) {
          local.s.market[good].stock -= qty;
          local.s.treasury += local.price * qty;
        }
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
  const lead = bestSource(world, buyer, good, Math.min(MAX_CONTRACT_QTY, e.targetStock));
  const leadDays = lead ? lead.trip.days : DEFAULT_LEAD_DAYS;
  const desired = e.targetStock + e.consumptionPerDay * leadDays;
  const projected = e.stock + inboundQty(world, buyer.id, good);
  if (projected >= POST_THRESHOLD * desired) return;
  let qty = Math.min(MAX_CONTRACT_QTY, Math.ceil(desired - projected));
  const premium = c.contractPremium * (buyer.inShortage ? SHORTAGE_PREMIUM_FACTOR : 1);
  const unitReward = e.price * (1 + premium);
  const escalation = buyer.orderEscalation[good] ?? 1;
  qty = Math.min(qty, Math.floor(budget / unitReward));
  if (qty < 1) return;

  // Freight: reserve the goods at the best source now and pay a carrier only to haul them.
  // The buyer pays for the goods when they are loaded (escrow) and the fee on delivery.
  const source = bestSource(world, buyer, good, qty);
  if (source) {
    const trip = source.trip;
    {
      const fee = trip.cost * FREIGHT_FEE_MARKUP * escalation;
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
          deadlineDays: Math.max(MIN_DEADLINE_DAYS, DEADLINE_TRIP_MULTIPLE * trip.days),
        });
        return;
      }
    }
  }

  // Delivery: the carrier sources the cargo wherever it likes. The reward covers the
  // goods at local value plus the premium and the expected cost of hauling them.
  const trip = source?.trip ?? null;
  const reward = unitReward * qty + (trip?.cost ?? 0) * FREIGHT_FEE_MARKUP * escalation;
  if (reward > budget) return;
  addContract(world, {
    escrowCost: 0,
    kind: 'delivery',
    settlementId: buyer.id,
    pickupSettlementId: null,
    good,
    qty,
    reward,
    deadlineDays: Math.max(MIN_DEADLINE_DAYS, DEADLINE_TRIP_MULTIPLE * (trip?.days ?? 0)),
  });
}

function addContract(
  world: LogisticsWorld,
  p: Pick<
    Contract,
    'kind' | 'settlementId' | 'pickupSettlementId' | 'good' | 'qty' | 'reward' | 'escrowCost'
  > & {
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
  });
  world.schedule(contract.deadlineJd, (w) => expireContract(w, contract.id));
}

/** Deadline handler: open → expired; accepted/loaded → expired with a carrier penalty. */
export function expireContract(world: LogisticsWorld, contractId: string): void {
  const c = world.contracts.get(contractId);
  if (!c || c.status === 'completed' || c.status === 'expired' || c.late) return;
  let penalty = 0;
  const companyId = c.companyId;
  if (c.status === 'accepted' || c.status === 'loaded') {
    penalty = c.reward * CONTRACT_PENALTY_FRACTION;
    const company = companyId ? world.companies.get(companyId) : undefined;
    if (company) {
      company.cash -= penalty;
      company.stats.costs += penalty;
    }
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
  // Reserved freight that was never loaded goes back to the pickup's stock.
  if (c.kind === 'freight' && c.pickupSettlementId) {
    const pickup = world.settlements.get(c.pickupSettlementId);
    if (pickup && !pickup.isDeepMarket) pickup.market[c.good].stock += c.qty;
  }
  if (c.status === 'open') {
    if (buyer) {
      buyer.orderEscalation[c.good] = Math.min(
        ESCALATION_CAP,
        (buyer.orderEscalation[c.good] ?? 1) * ESCALATION_STEP,
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

/** Post contracts for shortages (once per day). */
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
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.isDeepMarket) continue;
    for (const g of GOOD_IDS) {
      if (s.market[g].consumptionPerDay <= 0) continue;
      // Open orders count as inbound, so this posts more only while still short.
      post(world, s, g);
    }
  }
}
