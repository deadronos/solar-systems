import { J2000 } from '../../constants.ts';
import { length, sub, vec3, type Vec3 } from '../../math/vec3.ts';
import type { Ephemeris } from '../../world/ephemeris.ts';
import type { Settlement, ShipClass } from '../economy/types.ts';
import { MU_SUN_KM3_S2 } from './kepler2.ts';
import { bodyVelocity, solveLambert } from './lambert.ts';
import type { Leg, TrajectoryPlan } from './plan.ts';

const DAY = 86_400;
const C_KM_S = 299_792.458;
const G0_KM_S2 = 0.009_806_65;

/** Hold durations (days). */
const SURFACE_LEG_DAYS = 0.25;
const SAME_BODY_DAYS = 0.5;
/** Estimates are reused for this many days (launch windows move slowly). */
const ESTIMATE_BUCKET_DAYS = 2;
const GRID_REFRESH_DAYS = 120;
/** Surface ascent/descent Δv as a multiple of circular speed at the surface. */
const SURFACE_DV_FACTOR = 1.2;
/** Low-orbit radius as a multiple of planet radius (local transfers start here). */
const LOW_ORBIT_FACTOR = 1.05;

/** GM (km³/s²) for bodies that lack it in the astronomical catalog. */
const EXTRA_GM: Record<string, number> = {
  moon: 4_902.8,
  phobos: 0.000_711,
  deimos: 0.000_096,
  callisto: 7_179.3,
  ganymede: 9_887.8,
  europa: 3_202.7,
  io: 5_959.9,
  titan: 8_978.1,
  vesta: 17.29,
};

export interface TripEstimate {
  departJd: number;
  arriveJd: number;
  deltaVKmS: number;
  fuelT: number;
  exoticCost: number;
}

interface Cell {
  departJd: number;
  tofDays: number;
  dv: number;
}

/**
 * Coarse launch-window grid per body pair (tiers 1–2): departure offsets over one synodic
 * period (+ refresh margin) × times of flight. Rebuilt once the grid start is
 * GRID_REFRESH_DAYS old, so every query still sees a full synodic period ahead.
 */
export class PorkchopCache {
  #grids = new Map<string, { start: number; cells: Cell[] }>();
  readonly #ctx: NavContext;

  constructor(ctx: NavContext) {
    this.#ctx = ctx;
  }

  cells(fromBody: string, toBody: string, earliestJd: number): Cell[] {
    const key = `${fromBody}>${toBody}`;
    const g = this.#grids.get(key);
    if (g && earliestJd - g.start <= GRID_REFRESH_DAYS) return g.cells;
    const start = Math.floor(earliestJd);
    const cells = this.#build(fromBody, toBody, start);
    this.#grids.set(key, { start, cells });
    return cells;
  }

  #build(fromBody: string, toBody: string, start: number): Cell[] {
    const ctx = this.#ctx;
    const { synodicDays, hohmannDays } = ctx.pairTimescales(fromBody, toBody);
    const cells: Cell[] = [];
    const nDep = 24;
    const span = synodicDays + GRID_REFRESH_DAYS;
    for (let i = 0; i < nDep; i++) {
      const departJd = start + (span * i) / nDep;
      for (const c of ctx.tofSweep(fromBody, toBody, departJd, hohmannDays)) cells.push(c);
    }
    return cells;
  }
}

/** Shared navigation context: ephemeris access plus caches. */
export class NavContext {
  readonly eph: Ephemeris;
  readonly porkchop: PorkchopCache;
  #sweeps = new Map<string, Cell[]>();
  #estimates = new Map<string, TripEstimate | null>();

  constructor(eph: Ephemeris) {
    this.eph = eph;
    this.porkchop = new PorkchopCache(this);
  }

  /** The body orbiting the Sun that a body belongs to (itself for planets/asteroids). */
  helioBody(bodyId: string): string {
    const def = this.eph.get(bodyId);
    return def.parentId === null || def.parentId === 'sun' ? bodyId : this.helioBody(def.parentId);
  }

