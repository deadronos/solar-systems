import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { distance, vec3 } from '../../math/vec3.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { LogisticsWorld } from '../core/world.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { evaluatePlan } from './plan.ts';
import { AU_KM } from '../../constants.ts';
import {
  estimateTrip,
  maxDeltaV,
  NavContext,
  planTrip,
  propellantT,
  sunWaypoint,
} from './planner.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const world = new LogisticsWorld(DEFAULT_SCENARIO, eph);
const ctx = new NavContext(eph);
const cls = (id: string) => world.shipClasses.get(id)!;
const site = (id: string) => world.settlements.get(id)!;

describe('planner', () => {
  it('tier 1 Earth→Mars flies a fuel-efficient arc and may wait for a launch window', () => {
    const est = estimateTrip(
      cls('chem-hauler'),
      site('gateway'),
      site('mars-colony'),
      START_JD,
      ctx,
    )!;
    expect(est).not.toBeNull();
    const tof = est.arriveJd - est.departJd;
    // Propellant grows exponentially with Δv (#20), so the planner trades speed for fuel.
    expect(tof).toBeGreaterThan(150);
    expect(tof).toBeLessThan(530);
    expect(est.departJd).toBeGreaterThanOrEqual(START_JD);
    expect(est.deltaVKmS).toBeLessThanOrEqual(12);
  });

  it('tier 2 reaches Mars faster than tier 1 on the same date', () => {
    const t1 = estimateTrip(
      cls('chem-hauler'),
      site('gateway'),
      site('mars-colony'),
      START_JD,
      ctx,
    )!;
    const t2 = estimateTrip(
      cls('ion-clipper'),
      site('gateway'),
      site('mars-colony'),
      START_JD,
      ctx,
    )!;
    expect(t2.arriveJd).toBeLessThan(t1.arriveJd);
  });

  it('tier 3 Earth→Mars at 0.03 g takes days to weeks', () => {
    const est = estimateTrip(
      cls('fusion-freighter'),
      site('gateway'),
      site('mars-colony'),
      START_JD,
      ctx,
    )!;
    const days = est.arriveJd - est.departJd;
    expect(days).toBeGreaterThan(5);
    expect(days).toBeLessThan(45);
  });

  it('tier 4 is faster than tier 3 and pays exotic fuel', () => {
    const t3 = estimateTrip(
      cls('torch-courier'),
      site('gateway'),
      site('ceres-colony'),
      START_JD,
      ctx,
    )!;
    const t4 = estimateTrip(
      cls('am-courier'),
      site('gateway'),
      site('ceres-colony'),
      START_JD,
      ctx,
    )!;
    expect(t4.arriveJd).toBeLessThan(t3.arriveJd);
    expect(t4.exoticCost).toBeGreaterThan(0);
    expect(t4.fuelT).toBe(0);
  });

  it('tier 5 Earth→Callisto is charge + descent time plus minutes', () => {
    const est = estimateTrip(
      cls('jump-clipper'),
      site('gateway'),
      site('callisto-outpost'),
      START_JD,
      ctx,
    )!;
    const hours = (est.arriveJd - est.departJd) * 24;
    expect(hours).toBeGreaterThan(12);
    expect(hours).toBeLessThan(18.5); // 12 h charge + 6 h descent + seconds of jump
  });

  it('same-body hop Earth Exchange → Gateway is hold-only with Δv 0', () => {
    const plan = planTrip(cls('chem-tug'), site('earth-exchange'), site('gateway'), START_JD, ctx)!;
    expect(plan.deltaVKmS).toBe(0);
    expect(plan.legs.every((l) => l.kind === 'hold')).toBe(true);
  });

  it('uses the scenario docking duration in both estimates and plans', () => {
    const custom = new LogisticsWorld(
      {
        ...DEFAULT_SCENARIO,
        constants: {
          ...DEFAULT_SCENARIO.constants,
          nav: { ...DEFAULT_SCENARIO.constants.nav, sameBodyDays: 2 },
        },
      },
      eph,
    );
    const from = site('earth-exchange');
    const to = site('gateway');
    const shipClass = cls('chem-tug');
    const estimate = custom.nav.estimateCached(shipClass, from, to, START_JD)!;
    const plan = planTrip(shipClass, from, to, START_JD, custom.nav)!;
    expect(estimate.arriveJd).toBe(START_JD + 2);
    expect(plan.arriveJd).toBe(estimate.arriveJd);
    expect(plan.legs[0]?.t1).toBe(estimate.arriveJd);
  });

  it('local Earth→Luna tier-1 hop takes a few days', () => {
    const est = estimateTrip(cls('chem-tug'), site('gateway'), site('luna-base'), START_JD, ctx)!;
    const days = est.arriveJd - est.departJd;
    expect(days).toBeGreaterThan(2);
    expect(days).toBeLessThan(10);
  });

  it('chemical ships cannot reach Callisto (Δv budget too small)', () => {
    expect(
      estimateTrip(cls('chem-tug'), site('gateway'), site('callisto-outpost'), START_JD, ctx),
    ).toBeNull();
  });

  it.each([
    ['ion-clipper', 'gateway', 'mars-colony'],
    ['ion-clipper', 'luna-base', 'ceres-colony'],
    ['chem-tug', 'gateway', 'luna-base'],
    ['fusion-freighter', 'gateway', 'mars-colony'],
    ['am-courier', 'gateway', 'ceres-colony'],
    ['jump-clipper', 'mars-colony', 'psyche-mines'],
  ])('matches cached %s estimates to plans from %s to %s', (classId, fromId, toId) => {
    const nav = new NavContext(eph);
    const shipClass = cls(classId);
    const from = site(fromId);
    const to = site(toId);

    // Warm the cache, then ask again within the old two-day bucket at a fractional JD.
    expect(nav.estimateCached(shipClass, from, to, START_JD)).not.toBeNull();
    const jd = START_JD + 0.25;
    const estimate = nav.estimateCached(shipClass, from, to, jd);
    const plan = planTrip(shipClass, from, to, jd, nav);

    expect(estimate).not.toBeNull();
    expect(estimate!.departJd).toBeGreaterThanOrEqual(jd);
    expect(plan).toMatchObject(estimate!);
  });

  it('plans are continuous and never NaN', () => {
    const cases: [string, string, string][] = [
      ['chem-hauler', 'gateway', 'mars-colony'],
      ['ion-clipper', 'luna-base', 'ceres-colony'],
      ['fusion-freighter', 'ceres-colony', 'callisto-outpost'],
      ['jump-clipper', 'mars-colony', 'psyche-mines'],
      ['chem-tug', 'mars-colony', 'phobos-station'],
    ];
    for (const [c, a, b] of cases) {
      const plan = planTrip(cls(c), site(a), site(b), START_JD, ctx)!;
      expect(plan, `${c} ${a}→${b}`).not.toBeNull();
      const pA = vec3();
      const pB = vec3();
      const span = plan.arriveJd - plan.departJd;
      for (let k = 0; k <= 500; k++) {
        evaluatePlan(plan, plan.departJd + (span * k) / 500, eph, pA);
        expect(Number.isFinite(pA.x + pA.y + pA.z), `${c} ${a}→${b} k=${k}`).toBe(true);
      }
      // Leg boundaries join up (local legs may start in low orbit: ≤ 20,000 km offset).
      for (let i = 1; i < plan.legs.length; i++) {
        if (plan.legs[i]!.kind === 'jump' || plan.legs[i - 1]!.kind === 'jump') continue; // ~instant
        const t = plan.legs[i]!.t0;
        evaluatePlan(plan, t - 1e-7, eph, pA);
        evaluatePlan(plan, t + 1e-7, eph, pB);
        expect(distance(pA, pB), `${c} ${a}→${b} leg ${i}`).toBeLessThan(20_000);
      }
      // Arrival matches destination body position.
      evaluatePlan(plan, plan.arriveJd, eph, pA);
      expect(distance(pA, eph.positionAt(site(b).site.bodyId, plan.arriveJd, vec3()))).toBeLessThan(
        1_000,
      );
    }
  });

  it('dispatching to the current site yields null', () => {
    expect(planTrip(cls('chem-tug'), site('gateway'), site('gateway'), START_JD, ctx)).toBeNull();
  });

  describe('torch paths around the Sun (#21)', () => {
    const r = 0.3 * AU_KM;

    it('bends a line that would pass the Sun through a waypoint on the keep-out sphere', () => {
      const w = sunWaypoint(vec3(-AU_KM, 0.1 * AU_KM, 0), vec3(AU_KM, 0.1 * AU_KM, 0), r)!;
      expect(distance(w, vec3())).toBeCloseTo(r, 0);
      expect(w.y).toBeGreaterThan(0); // the near side
      // Dead centre: sideways in the ecliptic plane.
      const c = sunWaypoint(vec3(-AU_KM, 0, 0), vec3(AU_KM, 0, 0), r)!;
      expect(distance(c, vec3())).toBeCloseTo(r, 0);
      expect(c.z).toBeCloseTo(0, 6);
      // Clear of the sphere, or the closest point is an endpoint: straight.
      expect(sunWaypoint(vec3(-AU_KM, AU_KM, 0), vec3(AU_KM, AU_KM, 0), r)).toBeNull();
      expect(sunWaypoint(vec3(AU_KM, 0, 0), vec3(2 * AU_KM, 0, 0), r)).toBeNull();
    });

    it('a torch trip across the Sun detours around it, and pays to match velocities', () => {
      const ship = cls('fusion-freighter');
      let plan = null;
      for (let d = 0; d < 800 && !plan?.legs.some((l) => l.kind === 'torch' && l.via); d += 5) {
        plan = planTrip(ship, site('gateway'), site('mars-colony'), START_JD + d, ctx);
      }
      const leg = plan!.legs.find((l) => l.kind === 'torch')!;
      expect(leg.kind === 'torch' && leg.via).toBeTruthy();
      const p = vec3();
      for (let i = 0; i <= 200; i++) {
        evaluatePlan(plan!, leg.t0 + ((leg.t1 - leg.t0) * i) / 200, eph, p);
        expect(distance(p, vec3())).toBeGreaterThan(0.95 * r);
      }
      // Δv exceeds the burn alone (accel × time) by the Earth–Mars velocity difference.
      const burn = leg.kind === 'torch' ? leg.accelKmS2 * (leg.t1 - leg.t0) * 86_400 : 0;
      expect(plan!.deltaVKmS).toBeGreaterThan(burn + 1);
    });
  });

  describe('rocket equation (#20)', () => {
    it('burns (dry + cargo) × (e^(Δv/vₑ) − 1) and reaches less Δv with a load', () => {
      const tug = cls('chem-tug');
      const ve = tug.exhaustVelocityKmS!;
      expect(propellantT(tug, 0, ve)).toBeCloseTo(tug.dryMassT * (Math.E - 1), 6);
      expect(propellantT(tug, 400, 3)).toBeGreaterThan(propellantT(tug, 0, 3) * 4);
      expect(maxDeltaV(tug, 0)).toBeCloseTo(ve * Math.log1p(tug.tankT! / tug.dryMassT), 6);
      expect(maxDeltaV(tug, tug.cargoT)).toBeLessThan(maxDeltaV(tug, 0) * 0.6);
    });

    it('a heavy load can put a route out of range, and costs more fuel when it fits', () => {
      const hauler = cls('chem-hauler');
      const at = (t: number) =>
        estimateTrip(hauler, site('gateway'), site('vesta-mines'), START_JD, ctx, t);
      expect(at(0)).not.toBeNull();
      expect(at(hauler.cargoT)).toBeNull();
      const luna = (t: number) =>
        estimateTrip(hauler, site('gateway'), site('luna-base'), START_JD, ctx, t)!;
      expect(luna(hauler.cargoT).fuelT).toBeGreaterThan(luna(0).fuelT * 3);
    });

    it('aerobrakes into Mars instead of paying a powered descent', () => {
      const ntr = cls('ntr-freighter');
      const noAir = new NavContext(eph, { ...DEFAULT_SCENARIO.constants.nav, aerobrakeBodies: [] });
      expect(ctx.aerobrakes('mars')).toBe(true);
      expect(ctx.aerobrakes('moon')).toBe(false);
      const trip = (c: NavContext) =>
        estimateTrip(ntr, site('gateway'), site('mars-colony'), START_JD, c, 0)!.deltaVKmS;
      // The capture burn and the 4.3 km/s powered landing give way to one 0.5 km/s burn.
      expect(trip(ctx)).toBeLessThan(trip(noAir) - 3);
    });

    it('a loaded torch ship accelerates less, so it arrives later', () => {
      const ff = cls('fusion-freighter');
      const empty = estimateTrip(ff, site('gateway'), site('ceres-colony'), START_JD, ctx, 0)!;
      const full = estimateTrip(
        ff,
        site('gateway'),
        site('ceres-colony'),
        START_JD,
        ctx,
        ff.cargoT,
      )!;
      expect(full.arriveJd).toBeGreaterThan(empty.arriveJd + 1);
      expect(full.fuelT).toBeGreaterThan(empty.fuelT);
    });

    it('caches estimates per eighth of capacity, rounding the load up', () => {
      const ntr = cls('ntr-freighter');
      const c = new NavContext(eph);
      const a = c.estimateCached(ntr, site('gateway'), site('mars-colony'), START_JD, 1);
      const b = c.estimateCached(
        ntr,
        site('gateway'),
        site('mars-colony'),
        START_JD,
        ntr.cargoT / 8,
      );
      const empty = c.estimateCached(ntr, site('gateway'), site('mars-colony'), START_JD, 0);
      expect(b).toBe(a);
      expect(a).not.toBe(empty);
    });
  });
});
