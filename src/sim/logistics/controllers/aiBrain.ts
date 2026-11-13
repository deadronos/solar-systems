import { ECONOMY_CONSTANTS } from '../data/economyConstants.ts';
import { cargoMass, type Command } from '../core/commands.ts';
import { spareStock } from '../economy/markets.ts';
import {
  GOOD_IDS,
  type Contract,
  type GoodId,
  type Ship,
  type ShipClass,
} from '../economy/types.ts';
import { fmtMoney, fmtTonnes } from '../format.ts';
import type { TripEstimate } from '../navigation/planner.ts';
import type { CompanyController, CompanyView, DeepReadonly, WakeReason } from './types.ts';

type Job =
  | { kind: 'trade'; good: GoodId; qty: number; sourceId: string; destId: string; buyPrice: number }
  | { kind: 'contract'; contractId: string };

export interface AiState {
  jobs: [string, Job][];
  nextLook: [string, number][];
  lastBusy: [string, number][];
  lastFleetReview: number | null;
}

interface Candidate {
  score: number;
  /** Built only for the chosen candidate (formatting every option was measurable). */
  label: () => string;
  execute: (decision: ShipDecision) => void;
}

interface ShipDecision {
  commands: Command[];
  intent?: string;
}

/** Top raw opportunities that get a (more expensive) trip estimate. */
const TOP_K = 6;

/** Expected profit after discounting revenue for price risk over the trip length. */
export function riskAdjustedProfit(
  revenue: number,
  cost: number,
  days: number,
  riskAversion: number,
  horizonDays = ECONOMY_CONSTANTS.ai.riskHorizonDays,
): number {
  return revenue * (1 - riskAversion * Math.min(1, days / horizonDays)) - cost;
}

/**
 * Default company brain: greedy, explainable job selection for idle ships plus periodic
 * fleet management. All state it keeps is advisory memory; the world is the truth.
 */
export class AiBrain implements CompanyController {
  #jobs = new Map<string, Job>();
  #nextLook = new Map<string, number>();
  #lastBusy = new Map<string, number>();
  #lastFleetReview: number | null = null;