  gm(bodyId: string): number {
    return this.eph.get(bodyId).gm ?? EXTRA_GM[bodyId] ?? 0;
  }

  surfaceDv(site: Settlement): number {
    if (site.site.kind !== 'surface') return 0;
    const gm = this.gm(site.site.bodyId);
    const r = this.eph.get(site.site.bodyId).radiusKm;
    return gm > 0 ? SURFACE_DV_FACTOR * Math.sqrt(gm / r) : 0;
  }

  pairTimescales(fromBody: string, toBody: string): { synodicDays: number; hohmannDays: number } {
    const a1 = this.eph.semiMajorAxisKm(this.helioBody(fromBody), J2000);
    const a2 = this.eph.semiMajorAxisKm(this.helioBody(toBody), J2000);
    const p1 = 2 * Math.PI * Math.sqrt(a1 ** 3 / MU_SUN_KM3_S2);
    const p2 = 2 * Math.PI * Math.sqrt(a2 ** 3 / MU_SUN_KM3_S2);
    const syn = Math.abs(1 / p1 - 1 / p2);
    const synodicDays = syn > 0 ? Math.min(900, 1 / syn / DAY) : 900;
    const hohmannDays = (Math.PI * Math.sqrt(((a1 + a2) / 2) ** 3 / MU_SUN_KM3_S2)) / DAY;
    return { synodicDays, hohmannDays };
  }

