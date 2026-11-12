import { createRng, type Rng } from '../../belts/random.ts';
import type { Ephemeris } from '../../world/ephemeris.ts';
import { ECONOMY_CONSTANTS } from '../data/economyConstants.ts';
import { GOODS } from '../data/goods.ts';
import {
  GOOD_IDS,
  type Company,
  type Contract,
  type Good,
  type GoodId,
  type MarketEntry,
  type Personality,
  type Recipe,
  type ScenarioConfig,
  type Settlement,
  type SettlementDef,
  type Ship,
  type ShipClass,
} from '../economy/types.ts';
import { EventLog } from './events.ts';
import { NavContext } from '../navigation/planner.ts';
import { applyCommand, type Command } from './commands.ts';
import { Scheduler } from './scheduler.ts';
import { JD_EPSILON, TICK_DAYS } from './time.ts';

export type Phase<W> = (world: W, dtDays: number) => void;
export type ScheduledAction<W> = (world: W) => void;

function hashName(name: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16_777_619);
  return h >>> 0;
}

/**
 * Deterministic world clock: a fixed tick loop plus an exact-time scheduler.
 * Feature modules register phases in a fixed order; state lives in stores.
 */
export class LogisticsWorld {
  readonly config: ScenarioConfig;
  readonly goods = new Map<GoodId, Good>();
  readonly recipes = new Map<string, Recipe>();
  readonly shipClasses = new Map<string, ShipClass>();
  readonly personalities = new Map<string, Personality>();
  readonly settlements = new Map<string, Settlement>();
  readonly companies = new Map<string, Company>();
  readonly ships = new Map<string, Ship>();
  readonly contracts = new Map<string, Contract>();
  #ids = new Map<string, number>();
  #nav: NavContext | null = null;
  readonly ephemeris: Ephemeris;
  readonly events = new EventLog();
  #jd: number;
  #phases: { name: string; fn: Phase<LogisticsWorld> }[] = [];
  #scheduler = new Scheduler<ScheduledAction<LogisticsWorld>>();
  #rngs = new Map<string, Rng>();

  constructor(config: ScenarioConfig, ephemeris: Ephemeris) {
    this.config = config;
    this.ephemeris = ephemeris;
    this.#jd = config.startJd;
    for (const g of config.goods) this.goods.set(g.id, g);
    for (const r of config.recipes) this.recipes.set(r.id, r);
    for (const c of config.shipClasses) this.shipClasses.set(c.id, c);
    for (const p of config.personalities) this.personalities.set(p.id, p);
    for (const def of config.settlements) this.settlements.set(def.id, createSettlement(def, this));
    for (const def of config.companies) {
      const company: Company = {
        id: def.id,
        name: def.name,
        color: def.color,
        personalityId: def.personalityId,
        cash: def.cash,
        shipIds: [],
        status: 'active',
        distressSinceJd: null,
        foundedJd: config.startJd,
        stats: { revenue: 0, costs: 0, tradesCompleted: 0, contractsCompleted: 0 },
      };
      this.companies.set(company.id, company);
      for (const s of def.ships) this.addShip(company, s.classId, s.siteId, s.name, 'docked');
    }
  }