  capture(): AiState {
    return {
      jobs: [...this.#jobs],
      nextLook: [...this.#nextLook],
      lastBusy: [...this.#lastBusy],
      lastFleetReview: this.#lastFleetReview,
    };
  }

  restore(state: AiState): void {
    this.#jobs = new Map(state.jobs);
    this.#nextLook = new Map(state.nextLook);
    this.#lastBusy = new Map(state.lastBusy);
    this.#lastFleetReview = state.lastFleetReview;
  }

  decide(view: CompanyView, wake: WakeReason[]): Command[] {
    const cmds: Command[] = [];
    const forced = new Set(
      wake.flatMap((w) => (w.kind === 'shipIdle' || w.kind === 'shipArrived' ? [w.shipId] : [])),
    );
    // Forget jobs of ships that no longer exist.
    const alive = new Set(view.ships().map((s) => s.id));
    for (const map of [this.#jobs, this.#nextLook, this.#lastBusy]) {
      for (const id of map.keys()) if (!alive.has(id)) map.delete(id);
    }

    for (const ship of view.ships().toSorted((a, b) => a.id.localeCompare(b.id))) {
      if (ship.state !== 'docked' || !ship.siteId || ship.pendingRemoval) continue;
      if (!forced.has(ship.id) && (this.#nextLook.get(ship.id) ?? 0) > view.jd) continue;
      const decision: ShipDecision = { commands: [] };
      this.#step(view, ship, decision);
      if (decision.intent !== undefined) {
        cmds.push({ type: 'SetIntent', shipId: ship.id, text: decision.intent });
      }
      cmds.push(...decision.commands);
    }
    if (wake.some((w) => w.kind === 'fleetReview')) this.#fleet(view, cmds);
    return cmds;
  }

  // ── Per-ship state machine ─────────────────────────────────────────────────

  #step(view: CompanyView, ship: DeepReadonly<Ship>, decision: ShipDecision): void {
    const here = ship.siteId!;
    // The world is the truth: a contract held by the ship is its job even if memory lost it.
    if (ship.contractId && this.#jobs.get(ship.id)?.kind !== 'contract') {
      this.#jobs.set(ship.id, { kind: 'contract', contractId: ship.contractId });
    }
    const job = this.#jobs.get(ship.id);
    this.#nextLook.set(ship.id, view.jd + view.ai.jobRetryDays);

    if (job?.kind === 'contract') {
      const c = view.contract(job.contractId);
      if (c && (c.status === 'accepted' || c.status === 'loaded') && c.shipId === ship.id) {
        this.#contractStep(view, ship, c, decision);
        return;
      }
      this.#jobs.delete(ship.id);
    }

    if (job?.kind === 'trade') {
      const held = ship.cargo[job.good] ?? 0;
      if (here === job.sourceId && held <= 0) {
        if (this.#buyAndGo(view, ship, job, decision)) return;
        this.#jobs.delete(ship.id);
      } else if (here !== job.destId && held > 0) {
        if (this.#dispatch(view, ship, job.destId, decision.commands)) {
          decision.intent = `Hauling ${fmtTonnes(held)} ${job.good} → ${view.settlement(job.destId)?.name}`;
          return;
        }
        this.#jobs.delete(ship.id);
      } else {
        this.#jobs.delete(ship.id);
      }
    }

    // Unassigned cargo: sell here, otherwise take it to the best buyer.
    if (cargoMass(ship) > 0 && !ship.contractId) {
      if (this.#sellOrRoute(view, ship, decision)) return;
    }

    const best = this.#choose(view, ship);
    if (!best) {
      this.#nextLook.set(ship.id, view.jd + view.ai.idleRetryDays);
      decision.intent = 'Idle — no profitable work nearby';
      return;
    }
    decision.intent = best.label();
    best.execute(decision);
  }

  #contractStep(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    c: DeepReadonly<Contract>,
    decision: ShipDecision,
  ): void {
    const here = ship.siteId!;
    const dest = view.settlement(c.settlementId)!;
    const held = ship.cargo[c.good] ?? 0;
    const label = `Contract: ${fmtTonnes(c.qty)} ${c.good} → ${dest.name} for ${fmtMoney(c.reward)}`;
    if (held >= c.qty - 1e-9) {
      if (here === c.settlementId) {
        decision.commands.push({ type: 'DeliverContract', contractId: c.id });
        this.#jobs.delete(ship.id);
        decision.intent = `Delivered ${c.good} to ${dest.name}`;
        this.#nextLook.set(ship.id, view.jd);
      } else if (this.#dispatch(view, ship, c.settlementId, decision.commands)) {
        decision.intent = label;
      } else {
        this.#giveUp(ship, c, decision);
      }
      return;
    }
    if (c.kind === 'freight') {
      if (here === c.pickupSettlementId) {
        if (cargoMass(ship) + c.qty > view.shipClass(ship.classId).cargoT) {
          this.#giveUp(ship, c, decision);
          return;
        }
        decision.commands.push({ type: 'LoadContractCargo', contractId: c.id });
        if (this.#dispatch(view, ship, c.settlementId, decision.commands)) decision.intent = label;
      } else if (
        c.pickupSettlementId &&
        this.#dispatch(view, ship, c.pickupSettlementId, decision.commands)
      ) {
        decision.intent = `${label} (to pickup at ${view.settlement(c.pickupSettlementId)?.name})`;
      } else {
        this.#giveUp(ship, c, decision);
      }
      return;
    }
    // Delivery contract: source the goods (never at the destination itself).
    const need = c.qty - held;
    if (cargoMass(ship) + need > view.shipClass(ship.classId).cargoT) {
      this.#giveUp(ship, c, decision);
      return;
    }
    if (here !== c.settlementId && this.#spare(view, here, c.good) >= need) {
      const ask = view.ask(here, c.good);
      if (ask * need <= this.#available(view)) {
        decision.commands.push({
          type: 'BuyCargo',
          shipId: ship.id,
          good: c.good,
          qty: need,
          maxPrice: ask * view.ai.buyPriceLimitFactor,
        });
        if (this.#dispatch(view, ship, c.settlementId, decision.commands)) {
          decision.intent = label;
          return;
        }
      }
    }
    const src = this.#landedSource(view, ship, c.good, need, c.settlementId);
    if (src && src !== here && this.#dispatch(view, ship, src, decision.commands)) {
      decision.intent = `${label} (buying at ${view.settlement(src)?.name})`;
      return;
    }
    this.#giveUp(ship, c, decision);
  }

  #giveUp(ship: DeepReadonly<Ship>, c: DeepReadonly<Contract>, decision: ShipDecision): void {
    if (c.status === 'accepted')
      decision.commands.push({ type: 'AbandonContract', contractId: c.id });
    this.#jobs.delete(ship.id);
    decision.intent = `Abandoned contract ${c.id} (no feasible route)`;
  }

  #buyAndGo(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    job: Job & { kind: 'trade' },
    decision: ShipDecision,
  ): boolean {
    const here = ship.siteId!;
    const cls = view.shipClass(ship.classId);
    const ask = view.ask(here, job.good);
    const qty = Math.floor(
      Math.min(
        job.qty,
        cls.cargoT - cargoMass(ship),
        this.#spare(view, here, job.good),
        this.#available(view) / ask,
      ),
    );
    if (qty < Math.max(1, cls.cargoT * view.ai.minLoadFraction)) return false;
    decision.commands.push({
      type: 'BuyCargo',
      shipId: ship.id,
      good: job.good,
      qty,
      maxPrice: ask * view.ai.buyPriceLimitFactor,
    });
    if (!this.#dispatch(view, ship, job.destId, decision.commands)) return false;
    job.qty = qty;
    job.buyPrice = ask;
    decision.intent = `Trade: ${fmtTonnes(qty)} ${job.good} ${view.settlement(here)?.name} ${fmtMoney(ask)}/t → ${view.settlement(job.destId)?.name}`;
    return true;
  }

  #sellOrRoute(view: CompanyView, ship: DeepReadonly<Ship>, decision: ShipDecision): boolean {
    const here = ship.siteId!;
    let remaining = false;
    for (const g of GOOD_IDS) {
      const held = ship.cargo[g] ?? 0;
      if (held <= 0) continue;
      const qty = Math.min(held, view.demandRoom(here, g));
      if (qty > 1e-6 && view.bid(here, g, qty) > 0) {
        decision.commands.push({ type: 'SellCargo', shipId: ship.id, good: g, qty, minPrice: 0 });
      }
      if (held - qty > 1e-6) remaining = true;
    }
    const sold = decision.commands.some((c) => c.type === 'SellCargo' && c.shipId === ship.id);
    if (!remaining) {
      decision.intent = `Sold cargo at ${view.settlement(here)?.name}`;
      // Plan the next job on fresh state (after the sales apply), not in this decision.
      if (sold) {
        this.#nextLook.set(ship.id, view.jd);
        return true;
      }
      return false;
    }
    // Route leftovers to the best paying market.
    let best: { id: string; value: number; good: GoodId } | null = null;
    for (const g of GOOD_IDS) {
      const held = ship.cargo[g] ?? 0;
      if (held <= 0) continue;
      for (const s of view.settlements()) {
        if (s.id === here) continue;
        const q = Math.min(held, view.demandRoom(s.id, g));
        const v = view.bid(s.id, g, q) * q;
        if (v > 0 && (!best || v > best.value)) best = { id: s.id, value: v, good: g };
      }
    }
    if (best && this.#dispatch(view, ship, best.id, decision.commands)) {
      this.#jobs.set(ship.id, {
        kind: 'trade',
        good: best.good,
        qty: ship.cargo[best.good] ?? 0,
        sourceId: here,
        destId: best.id,
        buyPrice: 0,
      });
      decision.intent = `Taking unsold ${best.good} to ${view.settlement(best.id)?.name}`;
      return true;
    }
    return false;
  }

  // ── Job selection ──────────────────────────────────────────────────────────

  #choose(view: CompanyView, ship: DeepReadonly<Ship>): Candidate | null {
    const here = ship.siteId!;
    const cls = view.shipClass(ship.classId);
    const p = view.personality;
    const cash = this.#available(view);
    if (cash <= 0) return null;
    const reservedContracts = new Set(
      [...this.#jobs.values()].flatMap((j) => (j.kind === 'contract' ? [j.contractId] : [])),
    );
    const cands: Candidate[] = [];

    const weightDest = (destId: string, good: GoodId) => {
      let w = 1;
      if (p.preferredGoods?.includes(good)) w *= view.ai.preferredGoodWeight;
      const au = view.distanceFromSunAU(destId);
      if (p.regionBias === 'outer' && au > 2.2) w *= view.ai.outerRegionWeight;
      if (p.regionBias === 'belt' && au > 2 && au < 3.6) w *= view.ai.beltRegionWeight;
      if (p.regionBias === 'inner' && au < 1.8) w *= view.ai.innerRegionWeight;
      return w;
    };

    // A) Contracts.
    for (const c of view.openContracts()) {
      if (reservedContracts.has(c.id) || c.qty > cls.cargoT - cargoMass(ship)) continue;
      const legs: [string, string][] = [];
      let purchase = 0;
      let first: string;
      if (c.kind === 'freight') {
        if (!c.pickupSettlementId) continue;
        first = c.pickupSettlementId;
        if (here !== first) legs.push([here, first]);
        legs.push([first, c.settlementId]);
      } else {
        // Source by landed cost for this ship: goods + getting there + hauling to the buyer.
        let best: { src: string; cost: number; legs: [string, string][] } | null = null;
        for (const s2 of view.settlements()) {
          if (s2.id === c.settlementId || this.#spare(view, s2.id, c.good) < c.qty) continue;
          const l: [string, string][] =
            s2.id === here
              ? [[here, c.settlementId]]
              : [
                  [here, s2.id],
                  [s2.id, c.settlementId],
                ];
          const t = this.#legs(view, ship, l);
          if (!t || view.jd + t.days > c.deadlineJd) continue;
          const cost = view.ask(s2.id, c.good) * c.qty + t.cost;
          if (!best || cost < best.cost) best = { src: s2.id, cost, legs: l };
        }
        if (!best) continue;
        first = best.src;
        purchase = view.ask(best.src, c.good) * c.qty;
        if (purchase > cash) continue;
        legs.push(...best.legs);
      }
      const trip = this.#legs(view, ship, legs);
      if (!trip || view.jd + trip.days > c.deadlineJd) continue;
      const cost = purchase + trip.cost;
      const profit = c.reward - cost;
      if (profit <= p.minMarginPct * cost) continue;
      const score =
        (profit / Math.max(trip.days, 0.5)) *
        (1 + view.ai.contractBiasScale * p.contractVsTradeBias) *
        weightDest(c.settlementId, c.good);
      cands.push({
        score,
        label: () =>
          `Contract: ${fmtTonnes(c.qty)} ${c.good} → ${view.settlement(c.settlementId)?.name} (+${fmtMoney(profit)} est.)`,
        execute: (decision) => {
          this.#jobs.set(ship.id, { kind: 'contract', contractId: c.id });
          decision.commands.push({ type: 'AcceptContract', contractId: c.id, shipId: ship.id });
          this.#contractStep(
            view,
            ship,
            { ...c, status: 'accepted', shipId: ship.id, companyId: view.company.id },
            decision,
          );
        },
      });
    }

    // B) Trades from here, and C) trades after repositioning to a cheap source.
    const reservedQty = (dest: string, good: GoodId) =>
      [...this.#jobs.values()].reduce(
        (a, j) => a + (j.kind === 'trade' && j.destId === dest && j.good === good ? j.qty : 0),
        0,
      );
    const raw: {
      source: string;
      dest: string;
      good: GoodId;
      qty: number;
      ask: number;
      bid: number;
      margin: number;
    }[] = [];
    for (const source of view.settlements()) {
      const reposition = source.id !== here;
      for (const g of GOOD_IDS) {
        const spare = this.#spare(view, source.id, g);
        if (spare <= 1) continue;
        const ask = view.ask(source.id, g);
        if (!(ask > 0)) continue;
        const maxQty = Math.min(cls.cargoT, spare, cash / ask);
        if (maxQty < Math.max(1, cls.cargoT * view.ai.minLoadFraction)) continue;
        for (const dest of view.settlements()) {
          if (dest.id === source.id) continue;
          const qty = Math.floor(
            Math.min(maxQty, view.demandRoom(dest.id, g) - reservedQty(dest.id, g)),
          );
          if (qty < Math.max(1, cls.cargoT * view.ai.minLoadFraction)) continue;
          const bid = view.bid(dest.id, g, qty);
          if (bid <= ask * (1 + p.minMarginPct)) continue;
          const margin = (bid - ask) * qty * (reposition ? view.ai.repositionMarginWeight : 1);
          raw.push({ source: source.id, dest: dest.id, good: g, qty, ask, bid, margin });
        }
      }
    }
    raw.sort((a, b) => b.margin - a.margin || a.good.localeCompare(b.good));
    for (const r of raw.slice(0, TOP_K)) {
      const legs: [string, string][] =
        r.source === here
          ? [[here, r.dest]]
          : [
              [here, r.source],
              [r.source, r.dest],
            ];
      const trip = this.#legs(view, ship, legs);
      if (!trip) continue;
      const cost = r.ask * r.qty + trip.cost;
      const profit = riskAdjustedProfit(
        r.bid * r.qty,
        cost,
        trip.days,
        p.riskAversion,
        view.ai.riskHorizonDays,
      );
      if (profit <= p.minMarginPct * cost) continue;
      const score =
        (profit / Math.max(trip.days, 0.5)) *
        (1 - view.ai.contractBiasScale * p.contractVsTradeBias) *
        weightDest(r.dest, r.good);
      const srcName = view.settlement(r.source)?.name;
      const dstName = view.settlement(r.dest)?.name;
      cands.push({
        score,
        label: () =>
          `Trade: ${r.good} ${srcName} ${fmtMoney(r.ask)}/t → ${dstName} ${fmtMoney(r.bid)}/t (+${fmtMoney(profit)} est.)`,
        execute: (decision) => {
          const job: Job = {
            kind: 'trade',
            good: r.good,
            qty: r.qty,
            sourceId: r.source,
            destId: r.dest,
            buyPrice: r.ask,
          };
          this.#jobs.set(ship.id, job);
          if (r.source === here) {
            if (!this.#buyAndGo(view, ship, job, decision)) this.#jobs.delete(ship.id);
          } else if (this.#dispatch(view, ship, r.source, decision.commands)) {
            decision.intent = `Repositioning to ${srcName} to buy ${r.good} for ${dstName}`;
          } else {
            this.#jobs.delete(ship.id);
          }
        },
      });
    }

    cands.sort((a, b) => b.score - a.score);
    return cands[0] ?? null;
  }

  /** Sum days and running costs over consecutive legs (null if any leg is infeasible). */
  #legs(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    legs: [string, string][],
  ): { days: number; cost: number } | null {
    const cls = view.shipClass(ship.classId);
    let days = 0;
    let cost = 0;
    for (const [a, b] of legs) {
      const est = view.estimateTrip(ship.id, a, b);
      if (!est) return null;
      // Exotic fuel is only sold at shipyards; chemical/fusion fuel may cost an emergency premium.
      if (est.exoticCost > 0 && !view.settlement(a)?.isShipyard) return null;
      days += est.arriveJd - view.jd;
      cost += this.#fuelCost(view, a, est);
    }
    cost += cls.upkeepPerDay * days + view.dockingFee * legs.length;
    return { days, cost };
  }

  #fuelCost(view: CompanyView, from: string, est: TripEstimate): number {
    return est.fuelT * view.fuelPrice(from, est.fuelT) + est.exoticCost;
  }

  /** Issue a dispatch only if the planner, fuel stock and cash allow it. */
  #dispatch(view: CompanyView, ship: DeepReadonly<Ship>, to: string, cmds: Command[]): boolean {
    const from = ship.siteId!;
    if (from === to) return false;
    const est = view.estimateTrip(ship.id, from, to);
    if (!est) return false;
    if (est.exoticCost > 0 && !view.settlement(from)?.isShipyard) return false;
    if (this.#fuelCost(view, from, est) > view.company.cash) return false;
    cmds.push({ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: to });
    return true;
  }

  #spare(view: CompanyView, siteId: string, good: GoodId): number {
    const s = view.settlement(siteId);
    return s ? spareStock(s, good, view.sourceReserveFraction) : 0;
  }

  /** Source minimising goods cost + travel cost for this ship (then on to `dest`). */
  #landedSource(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    good: GoodId,
    qty: number,
    dest: string,
  ): string | null {
    const here = ship.siteId!;
    let best: { id: string; cost: number } | null = null;
    for (const s of view.settlements()) {
      if (s.id === dest || s.id === here || this.#spare(view, s.id, good) < qty) continue;
      const t = this.#legs(view, ship, [
        [here, s.id],
        [s.id, dest],
      ]);
      if (!t) continue;
      const cost = view.ask(s.id, good) * qty + t.cost;
      if (!best || cost < best.cost) best = { id: s.id, cost };
    }
    return best?.id ?? null;
  }

  #available(view: CompanyView): number {
    const upkeep = view.ships().reduce((a, s) => a + view.shipClass(s.classId).upkeepPerDay, 0);
    return view.company.cash - upkeep * view.ai.reserveDays;
  }

  // ── Fleet management ───────────────────────────────────────────────────────

  #fleet(view: CompanyView, cmds: Command[]): void {
    const p = view.personality;
    const since = this.#lastFleetReview ?? view.company.foundedJd;
    const elapsed = Math.max(1, view.jd - since);
    if (elapsed < view.ai.fleetReviewDays * 0.9 && this.#lastFleetReview !== null) return;
    this.#lastFleetReview = view.jd;
    const ships = view.ships().filter((s) => s.state !== 'building');
    let busy = 0;
    for (const s of ships) {
      busy += s.busyDays - (this.#lastBusy.get(s.id) ?? 0);
      this.#lastBusy.set(s.id, s.busyDays);
    }
    const util = ships.length > 0 ? busy / (ships.length * elapsed) : 1;
    const cash = view.company.cash;

    if (cash > p.expansionCashThreshold && util >= p.targetUtilisation) {
      const cls = this.#pickClass(view, cash);
      const yard = this.#pickYard(view);
      if (cls && yard) cmds.push({ type: 'PurchaseShip', classId: cls.id, shipyardSiteId: yard });
      return;
    }
    const distressed = view.company.status === 'distress';
    if (
      (distressed ||
        (cash < view.ai.lowCashThresholdFraction * p.expansionCashThreshold &&
          util < view.ai.lowUtilisationThreshold)) &&
      ships.length > 1
    ) {
      const sellable = ships
        .filter(
          (s) =>
            s.state === 'docked' && !s.contractId && cargoMass(s) === 0 && !this.#jobs.has(s.id),
        )
        .toSorted((a, b) => a.stats.revenue - a.stats.costs - (b.stats.revenue - b.stats.costs));
      const worst = sellable[0];
      if (worst) {
        cmds.push({ type: 'SellShip', shipId: worst.id });
        this.#jobs.delete(worst.id);
      }
    }
  }

  #pickClass(view: CompanyView, cash: number): ShipClass | null {
    const p = view.personality;
    const affordable = view
      .shipClasses()
      .filter((c) => c.price <= cash * view.ai.shipPurchaseCashFraction);
    const preferred = affordable.filter((c) => p.preferredTiers.includes(c.tier));
    const pool = preferred.length > 0 ? preferred : affordable;
    return pool.toSorted((a, b) => b.price - a.price || a.id.localeCompare(b.id))[0] ?? null;
  }

  #pickYard(view: CompanyView): string | null {
    const yards = view.settlements().filter((s) => s.isShipyard);
    const outer = view.personality.regionBias === 'outer' || view.personality.regionBias === 'belt';
    const pick = outer ? yards.find((y) => view.distanceFromSunAU(y.id) > 2) : undefined;
    return (pick ?? yards[0])?.id ?? null;
  }
}
