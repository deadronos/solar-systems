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
/** Open contracts per decision that get trip estimates, ranked by a travel-free profit. */
/** Load sizes tried for a trade, as fractions of the most the ship and market allow. */
const LOAD_FRACTIONS = [1, 0.5, 0.25];
const CONTRACT_TOP_K = 8;

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
    if (c.kind === 'export') {
      this.#sellOrderStep(view, ship, c, decision);
      return;
    }
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
      const ask = view.ask(here, c.good, need);
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

  /** Sell order: fly to the seller, buy the goods on loading, then haul them to a buyer. */
  #sellOrderStep(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    c: DeepReadonly<Contract>,
    decision: ShipDecision,
  ): void {
    const here = ship.siteId!;
    const seller = view.settlement(c.settlementId)?.name;
    if (here !== c.settlementId) {
      if (this.#dispatch(view, ship, c.settlementId, decision.commands)) {
        decision.intent = `Sell order: to ${seller} for ${fmtTonnes(c.qty)} ${c.good}`;
      } else {
        this.#giveUp(ship, c, decision);
      }
      return;
    }
    const fits = cargoMass(ship) + c.qty <= view.shipClass(ship.classId).cargoT + 1e-9;
    const buyer = this.#bestBuyer(view, c.good, c.qty, here);
    if (!fits || !buyer || c.escrowCost > view.company.cash) {
      this.#giveUp(ship, c, decision);
      return;
    }
    decision.commands.push({ type: 'LoadContractCargo', contractId: c.id });
    this.#jobs.set(ship.id, {
      kind: 'trade',
      good: c.good,
      qty: c.qty,
      sourceId: here,
      destId: buyer.id,
      buyPrice: c.escrowCost / c.qty,
    });
    if (this.#dispatch(view, ship, buyer.id, decision.commands)) {
      decision.intent = `Sell order: ${fmtTonnes(c.qty)} ${c.good} ${seller} → ${view.settlement(buyer.id)?.name}`;
    } else {
      // Bought but can't leave yet: the next look routes the cargo to a buyer.
      decision.intent = `Bought ${fmtTonnes(c.qty)} ${c.good} on ${seller}'s sell order`;
      this.#nextLook.set(ship.id, view.jd);
    }
  }

  /**
   * Settlement (other than `exclude`) expected to pay the most for `qty` of a good, after the
   * cargo already heading there (see `#incoming`), if any.
   */
  #bestBuyer(
    view: CompanyView,
    good: GoodId,
    qty: number,
    exclude: string,
  ): { id: string; bid: number } | null {
    let best: { id: string; bid: number } | null = null;
    for (const s of view.settlements()) {
      if (s.id === exclude) continue;
      const incoming = this.#incoming(view, s.id, good);
      if (view.demandRoom(s.id, good) - incoming < qty) continue;
      const bid = view.bid(s.id, good, qty, incoming);
      if (bid > 0 && (!best || bid > best.bid)) best = { id: s.id, bid };
    }
    return best;
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
    // The quote for the planned load bounds the price per tonne of any smaller one.
    const qty = Math.floor(
      Math.min(
        job.qty,
        cls.cargoT - cargoMass(ship),
        this.#spare(view, here, job.good),
        this.#available(view) / view.ask(here, job.good, job.qty),
      ),
    );
    const ask = view.ask(here, job.good, qty);
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
        const incoming = this.#incoming(view, s.id, g);
        const q = Math.min(held, view.demandRoom(s.id, g) - incoming);
        if (q <= 1e-6) continue;
        const v = view.bid(s.id, g, q, incoming) * q;
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

    // A) Contracts: only the most promising few get (expensive) trip estimates.
    for (const c of this.#shortlist(view, ship, reservedContracts)) {
      const legs: [string, string][] = [];
      let purchase = 0;
      let first: string;
      if (c.kind === 'export') {
        const cand = this.#sellOrderCandidate(view, ship, c, cash, weightDest);
        if (cand) cands.push(cand);
        continue;
      }
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
          const t = this.#legs(view, ship, l, c.qty);
          if (!t || view.jd + t.days > c.deadlineJd) continue;
          const cost = view.ask(s2.id, c.good, c.qty) * c.qty + t.cost;
          if (!best || cost < best.cost) best = { src: s2.id, cost, legs: l };
        }
        if (!best) continue;
        first = best.src;
        purchase = view.ask(best.src, c.good, c.qty) * c.qty;
        if (purchase > cash) continue;
        legs.push(...best.legs);
      }
      const trip = this.#legs(view, ship, legs, c.qty);
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
        const full = view.ask(source.id, g, Math.min(cls.cargoT, spare));
        if (!(full > 0)) continue;
        const maxQty = Math.min(cls.cargoT, spare, cash / full);
        if (maxQty < Math.max(1, cls.cargoT * view.ai.minLoadFraction)) continue;
        for (const dest of view.settlements()) {
          if (dest.id === source.id) continue;
          const incoming = this.#incoming(view, dest.id, g);
          const room = Math.floor(Math.min(maxQty, view.demandRoom(dest.id, g) - incoming));
          const minLoad = Math.max(1, cls.cargoT * view.ai.minLoadFraction);
          // Prices slip along the curve, so a smaller load can earn more than a full one.
          let best: { qty: number; ask: number; bid: number; margin: number } | null = null;
          for (const f of LOAD_FRACTIONS) {
            const qty = Math.floor(room * f);
            if (qty < minLoad) break;
            const ask = view.ask(source.id, g, qty);
            const bid = view.bid(dest.id, g, qty, incoming);
            if (bid <= ask * (1 + p.minMarginPct)) continue;
            const margin = (bid - ask) * qty * (reposition ? view.ai.repositionMarginWeight : 1);
            if (!best || margin > best.margin) best = { qty, ask, bid, margin };
          }
          if (best) raw.push({ source: source.id, dest: dest.id, good: g, ...best });
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
      const trip = this.#legs(view, ship, legs, r.qty);
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

  /**
   * Open contracts this ship could take, best first by profit before travel costs: the
   * reward less the cheapest goods (delivery), the fee (freight), or the resale gain (sell
   * order). Only the top `CONTRACT_TOP_K` are worth trip estimates.
   */
  #shortlist(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    reserved: ReadonlySet<string>,
  ): DeepReadonly<Contract>[] {
    const room = view.shipClass(ship.classId).cargoT - cargoMass(ship);
    const ranked: { c: DeepReadonly<Contract>; gain: number }[] = [];
    for (const c of view.openContracts()) {
      if (reserved.has(c.id) || c.qty > room) continue;
      let gain: number;
      if (c.kind === 'freight') {
        gain = c.reward;
      } else if (c.kind === 'export') {
        const buyer = this.#bestBuyer(view, c.good, c.qty, c.settlementId);
        gain = buyer ? buyer.bid * c.qty - c.escrowCost : 0;
      } else {
        let cheapest = Number.POSITIVE_INFINITY;
        for (const s of view.settlements()) {
          if (s.id === c.settlementId || this.#spare(view, s.id, c.good) < c.qty) continue;
          cheapest = Math.min(cheapest, view.ask(s.id, c.good, c.qty));
        }
        gain = c.reward - cheapest * c.qty;
      }
      if (gain > 0) ranked.push({ c, gain });
    }
    ranked.sort((a, b) => b.gain - a.gain || a.c.id.localeCompare(b.c.id));
    return ranked.slice(0, CONTRACT_TOP_K).map((r) => r.c);
  }

  /** A sell order scored like a trade: buy at the offer price, sell at the best bid. */
  #sellOrderCandidate(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    c: DeepReadonly<Contract>,
    cash: number,
    weightDest: (destId: string, good: GoodId) => number,
  ): Candidate | null {
    const here = ship.siteId!;
    const p = view.personality;
    if (c.escrowCost > cash) return null;
    const buyer = this.#bestBuyer(view, c.good, c.qty, c.settlementId);
    if (!buyer) return null;
    const toSeller =
      here === c.settlementId ? null : this.#legs(view, ship, [[here, c.settlementId]]);
    if (here !== c.settlementId && (!toSeller || view.jd + toSeller.days > c.deadlineJd))
      return null;
    const legs: [string, string][] =
      here === c.settlementId
        ? [[here, buyer.id]]
        : [
            [here, c.settlementId],
            [c.settlementId, buyer.id],
          ];
    const trip = this.#legs(view, ship, legs, c.qty);
    if (!trip) return null;
    const cost = c.escrowCost + trip.cost;
    const profit = riskAdjustedProfit(
      buyer.bid * c.qty,
      cost,
      trip.days,
      p.riskAversion,
      view.ai.riskHorizonDays,
    );
    if (profit <= p.minMarginPct * cost) return null;
    const score =
      (profit / Math.max(trip.days, 0.5)) *
      (1 - view.ai.contractBiasScale * p.contractVsTradeBias) *
      weightDest(buyer.id, c.good);
    return {
      score,
      label: () =>
        `Sell order: ${fmtTonnes(c.qty)} ${c.good} ${view.settlement(c.settlementId)?.name} → ${view.settlement(buyer.id)?.name} (+${fmtMoney(profit)} est.)`,
      execute: (decision) => {
        this.#jobs.set(ship.id, { kind: 'contract', contractId: c.id });
        decision.commands.push({ type: 'AcceptContract', contractId: c.id, shipId: ship.id });
        this.#sellOrderStep(
          view,
          ship,
          { ...c, status: 'accepted', shipId: ship.id, companyId: view.company.id },
          decision,
        );
      },
    };
  }

  /**
   * Sum days and running costs over consecutive legs (null if any leg is infeasible). The
   * last leg carries `loadT` on top of the cargo aboard; earlier legs only what is aboard.
   * Fuel follows the rocket equation, so a heavy last leg can be out of range (#20).
   */
  #legs(
    view: CompanyView,
    ship: DeepReadonly<Ship>,
    legs: [string, string][],
    loadT = 0,
  ): { days: number; cost: number } | null {
    const cls = view.shipClass(ship.classId);
    const aboard = cargoMass(ship);
    let days = 0;
    let cost = 0;
    for (const [i, [a, b]] of legs.entries()) {
      const est = view.estimateTrip(ship.id, a, b, aboard + (i === legs.length - 1 ? loadT : 0));
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
    // Cargo this batch loads before the dispatch runs counts toward the trip's mass.
    let loading = 0;
    for (const cmd of cmds) {
      if (cmd.type === 'BuyCargo' && cmd.shipId === ship.id) loading += cmd.qty;
      if (cmd.type === 'LoadContractCargo') loading += view.contract(cmd.contractId)?.qty ?? 0;
    }
    const est = view.estimateTrip(ship.id, from, to, cargoMass(ship) + loading);
    if (!est) return false;
    if (est.exoticCost > 0 && !view.settlement(from)?.isShipyard) return false;
    if (this.#fuelCost(view, from, est) > view.company.cash) return false;
    cmds.push({ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: to });
    return true;
  }

  /**
   * Tonnes of a good expected to land at `dest` ahead of this company's next sale: its own
   * trade jobs bound there, plus the personality's share of rivals' inbound cargo (#16).
   */
  #incoming(view: CompanyView, dest: string, good: GoodId): number {
    let own = 0;
    for (const j of this.#jobs.values()) {
      if (j.kind === 'trade' && j.destId === dest && j.good === good) own += j.qty;
    }
    const weight = view.personality.competitionWeight ?? view.ai.defaultCompetitionWeight;
    return own + weight * view.inbound(dest, good);
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
      const t = this.#legs(
        view,
        ship,
        [
          [here, s.id],
          [s.id, dest],
        ],
        qty,
      );
      if (!t) continue;
      const cost = view.ask(s.id, good, qty) * qty + t.cost;
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
    const byClass = new Map<string, { busy: number; n: number; profit: number; trips: number }>();
    for (const s of ships) {
      const b = s.busyDays - (this.#lastBusy.get(s.id) ?? 0);
      busy += b;
      this.#lastBusy.set(s.id, s.busyDays);
      const c = byClass.get(s.classId) ?? { busy: 0, n: 0, profit: 0, trips: 0 };
      c.busy += b;
      c.n++;
      c.profit += s.stats.revenue - s.stats.costs;
      c.trips += s.stats.trips;
      byClass.set(s.classId, c);
    }
    const util = ships.length > 0 ? busy / (ships.length * elapsed) : 1;
    const cash = view.company.cash;

    if (cash > p.expansionCashThreshold && util >= p.targetUtilisation) {
      // Don't buy more of a class this company's own ships show doesn't pay: left idle, or
      // losing money after a few trips. With fuel by the rocket equation (#20), some classes
      // can't pay their way on most routes (an NTR's 400-day arcs keep it busy, at a loss).
      const avoid = new Set(
        [...byClass]
          .filter(
            ([, c]) =>
              c.busy / (c.n * elapsed) < view.ai.lowUtilisationThreshold ||
              (c.trips >= c.n && c.profit < 0),
          )
          .map(([id]) => id),
      );
      const cls = this.#pickClass(view, cash, avoid);
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

  #pickClass(view: CompanyView, cash: number, idle: ReadonlySet<string>): ShipClass | null {
    const p = view.personality;
    const affordable = view
      .shipClasses()
      .filter((c) => c.price <= cash * view.ai.shipPurchaseCashFraction && !idle.has(c.id));
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