  /** Deterministic sequential id with a prefix, e.g. `ship-12`. */
  nextId(prefix: string): string {
    const n = (this.#ids.get(prefix) ?? 0) + 1;
    this.#ids.set(prefix, n);
    return `${prefix}-${n}`;
  }

  addShip(
    company: Company,
    classId: string,
    siteId: string,
    name: string,
    state: 'docked' | 'building',
  ): Ship {
    const ship: Ship = {
      id: this.nextId('ship'),
      companyId: company.id,
      classId,
      name,
      state,
      siteId,
      plan: null,
      cargo: {},
      contractId: null,
      intent: state === 'building' ? 'Under construction' : 'Idle',
      pendingRemoval: false,
      busyDays: 0,
      stats: { trips: 0, revenue: 0, costs: 0 },
    };
    this.ships.set(ship.id, ship);
    company.shipIds.push(ship.id);
    return ship;
  }

  shipClassOf(ship: Ship): ShipClass {
    const c = this.shipClasses.get(ship.classId);
    if (!c) throw new Error(`Unknown ship class "${ship.classId}"`);
    return c;
  }

  /** Navigation context (lazily created; caches launch-window grids). */
  get nav(): NavContext {
    return (this.#nav ??= new NavContext(this.ephemeris));
  }

  /** Apply commands from a company's controller in order. Returns per-command success. */
  issue(companyId: string, cmds: Command[]): boolean[] {
    return cmds.map((c) => applyCommand(this, companyId, c));
  }

  get constants() {
    return this.config.constants;
  }

  get jd(): number {
    return this.#jd;
  }

  /** Named, independently seeded RNG stream (adding a stream never perturbs others). */
  rng(name: string): Rng {
    let r = this.#rngs.get(name);
    if (!r) {
      r = createRng((this.config.seed * 2_654_435_761) ^ hashName(name));
      this.#rngs.set(name, r);
    }
    return r;
  }

  addPhase(name: string, fn: Phase<LogisticsWorld>): void {
    this.#phases.push({ name, fn });
  }

  schedule(jd: number, action: ScheduledAction<LogisticsWorld>): void {
    this.#scheduler.schedule(jd, action);
  }

  /**
   * Advance by whole ticks up to `targetJd`, processing at most `maxTicks`.
   * Returns the number of ticks processed. Scheduled actions due before a tick's end run
   * (in time order) before that tick's phases.
   */
  advanceTo(targetJd: number, maxTicks = Number.POSITIVE_INFINITY): number {
    let ticks = 0;
    while (ticks < maxTicks && this.#jd + TICK_DAYS <= targetJd + JD_EPSILON) {
      const next = this.#jd + TICK_DAYS;
      for (let a = this.#scheduler.popDue(next); a; a = this.#scheduler.popDue(next)) a(this);
      this.#jd = next;
      for (const p of this.#phases) p.fn(this, TICK_DAYS);
      ticks++;
    }
    return ticks;
  }
}

/** Sorted keys for deterministic iteration. */
export const sortedIds = <T>(map: ReadonlyMap<string, T>): string[] => [...map.keys()].toSorted();

function createSettlement(def: SettlementDef, world: LogisticsWorld): Settlement {
  const market = {} as Record<GoodId, MarketEntry>;
  for (const g of GOOD_IDS) {
    const base = world.goods.get(g)?.basePrice ?? 0;
    const factor = def.deepPriceFactors?.[g] ?? 1;
    const stock = def.isDeepMarket
      ? world.config.constants.deepMarketStock
      : (def.initialStock[g] ?? 0);
    market[g] = {
      stock,
      targetStock: stock,
      price: base * factor,
      consumptionPerDay: 0,
      productionPerDay: 0,
      lastAnnouncedPrice: base * factor,
    };
  }
  return {
    ...def,
    // Earth's economy never runs out of money.
    treasury: def.isDeepMarket ? Number.POSITIVE_INFINITY : def.treasury,
    facilities: def.facilities.map((f) => ({ ...f })),
    market,
    flows: { demand: {}, supply: {} },
    satisfaction: { survival: 1, basic: 1, comfort: 1 },
    inShortage: false,
    lastMilestone: Math.floor(def.population / 10_000),
  };
}

/** Empty scenario (no places, no companies) for core tests. */
export const minimalScenario = (seed: number, startJd = 2_466_154.5): ScenarioConfig => ({
  seed,
  startJd,
  goods: GOODS,
  recipes: [],
  settlements: [],
  shipClasses: [],
  personalities: [],
  companies: [],
  constants: ECONOMY_CONSTANTS,
});
