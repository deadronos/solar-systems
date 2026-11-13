import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { distance, vec3 } from '../../math/vec3.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { LogisticsWorld } from '../core/world.ts';
import { DEFAULT_SCENARIO } from '../data/scenario.ts';
import { evaluatePlan } from './plan.ts';
import { estimateTrip, NavContext, planTrip } from './planner.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const world = new LogisticsWorld(DEFAULT_SCENARIO, eph);
const ctx = new NavContext(eph);
const cls = (id: string) => world.shipClasses.get(id)!;
const site = (id: string) => world.settlements.get(id)!;

describe('planner', () => {
  it('tier 1 Earth→Mars takes 150–330 days and may wait for a launch window', () => {
    const est = estimateTrip(
      cls('chem-hauler'),
      site('gateway'),
      site('mars-colony'),
      START_JD,
      ctx,
    )!;
    expect(est).not.toBeNull();
    const tof = est.arriveJd - est.departJd;
    expect(tof).toBeGreaterThan(150);
    expect(tof).toBeLessThan(330);
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
});