  /** Immediate-departure sweep, shared by all ship classes (cached per whole day). */
  sweepFrom(fromBody: string, toBody: string, t0: number): Cell[] {
    const day = Math.ceil(t0);
    const key = `${fromBody}>${toBody}@${day}`;
    let cells = this.#sweeps.get(key);
    if (!cells) {
      if (this.#sweeps.size > 5_000) this.#sweeps.clear();
      cells = this.tofSweep(
        fromBody,
        toBody,
        day,
        this.pairTimescales(fromBody, toBody).hohmannDays,
      );
      this.#sweeps.set(key, cells);
    }
    return cells;
  }

  /**
   * Trip estimate shared world-wide per (class, route, time bucket). Cached results that
   * would depart in the past are shifted to depart now.
   */
  estimateCached(
    cls: ShipClass,
    from: Settlement,
    to: Settlement,
    jd: number,
  ): TripEstimate | null {
    const bucket = Math.floor(jd / ESTIMATE_BUCKET_DAYS);
    const key = `${cls.id}|${from.id}|${to.id}|${bucket}`;
    if (!this.#estimates.has(key)) {
      if (this.#estimates.size > 20_000) this.#estimates.clear();
      this.#estimates.set(key, estimateTrip(cls, from, to, jd, this));
    }
    const e = this.#estimates.get(key)!;
    if (e && e.departJd < jd) {
      const shift = jd - e.departJd;
      return { ...e, departJd: e.departJd + shift, arriveJd: e.arriveJd + shift };
    }
    return e;
  }

  /** Lambert solutions for 16 times of flight at a given departure (heliocentric). */
  tofSweep(fromBody: string, toBody: string, departJd: number, hohmannDays: number): Cell[] {
    const out: Cell[] = [];
    const r1 = this.eph.positionAt(fromBody, departJd, vec3());
    const vDep = bodyVelocity(this.eph, this.helioBody(fromBody), departJd, vec3());
    for (let j = 0; j < 16; j++) {
      const tofDays = hohmannDays * (0.4 + (1.6 * j) / 15);
      const r2 = this.eph.positionAt(toBody, departJd + tofDays, vec3());
      const sol = solveLambert(r1, r2, tofDays * DAY, MU_SUN_KM3_S2);
      if (!sol) continue;
      const vArr = bodyVelocity(this.eph, this.helioBody(toBody), departJd + tofDays, vec3());
      const dv = length(sub(vec3(), sol.v1, vDep)) + length(sub(vec3(), sol.v2, vArr));
      out.push({ departJd, tofDays, dv });
    }
    return out;
  }
}

interface Solved {
  departJd: number;
  arriveJd: number;
  deltaVKmS: number;
  legs: Leg[];
}

const hold = (
  bodyId: string,
  t0: number,
  t1: number,
  label: Leg & { kind: 'hold' } extends { label: infer L } ? L : never,
): Leg => ({ kind: 'hold', bodyId, t0, t1, label });

/** Arrival time for a torch profile chasing a moving target (fixed-point iteration). */
function torchSolve(
  ctx: NavContext,
  fromBody: string,
  toBody: string,
  t0: number,
  accel: number,
  vMax: number,
): { t1: number; from: Vec3; to: Vec3; dv: number } {
  const from = ctx.eph.positionAt(fromBody, t0, vec3());
  const to = vec3();
  let t1 = t0;
  let seconds = 0;
  for (let k = 0; k < 5; k++) {
    ctx.eph.positionAt(toBody, t1, to);
    const d = length(sub(vec3(), to, from));
    const tAccFull = Math.sqrt(d / accel);
    if (accel * tAccFull <= vMax) {
      seconds = 2 * tAccFull;
    } else {
      const tAcc = vMax / accel;
      seconds = 2 * tAcc + (d - accel * tAcc * tAcc) / vMax;
    }
    t1 = t0 + seconds / DAY;
  }
  ctx.eph.positionAt(toBody, t1, to);
  const dv = Math.min(accel * seconds, 2 * vMax);
  return { t1, from, to, dv };
}

function solveTrip(
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
  earliestJd: number,
  ctx: NavContext,
  withLegs: boolean,
): Solved | null {
  if (from.id === to.id) return null;
  const fromBody = from.site.bodyId;
  const toBody = to.site.bodyId;
  const legs: Leg[] = [];

  // Same body: a docking hop between stations / surface and orbit.
  if (fromBody === toBody) {
    const dv = Math.max(ctx.surfaceDv(from), ctx.surfaceDv(to));
    if (cls.deltaVBudgetKmS !== undefined && dv > cls.deltaVBudgetKmS) return null;
    if (withLegs) legs.push(hold(fromBody, earliestJd, earliestJd + SAME_BODY_DAYS, 'docking'));
    return { departJd: earliestJd, arriveJd: earliestJd + SAME_BODY_DAYS, deltaVKmS: dv, legs };
  }

  const ascentDv = ctx.surfaceDv(from);
  const descentDv = ctx.surfaceDv(to);
  const ascentDays = from.site.kind === 'surface' ? SURFACE_LEG_DAYS : 0;
  const descentDays = to.site.kind === 'surface' ? SURFACE_LEG_DAYS : 0;
  const local = ctx.helioBody(fromBody) === ctx.helioBody(toBody);

  let transferStart: number;
  let transferEnd: number;
  let transferDv: number;
  const transferLegs: Leg[] = [];

  if (cls.tier <= 2) {
    const budget = (cls.deltaVBudgetKmS ?? 0) - ascentDv - descentDv;
    if (budget <= 0) return null;
    if (local) {
      const r = localTransfer(ctx, fromBody, toBody, from, to, earliestJd + ascentDays, withLegs);
      if (!r || r.dv > budget) return null;
      transferStart = earliestJd + ascentDays;
      transferEnd = r.t1;
      transferDv = r.dv;
      if (r.leg) transferLegs.push(r.leg);
    } else {
      const t0 = earliestJd + ascentDays;
      const { hohmannDays } = ctx.pairTimescales(fromBody, toBody);
      const candidates = [
        ...(withLegs
          ? ctx.tofSweep(fromBody, toBody, t0, hohmannDays)
          : ctx.sweepFrom(fromBody, toBody, t0)),
        ...ctx.porkchop.cells(fromBody, toBody, t0).filter((c) => c.departJd >= t0),
      ];
      let best: Cell | null = null;
      for (const c of candidates) {
        if (c.dv > budget) continue;
        const score = c.departJd + c.tofDays + c.dv * 0.5; // prefer early arrival, then efficiency
        if (!best || score < best.departJd + best.tofDays + best.dv * 0.5) best = c;
      }
      if (!best) return null;
      transferStart = best.departJd;
      transferEnd = best.departJd + best.tofDays;
      transferDv = best.dv;
      if (withLegs) {
        const r1 = ctx.eph.positionAt(fromBody, transferStart, vec3());
        const r2 = ctx.eph.positionAt(toBody, transferEnd, vec3());
        const sol = solveLambert(r1, r2, best.tofDays * DAY, MU_SUN_KM3_S2);
        if (!sol) return null;
        transferLegs.push({
          kind: 'conic',
          t0: transferStart,
          t1: transferEnd,
          r0: r1,
          v0: sol.v1,
          mu: MU_SUN_KM3_S2,
          centralBodyId: null,
        });
      }
    }
  } else if (cls.tier <= 4) {
    const accel = (cls.accelG ?? 0.01) * G0_KM_S2;
    const vMax =
      cls.tier === 4 ? (cls.maxSpeedFractionC ?? 0.05) * C_KM_S : Number.POSITIVE_INFINITY;
    transferStart = earliestJd + ascentDays;
    const r = torchSolve(ctx, fromBody, toBody, transferStart, accel, vMax);
    transferEnd = r.t1;
    transferDv = r.dv;
    if (withLegs) {
      transferLegs.push({
        kind: 'torch',
        t0: transferStart,
        t1: transferEnd,
        from: r.from,
        to: r.to,
        accelKmS2: accel,
        vMaxKmS: Number.isFinite(vMax) ? vMax : 1e12,
      });
    }
  } else {
    const chargeDays = (cls.jumpChargeHours ?? 12) / 24;
    const jumpStart = earliestJd + ascentDays + chargeDays;
    const fromPos = ctx.eph.positionAt(fromBody, jumpStart, vec3());
    const toPos = ctx.eph.positionAt(toBody, jumpStart, vec3());
    const seconds = length(sub(vec3(), toPos, fromPos)) / ((cls.jumpSpeedC ?? 50) * C_KM_S);
    transferStart = earliestJd + ascentDays;
    transferEnd = jumpStart + seconds / DAY;
    transferDv = 0;
    if (withLegs) {
      transferLegs.push(hold(fromBody, transferStart, jumpStart, 'charging'));
      ctx.eph.positionAt(toBody, transferEnd, toPos);
      transferLegs.push({ kind: 'jump', t0: jumpStart, t1: transferEnd, from: fromPos, to: toPos });
    }
  }

  const departJd = transferStart - ascentDays;
  const arriveJd = transferEnd + descentDays;
  if (withLegs) {
    if (ascentDays > 0) legs.push(hold(fromBody, departJd, transferStart, 'ascent'));
    legs.push(...transferLegs);
    if (descentDays > 0) legs.push(hold(toBody, transferEnd, arriveJd, 'descent'));
    if (legs.length === 0 || legs[legs.length - 1]!.t1 < arriveJd) {
      legs.push(hold(toBody, legs[legs.length - 1]?.t1 ?? departJd, arriveJd, 'docking'));
    }
  }
  return { departJd, arriveJd, deltaVKmS: transferDv + ascentDv + descentDv, legs };
}

/** Orbital radius of a body around its helio parent planet; planets themselves → low orbit. */
function localRadius(ctx: NavContext, bodyId: string, helio: string): number {
  if (bodyId === helio) return ctx.eph.get(bodyId).radiusKm * LOW_ORBIT_FACTOR;
  return ctx.eph.semiMajorAxisKm(bodyId, J2000);
}

/** Planet-centred Hohmann transfer between bodies of one planetary system (tiers 1–2). */
function localTransfer(
  ctx: NavContext,
  fromBody: string,
  toBody: string,
  from: Settlement,
  to: Settlement,
  t0: number,
  withLegs: boolean,
): { t1: number; dv: number; leg: Leg | null } | null {
  const helio = ctx.helioBody(fromBody);
  const mu = ctx.gm(helio);
  if (!(mu > 0)) return null;
  const r1 = localRadius(ctx, fromBody, helio);
  const r2 = localRadius(ctx, toBody, helio);
  const at = (r1 + r2) / 2;
  const tofDays = (Math.PI * Math.sqrt(at ** 3 / mu)) / DAY;
  const dv =
    Math.abs(Math.sqrt(mu / r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1)) +
    Math.abs(Math.sqrt(mu / r2) * (1 - Math.sqrt((2 * r1) / (r1 + r2))));
  const t1 = t0 + tofDays;
  if (!withLegs) return { t1, dv, leg: null };

  // Visual path: planet-centred Lambert arc between the actual endpoints.
  const centre = ctx.eph.positionAt(helio, t0, vec3());
  const centre1 = ctx.eph.positionAt(helio, t1, vec3());
  const end = sub(vec3(), ctx.eph.positionAt(toBody, t1, vec3()), centre1);
  let start: Vec3;
  if (fromBody === helio) {
    // Start from low orbit, offset so the transfer isn't degenerate.
    const ang = Math.atan2(end.y, end.x) - Math.PI * 0.85;
    start = vec3(r1 * Math.cos(ang), r1 * Math.sin(ang), 0);
  } else {
    start = sub(vec3(), ctx.eph.positionAt(fromBody, t0, vec3()), centre);
  }
  if (toBody === helio) {
    const ang = Math.atan2(start.y, start.x) + Math.PI * 0.85;
    end.x = r2 * Math.cos(ang);
    end.y = r2 * Math.sin(ang);
    end.z = 0;
  }
  let sol = solveLambert(start, end, tofDays * DAY, mu);
  if (!sol) sol = solveLambert(start, end, tofDays * 1.05 * DAY, mu);
  if (!sol) return null;
  void from;
  void to;
  return {
    t1,
    dv,
    leg: { kind: 'conic', t0, t1, r0: start, v0: sol.v1, mu, centralBodyId: helio },
  };
}

function costs(cls: ShipClass, dv: number): { fuelT: number; exoticCost: number } {
  if (cls.tier === 5) return { fuelT: 0, exoticCost: cls.exoticCostPerJump ?? 0 };
  if (cls.tier === 4) return { fuelT: 0, exoticCost: dv * (cls.exoticCostPerKmS ?? 0) };
  return { fuelT: dv * cls.fuelTPerKmS, exoticCost: 0 };
}

/** Cheap trip estimate for planning (no legs built). Null when infeasible. */
export function estimateTrip(
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
  earliestJd: number,
  ctx: NavContext,
): TripEstimate | null {
  const s = solveTrip(cls, from, to, earliestJd, ctx, false);
  if (!s) return null;
  return {
    departJd: s.departJd,
    arriveJd: s.arriveJd,
    deltaVKmS: s.deltaVKmS,
    ...costs(cls, s.deltaVKmS),
  };
}

/** Full trajectory plan for dispatch. Null when infeasible or when from === to. */
export function planTrip(
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
  earliestJd: number,
  ctx: NavContext,
): TrajectoryPlan | null {
  const s = solveTrip(cls, from, to, earliestJd, ctx, true);
  if (!s) return null;
  return {
    classId: cls.id,
    fromSiteId: from.id,
    toSiteId: to.id,
    departJd: s.departJd,
    arriveJd: s.arriveJd,
    legs: s.legs,
    deltaVKmS: s.deltaVKmS,
    ...costs(cls, s.deltaVKmS),
  };
}
