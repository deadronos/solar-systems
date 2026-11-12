import { CONTRACT_PENALTY_FRACTION } from '../core/commands.ts';
import { TICK_DAYS } from '../core/time.ts';
import { sortedIds, type LogisticsWorld } from '../core/world.ts';
import { askPrice } from './markets.ts';
import { GOOD_IDS, type Contract, type GoodId, type Settlement, type ShipClass } from './types.ts';

/** Post when projected stock (stock + inbound) falls below this fraction of target. */
const POST_THRESHOLD = 0.5;
/** A single contract may commit at most this fraction of the treasury. */
const MAX_TREASURY_FRACTION = 0.5;
/** Contracts are generated once per this many days. */
const GENERATION_INTERVAL_DAYS = 1;
const MIN_DEADLINE_DAYS = 30;
const FREIGHT_FEE_MARKUP = 1.3;
/** A source must keep at least this fraction of its own target stock. */
const SOURCE_RESERVE = 0.5;
/** Finished contracts are forgotten after this many days. */
const PRUNE_AFTER_DAYS = 90;
/** Largest single contract (tonnes) — bigger needs are split over successive postings. */
const MAX_CONTRACT_QTY = 1_500;
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

/** Reference hauler used to estimate freight fees and deadlines (a tier-2 bulk freighter). */
function referenceClass(world: LogisticsWorld): ShipClass | undefined {
  const all = [...world.shipClasses.values()];
  return all.find((c) => c.id === 'ntr-freighter') ?? all.find((c) => c.tier === 2) ?? all[0];
}

function tripCostAndDays(world: LogisticsWorld, from: Settlement, to: Settlement, qty: number) {
  const cls = referenceClass(world);
  if (!cls) return null;
  const est = world.nav.estimateCached(cls, from, to, world.jd);
  if (!est) return null;
  const days = est.arriveJd - world.jd;
  const fuelPrice = world.goods.get('fuel')?.basePrice ?? 0;
  const cost = est.fuelT * fuelPrice + est.exoticCost + cls.upkeepPerDay * days;
  // A carrier makes the whole trip regardless of load size, so price the full trip.
  void qty;
  return { days, cost };
}

function cheapestSource(world: LogisticsWorld, buyer: Settlement, good: GoodId, qty: number) {
  let best: { s: Settlement; price: number } | null = null;
  for (const id of sortedIds(world.settlements)) {
    if (id === buyer.id) continue;
    const s = world.settlements.get(id)!;
    const e = s.market[good];
    const spare = s.isDeepMarket
      ? Number.POSITIVE_INFINITY
      : e.stock - SOURCE_RESERVE * e.targetStock;
    if (spare < qty || (!s.isDeepMarket && e.productionPerDay <= 0)) continue;
    const price = askPrice(e, world.constants);
    if (!best || price < best.price) best = { s, price };
  }
  return best;
}

function post(world: LogisticsWorld, buyer: Settlement, good: GoodId): void {
  const c = world.constants;
  const e = buyer.market[good];
  const projected = e.stock + inboundQty(world, buyer.id, good);
  if (e.targetStock <= 0 || projected >= POST_THRESHOLD * e.targetStock) return;
  let qty = Math.min(MAX_CONTRACT_QTY, Math.ceil(e.targetStock - projected));
  const premium = c.contractPremium * (buyer.inShortage ? SHORTAGE_PREMIUM_FACTOR : 1);
  const unitReward = e.price * (1 + premium);
  const survival = world.goods.get(good)?.category === 'survival';
  if (!survival && buyer.inShortage) return;
  const budget =
    Math.max(0, buyer.treasury) *
    (survival ? MAX_TREASURY_FRACTION : NON_SURVIVAL_TREASURY_FRACTION);
  qty = Math.min(qty, Math.floor(budget / unitReward));
  if (qty < 1) return;

  // Freight: buy at a cheaper source now and pay a carrier only to haul it.
  const source = cheapestSource(world, buyer, good, qty);
  if (source) {
    const trip = tripCostAndDays(world, source.s, buyer, qty);
    if (trip) {
      const fee = trip.cost * FREIGHT_FEE_MARKUP;
      const total = source.price * qty + fee;
      if (total < e.price * qty && total <= budget) {
        buyer.treasury -= source.price * qty;
        if (!source.s.isDeepMarket) {
          source.s.market[good].stock -= qty;
          source.s.treasury += source.price * qty;
        }
        addContract(world, {
          kind: 'freight',
          settlementId: buyer.id,
          pickupSettlementId: source.s.id,
          good,
          qty,
          reward: fee,
          deadlineDays: Math.max(MIN_DEADLINE_DAYS, 2 * trip.days),
        });
        return;
      }
    }
  }

  // Delivery: the carrier sources the cargo wherever it likes. The reward covers the
  // goods at local value plus the premium and the expected cost of hauling them.
  const from = source?.s ?? [...world.settlements.values()].find((s) => s.isDeepMarket);
  const trip = from ? tripCostAndDays(world, from, buyer, qty) : null;
  const reward = unitReward * qty + (trip?.cost ?? 0) * FREIGHT_FEE_MARKUP;
  if (reward > budget) return;
  addContract(world, {
    kind: 'delivery',
    settlementId: buyer.id,
    pickupSettlementId: null,
    good,
    qty,
    reward,
    deadlineDays: Math.max(MIN_DEADLINE_DAYS, 2 * (trip?.days ?? 0)),
  });
}

function addContract(
  world: LogisticsWorld,
  p: Pick<Contract, 'kind' | 'settlementId' | 'pickupSettlementId' | 'good' | 'qty' | 'reward'> & {
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
  };
  world.contracts.set(contract.id, contract);
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
  if (!c || c.status === 'completed' || c.status === 'expired') return;
  let penalty = 0;
  const companyId = c.companyId;
  if (c.status === 'accepted' || c.status === 'loaded') {
    penalty = c.reward * CONTRACT_PENALTY_FRACTION;
    const company = companyId ? world.companies.get(companyId) : undefined;
    if (company) {
      company.cash -= penalty;
      company.stats.costs += penalty;
    }
    const ship = c.shipId ? world.ships.get(c.shipId) : undefined;
    if (ship && ship.contractId === c.id) ship.contractId = null;
  }
  // Escrowed freight that was never loaded returns to the pickup market.
  if (c.kind === 'freight' && c.status !== 'loaded' && c.pickupSettlementId) {
    const pickup = world.settlements.get(c.pickupSettlementId);
    if (pickup && !pickup.isDeepMarket) pickup.market[c.good].stock += c.qty;
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
  // Forget old finished contracts, and index the active ones by settlement × good.
  const open = new Set<string>();
  for (const [id, c] of world.contracts) {
    if (
      (c.status === 'completed' || c.status === 'expired') &&
      c.deadlineJd < world.jd - PRUNE_AFTER_DAYS
    ) {
      world.contracts.delete(id);
    } else if (c.status === 'open') {
      open.add(`${c.settlementId}|${c.good}`);
    }
  }
  for (const id of sortedIds(world.settlements)) {
    const s = world.settlements.get(id)!;
    if (s.isDeepMarket) continue;
    for (const g of GOOD_IDS) {
      if (s.market[g].consumptionPerDay <= 0) continue;
      if (!open.has(`${s.id}|${g}`)) post(world, s, g);
    }
  }
}
