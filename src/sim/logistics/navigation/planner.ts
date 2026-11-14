import { AU_KM, J2000 } from '../../constants.ts';
import { cross, distance, length, normalize, sub, vec3, type Vec3 } from '../../math/vec3.ts';
import type { Ephemeris } from '../../world/ephemeris.ts';
import { ECONOMY_CONSTANTS } from '../data/economyConstants.ts';
import type { EconomyConstants, Settlement, ShipClass } from '../economy/types.ts';
import { MU_SUN_KM3_S2 } from './kepler2.ts';
import { bodyState, solveLambert } from './lambert.ts';
import type { Leg, TrajectoryPlan } from './plan.ts';

const DAY = 86_400;
const C_KM_S = 299_792.458;

const GRID_REFRESH_DAYS = 120;

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
  /** Departure and arrival v∞ burns (km/s); `dv` is their sum. */
  dvDep: number;
  dvArr: number;
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

  capture(): NavState['grids'] {
    return [...this.#grids];
  }

  restore(grids: NavState['grids']): void {
    // Grids from before #20 have no split burns; drop them and rebuild on demand.
    this.#grids = new Map(grids.filter(([, g]) => g.cells.every((c) => c.dvArr !== undefined)));
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

export interface NavState {
  grids: [string, { start: number; cells: Cell[] }][];
  estimates: [string, TripEstimate | null][];
}

/** Shared navigation context: ephemeris access plus caches. */
export class NavContext {
  readonly eph: Ephemeris;
  readonly balance: Readonly<EconomyConstants['nav']>;
  readonly porkchop: PorkchopCache;
  #sweeps = new Map<string, Cell[]>();
  #estimates = new Map<string, TripEstimate | null>();

  constructor(eph: Ephemeris, balance = ECONOMY_CONSTANTS.nav) {
    this.eph = eph;
    this.balance = Object.freeze({ ...balance });
    this.porkchop = new PorkchopCache(this);
  }

  capture(): NavState {
    return { grids: this.porkchop.capture(), estimates: [...this.#estimates] };
  }

  restore(state: NavState): void {
    this.porkchop.restore(state.grids);
    this.#estimates = new Map(state.estimates);
    this.#sweeps.clear();
  }

  /** The body orbiting the Sun that a body belongs to (itself for planets/asteroids). */
  helioBody(bodyId: string): string {
    const def = this.eph.get(bodyId);
    return def.parentId === null || def.parentId === 'sun' ? bodyId : this.helioBody(def.parentId);
  }

  gm(bodyId: string): number {
    return this.eph.get(bodyId).gm ?? 0;
  }

  /** Powered ascent from (or descent to) a surface site; 0 in orbit. */
  surfaceDv(site: Settlement): number {
    if (site.site.kind !== 'surface') return 0;
    const gm = this.gm(site.site.bodyId);
    const r = this.eph.get(site.site.bodyId).radiusKm;
    return gm > 0 ? this.balance.surfaceDvFactor * Math.sqrt(gm / r) : 0;
  }

  /** Whether arrivals at this body can brake in its atmosphere (#20). */
  aerobrakes(bodyId: string): boolean {
    return this.balance.aerobrakeBodies.includes(bodyId);
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

  /** Immediate-departure sweep, shared by all ship classes (cached by exact departure date). */
  sweepFrom(fromBody: string, toBody: string, t0: number): Cell[] {
    const key = `${fromBody}>${toBody}@${t0}`;
    let cells = this.#sweeps.get(key);
    if (!cells) {
      if (this.#sweeps.size > 5_000) this.#sweeps.clear();
      cells = this.tofSweep(
        fromBody,
        toBody,
        t0,
        this.pairTimescales(fromBody, toBody).hohmannDays,
      );
      this.#sweeps.set(key, cells);
    }
    return cells;
  }

  /** Share estimates at the same simulation instant without reusing orbital geometry across ticks. */
  estimateCached(
    cls: ShipClass,
    from: Settlement,
    to: Settlement,
    jd: number,
    cargoT = 0,
  ): TripEstimate | null {
    // Loads share an estimate per eighth of capacity, rounded up (never optimistic).
    const bucket = loadBucket(cls, cargoT);
    const key = `${cls.id}|${from.id}|${to.id}|${jd}|${bucket}`;
    const cached = this.#estimates.get(key);
    if (cached !== undefined) return cached;
    if (this.#estimates.size > 20_000) this.#estimates.clear();
    const estimate = estimateTrip(cls, from, to, jd, this, (bucket / LOAD_BUCKETS) * cls.cargoT);
    this.#estimates.set(key, estimate);
    return estimate;
  }

  /** Lambert solutions for 16 times of flight at a given departure (heliocentric). */
  tofSweep(fromBody: string, toBody: string, departJd: number, hohmannDays: number): Cell[] {
    const out: Cell[] = [];
    const r1 = vec3();
    const vDep = vec3();
    const r2 = vec3();
    const vArr = vec3();
    const toHelio = this.helioBody(toBody);
    bodyState(this.eph, fromBody, this.helioBody(fromBody), departJd, r1, vDep);
    for (let j = 0; j < 16; j++) {
      const tofDays = hohmannDays * (0.4 + (1.6 * j) / 15);
      bodyState(this.eph, toBody, toHelio, departJd + tofDays, r2, vArr);
      const sol = solveLambert(r1, r2, tofDays * DAY, MU_SUN_KM3_S2);
      if (!sol) continue;
      const dvDep = length(sub(vec3(), sol.v1, vDep));
      const dvArr = length(sub(vec3(), sol.v2, vArr));
      out.push({ departJd, tofDays, dvDep, dvArr, dv: dvDep + dvArr });
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

/** Seconds to cover `d` km from rest to rest: accelerate, (coast at `vMax`), decelerate. */
function torchSeconds(d: number, accel: number, vMax: number): number {
  const tAccFull = Math.sqrt(d / accel);
  if (accel * tAccFull <= vMax) return 2 * tAccFull;
  const tAcc = vMax / accel;
  return 2 * tAcc + (d - accel * tAcc * tAcc) / vMax;
}

const ECLIPTIC_NORTH: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * Waypoint that keeps a straight torch path from `a` to `b` out of the Sun's keep-out sphere
 * (radius `r` km), or null if the line already clears it. The waypoint sits on the sphere
 * above the line's closest point to the Sun, so the path bends around the Sun on the near
 * side. Endpoints inside the sphere (nothing orbits there today) get no detour.
 */
export function sunWaypoint(a: Vec3, b: Vec3, r: number): Vec3 | null {
  if (!(r > 0) || length(a) < r || length(b) < r) return null;
  const d = sub(vec3(), b, a);
  const l2 = d.x * d.x + d.y * d.y + d.z * d.z;
  if (!(l2 > 0)) return null;
  const u = -(a.x * d.x + a.y * d.y + a.z * d.z) / l2;
  if (u <= 0 || u >= 1) return null;
  const p = vec3(a.x + u * d.x, a.y + u * d.y, a.z + u * d.z);
  const dist = length(p);
  if (dist >= r) return null;
  // Straight through the Sun: detour sideways in the ecliptic plane.
  const n = dist > 1e-6 * r ? normalize(p, p) : normalize(p, cross(p, d, ECLIPTIC_NORTH));
  if (!(length(n) > 0)) return vec3(r, 0, 0);
  return vec3(n.x * r, n.y * r, n.z * r);
}

/** Seconds of change in arrival time below which the torch iteration stops. */
const TORCH_TOLERANCE_S = 60;
const TORCH_MAX_ITERATIONS = 10;

/**
 * Arrival time for a torch profile chasing a moving target (fixed-point iteration, stopped at
 * `TORCH_TOLERANCE_S`). The path is straight, or bent once around the Sun's keep-out sphere
 * (`nav.torchSunKeepOutAU`). Δv is the burn plus the velocity difference between the two ends
 * (#21): a ship leaving Earth at 30 km/s must slow to Ceres' 18 km/s. Solar gravity is ignored:
 * it is at most 2% of the weakest torch's thrust outside the keep-out sphere.
 */
function torchSolve(
  ctx: NavContext,
  fromBody: string,
  toBody: string,
  t0: number,
  accel: number,
  vMax: number,
): { t1: number; from: Vec3; to: Vec3; via: Vec3 | null; dv: number } {
  const from = vec3();
  const vFrom = vec3();
  bodyState(ctx.eph, fromBody, ctx.helioBody(fromBody), t0, from, vFrom);
  const keepOut = ctx.balance.torchSunKeepOutAU * AU_KM;
  const to = vec3();
  let via: Vec3 | null = null;
  let t1 = t0;
  let seconds = 0;
  for (let k = 0; k < TORCH_MAX_ITERATIONS; k++) {
    ctx.eph.positionAt(toBody, t1, to);
    via = sunWaypoint(from, to, keepOut);
    const d = via ? distance(from, via) + distance(via, to) : distance(from, to);
    seconds = torchSeconds(d, accel, vMax);
    const next = t0 + seconds / DAY;
    const converged = Math.abs(next - t1) * DAY < TORCH_TOLERANCE_S;
    t1 = next;
    if (converged) break;
  }
  const vTo = vec3();
  bodyState(ctx.eph, toBody, ctx.helioBody(toBody), t1, to, vTo);
  via = sunWaypoint(from, to, keepOut);
  const dv = Math.min(accel * seconds, 2 * vMax) + distance(vTo, vFrom);
  return { t1, from, to, via, dv };
}

/** Estimates share results per 1/LOAD_BUCKETS of a class's cargo capacity. */
const LOAD_BUCKETS = 8;

const loadBucket = (cls: ShipClass, cargoT: number): number =>
  cls.cargoT > 0 && cargoT > 0
    ? Math.min(LOAD_BUCKETS, Math.ceil((cargoT / cls.cargoT) * LOAD_BUCKETS - 1e-9))
    : 0;

/**
 * Propellant (t) to give `dv` km/s to a ship carrying `cargoT`, by the rocket equation:
 * (dry + cargo) × (e^(Δv/vₑ) − 1). Infinite for a class with no exhaust velocity.
 */
export function propellantT(cls: ShipClass, cargoT: number, dv: number): number {
  const ve = cls.exhaustVelocityKmS ?? 0;
  if (!(dv > 0)) return 0;
  if (!(ve > 0)) return Number.POSITIVE_INFINITY;
  return (cls.dryMassT + cargoT) * Math.expm1(dv / ve);
}

/** Most Δv (km/s) a full tank gives with `cargoT` aboard. */
export function maxDeltaV(cls: ShipClass, cargoT: number): number {
  const ve = cls.exhaustVelocityKmS ?? 0;
  const m = cls.dryMassT + cargoT;
  return ve > 0 && m > 0 ? ve * Math.log1p((cls.tankT ?? 0) / m) : 0;
}

function solveTrip(
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
  earliestJd: number,
  ctx: NavContext,
  withLegs: boolean,
  cargoT: number,
): Solved | null {
  if (from.id === to.id) return null;
  const fromBody = from.site.bodyId;
  const toBody = to.site.bodyId;
  const legs: Leg[] = [];
  const maxDv = cls.tier <= 4 ? maxDeltaV(cls, cargoT) : Number.POSITIVE_INFINITY;

  // Same body: a docking hop between stations / surface and orbit.
  if (fromBody === toBody) {
    const dv = Math.max(ctx.surfaceDv(from), ctx.surfaceDv(to));
    if (dv > maxDv) return null;
    if (withLegs)
      legs.push(hold(fromBody, earliestJd, earliestJd + ctx.balance.sameBodyDays, 'docking'));
    return {
      departJd: earliestJd,
      arriveJd: earliestJd + ctx.balance.sameBodyDays,
      deltaVKmS: dv,
      legs,
    };
  }

  const ascentDv = ctx.surfaceDv(from);
  const local = ctx.helioBody(fromBody) === ctx.helioBody(toBody);
  // Arrivals at a body with an atmosphere (from another planet, or from a moon down to its
  // planet) aerobrake: one small burn replaces the capture burn and the powered descent (#20).
  const aero = ctx.aerobrakes(toBody) && (!local || toBody === ctx.helioBody(toBody));
  const descentDv = aero ? ctx.balance.aerobrakeKmS : ctx.surfaceDv(to);
  const ascentDays = from.site.kind === 'surface' ? ctx.balance.surfaceLegDays : 0;
  const descentDays = to.site.kind === 'surface' ? ctx.balance.surfaceLegDays : 0;

  let transferStart: number;
  let transferEnd: number;
  let transferDv: number;
  const transferLegs: Leg[] = [];

  if (cls.tier <= 2) {
    const budget = maxDv - ascentDv - descentDv;
    if (budget <= 0) return null;
    if (local) {
      const r = localTransfer(ctx, fromBody, toBody, from, to, earliestJd + ascentDays, withLegs);
      const dv = r ? r.dvDep + (aero ? 0 : r.dvArr) : 0;
      if (!r || dv > budget) return null;
      transferStart = earliestJd + ascentDays;
      transferEnd = r.t1;
      transferDv = dv;
      if (r.leg) transferLegs.push(r.leg);
    } else {
      const t0 = earliestJd + ascentDays;
      const burn = (c: Cell) => c.dvDep + (aero ? 0 : c.dvArr);
      // Immediate departures first, then later launch windows (earlier cells win ties).
      const now = ctx.sweepFrom(fromBody, toBody, t0);
      const later = ctx.porkchop.cells(fromBody, toBody, t0);
      let best: Cell | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const list of [now, later]) {
        for (const c of list) {
          const dv = burn(c);
          if (dv > budget || (list === later && c.departJd < t0)) continue;
          // Cheapest trip for this class: days of upkeep (waiting included) plus propellant,
          // which grows exponentially with Δv. Ties go to the earlier cell.
          const days = c.departJd + c.tofDays - earliestJd;
          const prop = propellantT(cls, cargoT, ascentDv + dv + descentDv);
          const score = days * cls.upkeepPerDay + prop * ctx.balance.planningFuelPrice;
          if (score < bestScore) {
            best = c;
            bestScore = score;
          }
        }
      }
      if (!best) return null;
      transferStart = best.departJd;
      transferEnd = best.departJd + best.tofDays;
      transferDv = burn(best);
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
    // Acceleration is thrust over starting mass, which includes the propellant the trip
    // needs, which depends on the trip: iterate a few times from the dry + cargo mass.
    const vMax =
      cls.tier === 4 ? (cls.maxSpeedFractionC ?? 0.05) * C_KM_S : Number.POSITIVE_INFINITY;
    transferStart = earliestJd + ascentDays;
    let prop = 0;
    let accel = 0;
    let r: ReturnType<typeof torchSolve> | null = null;
    for (let k = 0; k < 4; k++) {
      accel = ((cls.thrustKN ?? 0) / (cls.dryMassT + cargoT + prop)) * 1e-3;
      if (!(accel > 0)) return null;
      r = torchSolve(ctx, fromBody, toBody, transferStart, accel, vMax);
      prop = Math.min(propellantT(cls, cargoT, r.dv + ascentDv + descentDv), cls.tankT ?? 0);
    }
    if (r!.dv + ascentDv + descentDv > maxDv) return null;
    transferEnd = r!.t1;
    transferDv = r!.dv;
    if (withLegs) {
      transferLegs.push({
        kind: 'torch',
        t0: transferStart,
        t1: transferEnd,
        from: r!.from,
        to: r!.to,
        accelKmS2: accel,
        vMaxKmS: Number.isFinite(vMax) ? vMax : 1e12,
        ...(r!.via ? { via: r!.via } : {}),
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
  if (bodyId === helio) return ctx.eph.get(bodyId).radiusKm * ctx.balance.lowOrbitFactor;
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
): { t1: number; dvDep: number; dvArr: number; leg: Leg | null } | null {
  const helio = ctx.helioBody(fromBody);
  const mu = ctx.gm(helio);
  if (!(mu > 0)) return null;
  const r1 = localRadius(ctx, fromBody, helio);
  const r2 = localRadius(ctx, toBody, helio);
  const at = (r1 + r2) / 2;
  const tofDays = (Math.PI * Math.sqrt(at ** 3 / mu)) / DAY;
  const dvDep = Math.abs(Math.sqrt(mu / r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1));
  const dvArr = Math.abs(Math.sqrt(mu / r2) * (1 - Math.sqrt((2 * r1) / (r1 + r2))));
  const t1 = t0 + tofDays;
  if (!withLegs) return { t1, dvDep, dvArr, leg: null };

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
    dvDep,
    dvArr,
    leg: { kind: 'conic', t0, t1, r0: start, v0: sol.v1, mu, centralBodyId: helio },
  };
}

function costs(cls: ShipClass, dv: number, cargoT: number): { fuelT: number; exoticCost: number } {
  if (cls.tier === 5) return { fuelT: 0, exoticCost: cls.exoticCostPerJump ?? 0 };
  const prop = propellantT(cls, cargoT, dv);
  if (cls.tier === 4) return { fuelT: 0, exoticCost: prop * (cls.exoticCostPerT ?? 0) };
  return { fuelT: prop, exoticCost: 0 };
}

/** Cheap trip estimate for planning (no legs built) with `cargoT` aboard. Null when infeasible. */
export function estimateTrip(
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
  earliestJd: number,
  ctx: NavContext,
  cargoT = 0,
): TripEstimate | null {
  const s = solveTrip(cls, from, to, earliestJd, ctx, false, cargoT);
  if (!s) return null;
  return {
    departJd: s.departJd,
    arriveJd: s.arriveJd,
    deltaVKmS: s.deltaVKmS,
    ...costs(cls, s.deltaVKmS, cargoT),
  };
}

/** Full trajectory plan for dispatch. Null when infeasible or when from === to. */
export function planTrip(
  cls: ShipClass,
  from: Settlement,
  to: Settlement,
  earliestJd: number,
  ctx: NavContext,
  cargoT = 0,
): TrajectoryPlan | null {
  const s = solveTrip(cls, from, to, earliestJd, ctx, true, cargoT);
  if (!s) return null;
  return {
    classId: cls.id,
    fromSiteId: from.id,
    toSiteId: to.id,
    departJd: s.departJd,
    arriveJd: s.arriveJd,
    legs: s.legs,
    deltaVKmS: s.deltaVKmS,
    ...costs(cls, s.deltaVKmS, cargoT),
  };
}
