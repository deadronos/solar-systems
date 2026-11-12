import type { Command } from '../core/commands.ts';
import {
  GOOD_IDS,
  type Contract,
  type GoodId,
  type Ship,
  type ShipClass,
} from '../economy/types.ts';
import type { TripEstimate } from '../navigation/planner.ts';
import type { CompanyController, CompanyView, WakeReason } from './types.ts';

type Job =
  | { kind: 'trade'; good: GoodId; qty: number; sourceId: string; destId: string; buyPrice: number }
  | { kind: 'contract'; contractId: string };

interface Candidate {
  score: number;
  label: string;
  execute: () => Command[];
}

/** Days before an idle ship with nothing to do looks again. */
const IDLE_RETRY_DAYS = 5;
/** Days before a stuck job step is retried. */
const JOB_RETRY_DAYS = 2;
/** Trades below this fraction of cargo capacity aren't worth a trip. */
const MIN_LOAD_FRACTION = 0.05;
/** Days of fleet upkeep kept as a cash reserve. */
const RESERVE_DAYS = 30;
const FLEET_REVIEW_DAYS = 30;
/** Top raw opportunities that get a (more expensive) trip estimate. */
const TOP_K = 6;
/** Docking fee assumed per leg when costing a plan. */
const DOCKING_FEE_ESTIMATE = 5_000;

const fmtMoney = (v: number): string => {
  const a = Math.abs(v);
  const s =
    a >= 1e9
      ? `${(a / 1e9).toFixed(1)}B`
      : a >= 1e6
        ? `${(a / 1e6).toFixed(1)}M`
        : a >= 1e3
          ? `${(a / 1e3).toFixed(0)}k`
          : a.toFixed(0);
  return `${v < 0 ? '−' : ''}₡${s}`;
};
const fmtT = (t: number) => `${Math.round(t).toLocaleString('en-US')} t`;

/** Expected profit after discounting revenue for price risk over the trip length. */
export function riskAdjustedProfit(
  revenue: number,
  cost: number,
  days: number,
  riskAversion: number,
): number {
  return revenue * (1 - riskAversion * Math.min(1, days / 365)) - cost;
}

const cargoMass = (ship: Readonly<Ship>) =>
  Object.values(ship.cargo).reduce((a, b) => a + (b ?? 0), 0);

/**
 * Default company brain: greedy, explainable job selection for idle ships plus periodic
 * fleet management. All state it keeps is advisory memory; the world is the truth.
 */
export class AiBrain implements CompanyController {
  #jobs = new Map<string, Job>();
  #nextLook = new Map<string, number>();
  #lastBusy = new Map<string, number>();
  #lastFleetReview: number | null = null;

