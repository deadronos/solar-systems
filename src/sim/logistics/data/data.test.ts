import { describe, expect, it } from 'vitest';
import { AU_KM } from '../../constants.ts';
import { DEFAULT_CATALOG } from '../../data/catalog.ts';
import { length } from '../../math/vec3.ts';
import { Ephemeris } from '../../world/ephemeris.ts';
import { START_JD } from '../core/time.ts';
import { LogisticsWorld } from '../core/world.ts';
import { GOOD_IDS } from '../economy/types.ts';
import { DEFAULT_SCENARIO } from './scenario.ts';

const eph = new Ephemeris(DEFAULT_CATALOG);
const bodyIds = new Set(DEFAULT_CATALOG.map((b) => b.id));
const goodIds = new Set<string>(GOOD_IDS);

describe('DEFAULT_SCENARIO', () => {
  const s = DEFAULT_SCENARIO;

  it('references only known goods in recipes, needs and stocks', () => {
    expect(new Set(s.goods.map((g) => g.id))).toEqual(goodIds);
    for (const r of s.recipes) {
      for (const l of [...r.inputs, ...r.outputs]) expect(goodIds.has(l.good), r.id).toBe(true);
    }
    for (const tier of Object.values(s.constants.needsPerCapitaPerDay)) {
      for (const g of Object.keys(tier)) expect(goodIds.has(g)).toBe(true);
    }
  });

  it('places settlements on known bodies and uses known recipes', () => {
    const recipeIds = new Set(s.recipes.map((r) => r.id));
    for (const st of s.settlements) {
      expect(bodyIds.has(st.site.bodyId), st.id).toBe(true);
      for (const f of st.facilities) expect(recipeIds.has(f.recipeId), f.recipeId).toBe(true);
    }
    expect(s.settlements.filter((x) => x.isDeepMarket)).toHaveLength(1);
    expect(s.settlements).toHaveLength(9);
  });

  it('gives every settlement body (and its planet) a GM for the trip planner', () => {
    const byId = new Map(DEFAULT_CATALOG.map((b) => [b.id, b]));
    for (const st of s.settlements) {
      const body = byId.get(st.site.bodyId)!;
      expect(body.gm, body.id).toBeGreaterThan(0);
      const parent = body.parentId ? byId.get(body.parentId) : undefined;
      if (parent && parent.id !== 'sun') expect(parent.gm, parent.id).toBeGreaterThan(0);
    }
  });

  it('starts company ships at real settlements with real classes and personalities', () => {
    const sites = new Set(s.settlements.map((x) => x.id));
    const classes = new Set(s.shipClasses.map((c) => c.id));
    const pers = new Set(s.personalities.map((p) => p.id));
    for (const c of s.companies) {
      expect(pers.has(c.personalityId)).toBe(true);
      for (const sh of c.ships) {
        expect(sites.has(sh.siteId)).toBe(true);
        expect(classes.has(sh.classId)).toBe(true);
      }
    }
  });

  it('covers engine tiers 1 through 5', () => {
    expect(new Set(s.shipClasses.map((c) => c.tier))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('has 16 Psyche in the belt', () => {
    eph.update(START_JD);
    const r = length(eph.position('psyche')) / AU_KM;
    expect(r).toBeGreaterThan(2.5);
    expect(r).toBeLessThan(3.4);
  });
});

describe('LogisticsWorld stores', () => {
  it('builds runtime settlements with full markets, companies and docked ships', () => {
    const w = new LogisticsWorld(DEFAULT_SCENARIO, eph);
    expect(w.settlements.size).toBe(9);
    const mars = w.settlements.get('mars-colony')!;
    for (const g of GOOD_IDS) expect(mars.market[g]).toBeDefined();
    expect(mars.market.steel.stock).toBe(3_000);
    expect(mars.market.rare_metals.stock).toBe(0);
    expect(w.companies.size).toBe(5);
    const ships = [...w.ships.values()];
    expect(ships.length).toBe(16);
    expect(ships.every((sh) => sh.state === 'docked' && sh.siteId !== null)).toBe(true);
    expect(w.companies.get('helix')!.shipIds).toHaveLength(3);
  });
});