  decide(view: CompanyView, wake: WakeReason[]): Command[] {
    const cmds: Command[] = [];
    const forced = new Set(
      wake.flatMap((w) => (w.kind === 'shipIdle' || w.kind === 'shipArrived' ? [w.shipId] : [])),
    );
    // Forget jobs of ships that no longer exist.
    const alive = new Set(view.ships().map((s) => s.id));
    for (const id of this.#jobs.keys()) if (!alive.has(id)) this.#jobs.delete(id);

    for (const ship of view.ships().toSorted((a, b) => a.id.localeCompare(b.id))) {
      if (ship.state !== 'docked' || !ship.siteId || ship.pendingRemoval) continue;
      if (!forced.has(ship.id) && (this.#nextLook.get(ship.id) ?? 0) > view.jd) continue;
      this.#step(view, ship, cmds);
    }
    if (wake.some((w) => w.kind === 'fleetReview')) this.#fleet(view, cmds);
    return cmds;
  }

  // ── Per-ship state machine ─────────────────────────────────────────────────

  #step(view: CompanyView, ship: Readonly<Ship>, cmds: Command[]): void {
    const here = ship.siteId!;
    const job = this.#jobs.get(ship.id);
    this.#nextLook.set(ship.id, view.jd + JOB_RETRY_DAYS);

    if (job?.kind === 'contract') {
      const c = view.contract(job.contractId);
      if (c && (c.status === 'accepted' || c.status === 'loaded') && c.shipId === ship.id) {
        this.#contractStep(view, ship, c, cmds);
        return;
      }
      this.#jobs.delete(ship.id);
    }

    if (job?.kind === 'trade') {
      const held = ship.cargo[job.good] ?? 0;
      if (here === job.sourceId && held <= 0) {
        if (this.#buyAndGo(view, ship, job, cmds)) return;
        this.#jobs.delete(ship.id);
      } else if (here !== job.destId && held > 0) {
        if (this.#dispatch(view, ship, job.destId, cmds)) {
          view.setIntent(
            ship.id,
            `Hauling ${fmtT(held)} ${job.good} → ${view.settlement(job.destId)?.name}`,
          );
          return;
        }
        this.#jobs.delete(ship.id);
      } else {
        this.#jobs.delete(ship.id);
      }
    }

    // Unassigned cargo: sell here, otherwise take it to the best buyer.
    if (cargoMass(ship) > 0 && !ship.contractId) {
      if (this.#sellOrRoute(view, ship, cmds)) return;
    }

    const best = this.#choose(view, ship);
    if (!best) {
      this.#nextLook.set(ship.id, view.jd + IDLE_RETRY_DAYS);
      view.setIntent(ship.id, 'Idle — no profitable work nearby');
      return;
    }
    view.setIntent(ship.id, best.label);
    cmds.push(...best.execute());
  }

  #contractStep(
    view: CompanyView,
    ship: Readonly<Ship>,
    c: Readonly<Contract>,
    cmds: Command[],
  ): void {
    const here = ship.siteId!;
    const dest = view.settlement(c.settlementId)!;
    const held = ship.cargo[c.good] ?? 0;
    const label = `Contract: ${fmtT(c.qty)} ${c.good} → ${dest.name} for ${fmtMoney(c.reward)}`;
    if (held >= c.qty - 1e-9) {
      if (here === c.settlementId) {
        cmds.push({ type: 'DeliverContract', contractId: c.id });
        this.#jobs.delete(ship.id);
        view.setIntent(ship.id, `Delivered ${c.good} to ${dest.name}`);
        this.#nextLook.set(ship.id, view.jd);
      } else if (this.#dispatch(view, ship, c.settlementId, cmds)) {
        view.setIntent(ship.id, label);
      } else {
        this.#giveUp(view, ship, c, cmds);
      }
      return;
    }
    if (c.kind === 'freight') {
      if (here === c.pickupSettlementId) {
        if (cargoMass(ship) + c.qty > view.shipClass(ship.classId).cargoT) {
          this.#giveUp(view, ship, c, cmds);
          return;
        }
        cmds.push({ type: 'LoadContractCargo', contractId: c.id });
        if (this.#dispatch(view, ship, c.settlementId, cmds)) view.setIntent(ship.id, label);
      } else if (c.pickupSettlementId && this.#dispatch(view, ship, c.pickupSettlementId, cmds)) {
        view.setIntent(
          ship.id,
          `${label} (to pickup at ${view.settlement(c.pickupSettlementId)?.name})`,
        );
      } else {
        this.#giveUp(view, ship, c, cmds);
      }
      return;
    }
    // Delivery contract: source the goods (never at the destination itself).
    const need = c.qty - held;
    if (cargoMass(ship) + need > view.shipClass(ship.classId).cargoT) {
      this.#giveUp(view, ship, c, cmds);
      return;
    }
    if (here !== c.settlementId && this.#spare(view, here, c.good) >= need) {
      const ask = view.ask(here, c.good);
      if (ask * need <= this.#available(view)) {
        cmds.push({
          type: 'BuyCargo',
          shipId: ship.id,
          good: c.good,
          qty: need,
          maxPrice: ask * 1.05,
        });
        if (this.#dispatch(view, ship, c.settlementId, cmds)) {
          view.setIntent(ship.id, label);
          return;
        }
      }
    }
    const src = this.#landedSource(view, ship, c.good, need, c.settlementId);
    if (src && src !== here && this.#dispatch(view, ship, src, cmds)) {
      view.setIntent(ship.id, `${label} (buying at ${view.settlement(src)?.name})`);
      return;
    }
    this.#giveUp(view, ship, c, cmds);
  }

  #giveUp(view: CompanyView, ship: Readonly<Ship>, c: Readonly<Contract>, cmds: Command[]): void {
    if (c.status === 'accepted') cmds.push({ type: 'AbandonContract', contractId: c.id });
    this.#jobs.delete(ship.id);
    view.setIntent(ship.id, `Abandoned contract ${c.id} (no feasible route)`);
  }

  #buyAndGo(
    view: CompanyView,
    ship: Readonly<Ship>,
    job: Job & { kind: 'trade' },
    cmds: Command[],
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
    if (qty < Math.max(1, cls.cargoT * MIN_LOAD_FRACTION)) return false;
    cmds.push({ type: 'BuyCargo', shipId: ship.id, good: job.good, qty, maxPrice: ask * 1.05 });
    if (!this.#dispatch(view, ship, job.destId, cmds)) return false;
    job.qty = qty;
    job.buyPrice = ask;
    view.setIntent(
      ship.id,
      `Trade: ${fmtT(qty)} ${job.good} ${view.settlement(here)?.name} ${fmtMoney(ask)}/t → ${view.settlement(job.destId)?.name}`,
    );
    return true;
  }

  #sellOrRoute(view: CompanyView, ship: Readonly<Ship>, cmds: Command[]): boolean {
    const here = ship.siteId!;
    let remaining = false;
    for (const g of GOOD_IDS) {
      const held = ship.cargo[g] ?? 0;
      if (held <= 0) continue;
      const qty = Math.min(held, view.demandRoom(here, g));
      if (qty > 1e-6 && view.bid(here, g, qty) > 0) {
        cmds.push({ type: 'SellCargo', shipId: ship.id, good: g, qty, minPrice: 0 });
      }
      if (held - qty > 1e-6) remaining = true;
    }
    if (!remaining) {
      view.setIntent(ship.id, `Sold cargo at ${view.settlement(here)?.name}`);
      return false; // free for a new job this same decision? keep simple: next look
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
    if (best && this.#dispatch(view, ship, best.id, cmds)) {
      this.#jobs.set(ship.id, {
        kind: 'trade',
        good: best.good,
        qty: ship.cargo[best.good] ?? 0,
        sourceId: here,
        destId: best.id,
        buyPrice: 0,
      });
      view.setIntent(ship.id, `Taking unsold ${best.good} to ${view.settlement(best.id)?.name}`);
      return true;
    }
    return false;
  }

  // ── Job selection ──────────────────────────────────────────────────────────

  #choose(view: CompanyView, ship: Readonly<Ship>): Candidate | null {
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
      if (p.preferredGoods?.includes(good)) w *= 1.25;
      const au = view.distanceFromSunAU(destId);
      if (p.regionBias === 'outer' && au > 2.2) w *= 1.3;
      if (p.regionBias === 'belt' && au > 2 && au < 3.6) w *= 1.2;
      if (p.regionBias === 'inner' && au < 1.8) w *= 1.2;
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
        (1 + 0.5 * p.contractVsTradeBias) *
        weightDest(c.settlementId, c.good);
      cands.push({
        score,
        label: `Contract: ${fmtT(c.qty)} ${c.good} → ${view.settlement(c.settlementId)?.name} (+${fmtMoney(profit)} est.)`,
        execute: () => {
          this.#jobs.set(ship.id, { kind: 'contract', contractId: c.id });
          const out: Command[] = [{ type: 'AcceptContract', contractId: c.id, shipId: ship.id }];
          this.#contractStep(
            view,
            ship,
            { ...c, status: 'accepted', shipId: ship.id, companyId: view.company.id },
            out,
          );
          return out;
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
        if (maxQty < Math.max(1, cls.cargoT * MIN_LOAD_FRACTION)) continue;
        for (const dest of view.settlements()) {
          if (dest.id === source.id) continue;
          const qty = Math.floor(
            Math.min(maxQty, view.demandRoom(dest.id, g) - reservedQty(dest.id, g)),
          );
          if (qty < Math.max(1, cls.cargoT * MIN_LOAD_FRACTION)) continue;
          const bid = view.bid(dest.id, g, qty);
          if (bid <= ask * (1 + p.minMarginPct)) continue;
          const margin = (bid - ask) * qty * (reposition ? 0.7 : 1);
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
      const profit = riskAdjustedProfit(r.bid * r.qty, cost, trip.days, p.riskAversion);
      if (profit <= p.minMarginPct * cost) continue;
      const score =
        (profit / Math.max(trip.days, 0.5)) *
        (1 - 0.5 * p.contractVsTradeBias) *
        weightDest(r.dest, r.good);
      const srcName = view.settlement(r.source)?.name;
      const dstName = view.settlement(r.dest)?.name;
      cands.push({
        score,
        label: `Trade: ${r.good} ${srcName} ${fmtMoney(r.ask)}/t → ${dstName} ${fmtMoney(r.bid)}/t (+${fmtMoney(profit)} est.)`,
        execute: () => {
          const job: Job = {
            kind: 'trade',
            good: r.good,
            qty: r.qty,
            sourceId: r.source,
            destId: r.dest,
            buyPrice: r.ask,
          };
          this.#jobs.set(ship.id, job);
          const out: Command[] = [];
          if (r.source === here) {
            if (!this.#buyAndGo(view, ship, job, out)) this.#jobs.delete(ship.id);
          } else if (this.#dispatch(view, ship, r.source, out)) {
            view.setIntent(ship.id, `Repositioning to ${srcName} to buy ${r.good} for ${dstName}`);
          } else {
            this.#jobs.delete(ship.id);
          }
          return out;
        },
      });
    }

    cands.sort((a, b) => b.score - a.score);
    return cands[0] ?? null;
  }

  /** Sum days and running costs over consecutive legs (null if any leg is infeasible). */
  #legs(
    view: CompanyView,
    ship: Readonly<Ship>,
    legs: [string, string][],
  ): { days: number; cost: number } | null {
    const cls = view.shipClass(ship.classId);
    let days = 0;
    let cost = 0;
    for (const [a, b] of legs) {
      const est = view.estimateTrip(ship.id, a, b);
      if (!est) return null;
      days += est.arriveJd - view.jd;
      cost += this.#fuelCost(view, a, est);
    }
    cost += cls.upkeepPerDay * days + DOCKING_FEE_ESTIMATE * legs.length;
    return { days, cost };
  }

  #fuelCost(view: CompanyView, from: string, est: TripEstimate): number {
    return est.fuelT * view.ask(from, 'fuel') + est.exoticCost;
  }

  /** Issue a dispatch only if the planner, fuel stock and cash allow it. */
  #dispatch(view: CompanyView, ship: Readonly<Ship>, to: string, cmds: Command[]): boolean {
    const from = ship.siteId!;
    if (from === to) return false;
    const est = view.estimateTrip(ship.id, from, to);
    if (!est) return false;
    if (est.fuelT > 0 && view.market(from, 'fuel').stock < est.fuelT) return false;
    if (est.exoticCost > 0 && !view.settlement(from)?.isShipyard) return false;
    if (this.#fuelCost(view, from, est) > view.company.cash) return false;
    cmds.push({ type: 'PlanAndDispatch', shipId: ship.id, toSiteId: to });
    return true;
  }

  #spare(view: CompanyView, siteId: string, good: GoodId): number {
    const s = view.settlement(siteId);
    if (!s) return 0;
    if (s.isDeepMarket) return Number.POSITIVE_INFINITY;
    const e = view.market(siteId, good);
    return e.stock - 0.5 * e.targetStock;
  }

  /** Source minimising goods cost + travel cost for this ship (then on to `dest`). */
  #landedSource(
    view: CompanyView,
    ship: Readonly<Ship>,
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
    return view.company.cash - upkeep * RESERVE_DAYS;
  }

  // ── Fleet management ───────────────────────────────────────────────────────

  #fleet(view: CompanyView, cmds: Command[]): void {
    const p = view.personality;
    const since = this.#lastFleetReview ?? view.company.foundedJd;
    const elapsed = Math.max(1, view.jd - since);
    if (elapsed < FLEET_REVIEW_DAYS * 0.9 && this.#lastFleetReview !== null) return;
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
    if ((distressed || (cash < 0.1 * p.expansionCashThreshold && util < 0.4)) && ships.length > 1) {
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
    const affordable = view.shipClasses().filter((c) => c.price <= cash * 0.5);
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
