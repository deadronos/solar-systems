# Logistics Sim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the solar-system viewer into an observable near-future logistics economy: settlements with markets, population and production; AI transport companies flying realistic/sci-fi trajectories, trading, taking contracts, growing and going bankrupt; an RTS/tycoon-style inspection UI.

**Architecture:** New framework-free layers under `src/sim/logistics/` (core → navigation → economy → controllers) driven by a fixed 6-hour tick plus an exact-time scheduler, emitting an append-only event log. Controllers act only via validated commands. Presentation adds ship/settlement rendering under `src/render/logistics/` and HUD panels under `src/ui/logistics/`, reading the world through the existing simulation context.

**Tech Stack:** TypeScript 7, React 19, @react-three/fiber 9, three r187, zustand 5, Vitest 5, oxlint/oxfmt (existing).

**Spec:** `docs/superpowers/specs/2026-11-12-logistics-sim-design.md`

## Global Constraints

- Nothing under `src/sim/**` imports React, react-dom, three or @react-three/* (existing lint rule must keep passing).
- No `Date.now()`, `new Date()`, `Math.random()` or `performance.now()` inside `src/sim/logistics/**`; all randomness via `createRng` (`src/sim/belts/random.ts`) streams seeded from `ScenarioConfig.seed`.
- Economy tick: `TICK_DAYS = 0.25` (6 sim-hours). Ticks are never skipped or resized.
- Start date: 2040-01-01T00:00Z → `START_JD = 2_466_154.5`.
- Max time rate in logistics mode: 1 year/s (`31_557_600` sim-seconds per real second); reverse and "Now" disabled.
- Prices: `price = basePrice × clamp(ratio^(−elasticity), 0.25, 4.0)`, `ratio = stock / targetStock`.
- Bankruptcy grace period: 90 sim days of negative cash.
- Population never dies; survival shortfall causes emigration only.
- Earth Exchange is a deep market: unlimited stock/demand at base price ± fixed spread.
- Iteration over stores in sorted-id order wherever order affects results.
- `pnpm check` (typecheck, lint, format check, tests) passes at the end of every task.

## Review Focus

1. **Dispatch to the ship's current site or between two sites on the same body (Earth Exchange ↔ Gateway)** — must produce a short local hop (hold legs only) or `CommandRejected`, never NaN positions. Test in Task 4.
2. **Lambert transfer angle ≈ 180° (collinear positions)** — solver returns `null` and the planner skips that grid cell; plans never contain NaN. Test in Task 3.
3. **Settlement with zero treasury or near-zero population** — bids drop to 0, no division by zero, population floor stays ≥ 0, contracts not posted without money. Test in Task 5.
4. **Company bankrupt while ships are in transit / selected in UI** — in-flight ships finish their leg then are removed, contracts reopen, inspector shows "no longer exists" instead of crashing. Tests in Task 8 and Task 11.
5. **Frame budget exceeded at 1 yr/s** — world processes at most `maxTicks` per `advanceTo`, sim time lags behind requested time, results stay identical to an unbudgeted run. Test in Task 1.

---

## File Structure

```
src/sim/
  world/ephemeris.ts                       (modify) + positionAt(id, jd, out)
  data/minorBodies.ts                      (modify) + 16 Psyche
  logistics/
    index.ts                               public API of the logistics layer
    core/
      time.ts                              TICK_DAYS, START_JD, MAX_RATE
      events.ts                            EventPayload union, EventLog
      scheduler.ts                         Scheduler<T> min-heap
      world.ts                             LogisticsWorld (stores, advanceTo, tick order)
      commands.ts                          Command union, applyCommand + validators
    data/
      goods.ts  recipes.ts  settlements.ts  shipClasses.ts  personalities.ts
      economyConstants.ts  scenario.ts     (ScenarioConfig, DEFAULT_SCENARIO)
    navigation/
      kepler2.ts                           propagateUniversal(r0, v0, dt, mu)
      lambert.ts                           solveLambert
      plan.ts                              TrajectoryPlan, Leg types, evaluatePlan
      planner.ts                           estimateTrip, planTrip, PorkchopCache
    economy/
      types.ts                             runtime entity types
      markets.ts  production.ts  population.ts  contracts.ts  companies.ts  stats.ts
    controllers/
      types.ts                             CompanyController, CompanyView, WakeReason
      view.ts                              createCompanyView(world, companyId)
      aiBrain.ts                           AiBrain
    *.test.ts                              co-located tests
src/render/logistics/
  ShipLayer.tsx  TrajectoryLayer.tsx  SettlementLayer.tsx  TradeFlowLayer.tsx  focus.ts
src/state/selectionStore.ts                selection, history, follow, filters, overlays
src/ui/logistics/
  TopBar.tsx  Ledgers.tsx  Inspector.tsx  inspectors/{Ship,Settlement,Company,Contract}Inspector.tsx
  EventFeed.tsx  Sparkline.tsx  EntityLink.tsx
```

Modified: `src/sim/simulation.ts` (owns optional `LogisticsWorld`), `src/render/scene/SimDriver.tsx`, `src/render/scene/SolarSystemScene.tsx`, `src/render/SimulationContext.tsx` (focus target), `src/render/scene/CameraRig.tsx`, `src/ui/Hud.tsx`, `src/ui/TimeControls.tsx`, `src/index.css`, `src/app/App.tsx`.

---

### Task 1: Core — time, event log, scheduler, world skeleton

**Files:**

- Create: `src/sim/logistics/core/{time,events,scheduler,world}.ts`, `src/sim/logistics/index.ts`
- Test: `src/sim/logistics/core/core.test.ts`

**Interfaces:**

- Produces:
  - `TICK_DAYS = 0.25`, `START_JD = 2_466_154.5`, `MAX_RATE_SECONDS_PER_SECOND = 31_557_600`
  - `type EventPayload` — discriminated union on `type` covering every event in spec §4.2; each variant carries the ids it concerns (`shipId?`, `companyId?`, `settlementId?`, `contractId?`) plus type-specific fields.
  - `interface LogisticsEvent extends EventPayload { seq: number; jd: number }` (intersection type acceptable)
  - `class EventLog { append(jd: number, e: EventPayload): LogisticsEvent; recent(limit: number, filter?: (e) => boolean): LogisticsEvent[]; forEntity(id: string, limit: number): LogisticsEvent[]; subscribe(fn: (e: LogisticsEvent) => void): () => void; get count(): number; hash(): string }` — ring buffer capacity 10_000; per-entity index capped at 200 per id; `hash()` is a running FNV-1a over `JSON.stringify` of every appended event (never truncated by the ring).
  - `class Scheduler<T> { schedule(jd: number, item: T): void; popDue(jd: number): T | undefined; peekJd(): number | undefined; get size(): number }` — binary min-heap ordered by `(jd, insertion seq)`.
  - `class LogisticsWorld { constructor(config: ScenarioConfig, ephemeris: Ephemeris); readonly events: EventLog; get jd(): number; advanceTo(targetJd: number, maxTicks?: number): number; }` — `advanceTo` returns ticks processed; `jd` only advances by whole ticks. In this task the tick body is an ordered list of phase functions `(world, dtDays) => void` registered in the constructor (empty phases for now); scheduled items are processed before the tick whose time they fall in.
  - `ScenarioConfig` placeholder `{ seed: number; startJd: number }` (extended in Task 2).

- [ ] **Step 1: Write failing tests**

```ts
it('scheduler pops in time then insertion order', () => {
  const s = new Scheduler<string>();
  s.schedule(5, 'b');
  s.schedule(3, 'a');
  s.schedule(5, 'c');
  expect([s.popDue(10), s.popDue(10), s.popDue(10), s.popDue(10)]).toEqual([
    'a',
    'b',
    'c',
    undefined,
  ]);
});
it('event log indexes by entity and keeps a stable hash', () => {
  /* append 3 events for ship s1, forEntity('s1') length 3, hash equal across two identical logs, differs when one event differs */
});
it('advanceTo processes whole ticks only', () => {
  const w = new LogisticsWorld({ seed: 1, startJd: START_JD }, eph);
  expect(w.advanceTo(START_JD + 1.1)).toBe(4);
  expect(w.jd).toBeCloseTo(START_JD + 1.0, 9);
});
it('budgeted advance lags but converges to the same state', () => {
  const a = new LogisticsWorld(cfg, eph);
  const b = new LogisticsWorld(cfg, eph);
  a.advanceTo(START_JD + 30);
  while (b.jd < START_JD + 30 - 1e-9) b.advanceTo(START_JD + 30, 7);
  expect(b.events.hash()).toBe(a.events.hash());
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/sim/logistics/core` — expect FAIL (modules missing).
- [ ] **Step 3:** Implement the four modules with the signatures above; `index.ts` re-exports them.
- [ ] **Step 4:** Run `pnpm vitest run src/sim/logistics/core` — PASS; `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(logistics): core event log, scheduler and tick loop`.

---

### Task 2: Scenario data — goods, recipes, settlements, ship classes, personalities

**Files:**

- Create: `src/sim/logistics/data/{goods,recipes,settlements,shipClasses,personalities,economyConstants,scenario}.ts`, `src/sim/logistics/economy/types.ts`
- Modify: `src/sim/data/minorBodies.ts` (add `psyche`: a 2.924 AU, e 0.134, i 3.10°, Ω 150.0°, ω 229.6°, epoch 2_460_600.5, M0 builder's estimate, radius 111 km, kind `asteroid`), `src/sim/logistics/core/world.ts` (populate stores from config)
- Test: `src/sim/logistics/data/data.test.ts`

**Interfaces:**

- Produces (in `economy/types.ts`):
  - `type GoodId = 'water'|'oxygen'|'food'|'ice'|'regolith'|'ore'|'rare_metals'|'steel'|'fuel'|'electronics'|'machinery'|'medicine'|'consumer_goods'|'habitat_modules'`
  - `interface Good { id: GoodId; name: string; category: 'survival'|'basic'|'comfort'|'raw'|'industrial'; basePrice: number /* credits per tonne */ }`
  - `interface Recipe { id: string; inputs: {good: GoodId; qty: number}[]; outputs: {good: GoodId; qty: number}[]; workersPerUnitPerDay: number }`
  - `interface Facility { recipeId: string; maxRatePerDay: number }`
  - `interface Site { bodyId: string; kind: 'surface'|'orbit' }`
  - `interface SettlementDef { id; name; site: Site; population; housingCapacity; facilities: Facility[]; initialStock: Partial<Record<GoodId, number>>; treasury: number; isShipyard: boolean; isDeepMarket: boolean; needs: boolean /* false for pure stations? default true */ }`
  - `interface MarketEntry { stock: number; targetStock: number; price: number }`
  - `interface Settlement extends SettlementDef { market: Record<GoodId, MarketEntry>; satisfaction: { survival: number; basic: number; comfort: number }; }` (runtime, mutable)
  - `interface ShipClass { id; name; tier: 1|2|3|4|5; cargoT: number; deltaVBudgetKmS?: number /* T1–2 */; accelG?: number /* T3–4 */; maxSpeedFractionC?: number /* T4 */; jumpChargeHours?: number; jumpSpeedC?: number /* T5 */; fuelTPerKmS: number; exoticFuelCost?: number; price: number; upkeepPerDay: number; buildDays: number }`
  - `interface Personality { id; name; preferredTiers: number[]; preferredGoods?: GoodId[]; regionBias?: 'inner'|'belt'|'outer'; riskAversion: number /*0..1*/; minMarginPct: number; contractVsTradeBias: number /*-1 trade … +1 contracts*/; expansionCashThreshold: number; targetUtilisation: number }`
  - `interface CompanyDef { id; name; color: string; personalityId: string; cash: number; ships: { classId: string; siteId: string }[] }`
  - `interface ScenarioConfig { seed: number; startJd: number; goods: Good[]; recipes: Recipe[]; settlements: SettlementDef[]; shipClasses: ShipClass[]; personalities: Personality[]; companies: CompanyDef[]; constants: EconomyConstants }`
  - `DEFAULT_SCENARIO: ScenarioConfig` with the 9 settlements of spec §6.3 (ids: `earth-exchange`, `luna-base`, `gateway`, `mars-colony`, `phobos-station`, `ceres-colony`, `vesta-mines`, `psyche-mines`, `callisto-outpost`), 14 goods, recipes listed in spec §6.2 plus `build_housing`, ~10 ship classes covering tiers 1–5, the 5 personalities of spec §7, 5 companies.
  - `EconomyConstants { elasticity: 1; priceClampMin: 0.25; priceClampMax: 4; spread: 0.08; bufferDays: 60; satisfactionEmaDays: 30; emigrationThreshold: 0.9; maxGrowthPerYear: 0.04; stipendPerCapitaPerDay: number; dockingFee: number; bankruptcyGraceDays: 90; entrantDelayDays: 180; entrantSeedCash: number; contractPremium: 0.25 }` — the explicit numbers here are fixed; the rest are builder's tuning.
  - World stores (on `LogisticsWorld`): `settlements: Map<string, Settlement>`, `companies`, `ships`, `contracts`, `goods`, `recipes`, `shipClasses`, `personalities` (all `Map<string, …>`), and helpers `sortedIds(map)`.

- [ ] **Step 1: Failing test** — `DEFAULT_SCENARIO` validates: every recipe good exists; every settlement `site.bodyId` exists in `DEFAULT_CATALOG`; every company ship's `siteId` is a settlement; exactly one `isDeepMarket`; ship classes cover tiers 1..5; Psyche has a position from the ephemeris at `START_JD` between 2.5 and 3.4 AU from the Sun.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement data modules and world store population (`new LogisticsWorld(DEFAULT_SCENARIO, eph)` builds runtime settlements with full `market` records — missing goods get stock 0).
- [ ] **Step 4:** Run tests + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(logistics): scenario data and world stores`.

---

### Task 3: Navigation — ephemeris at arbitrary time, Kepler propagation, Lambert

**Files:**

- Modify: `src/sim/world/ephemeris.ts` (+ `positionAt(id: string, jd: number, out: Vec3): Vec3` — computes without mutating cached state, recursing through parents)
- Create: `src/sim/logistics/navigation/{kepler2,lambert}.ts`
- Test: `src/sim/logistics/navigation/lambert.test.ts`

**Interfaces:**

- Produces:
  - `MU_SUN_KM3_S2 = 1.327_124_400_18e11`
  - `propagateUniversal(r0: Vec3, v0: Vec3, dtSeconds: number, mu: number, outR: Vec3): Vec3` (universal-variable Kepler, elliptic + hyperbolic)
  - `solveLambert(r1: Vec3, r2: Vec3, tofSeconds: number, mu: number): { v1: Vec3; v2: Vec3 } | null` — single-revolution, prograde (angular momentum +z ecliptic), returns `null` when the transfer angle is within 0.5° of 180° or 0°, or it fails to converge.
  - `bodyVelocity(eph: Ephemeris, id: string, jd: number, out: Vec3): Vec3` — central finite difference ±0.01 day, km/s.

- [ ] **Step 1: Failing tests**

```ts
it('positionAt matches update() and does not disturb cached state', ...)
it('Lambert reproduces a Hohmann-like Earth→Mars arc', () => {
  // r1 = 1 AU on +x, r2 = 1.524 AU at 179°, tof = 258.8 days
  const sol = solveLambert(r1, r2, 258.8 * 86400, MU_SUN_KM3_S2)!;
  expect(length(sol.v1)).toBeCloseTo(32.73, 0);   // km/s
});
it('Lambert returns null for collinear (180°) geometry', ...)
it('propagateUniversal of the Lambert v1 reaches r2 within 1000 km', ...)
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement (universal-variable Lambert with Stumpff functions; Newton/bisection on z).
- [ ] **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(navigation): Kepler propagation and Lambert solver`.

---

### Task 4: Navigation — trajectory plans and trip planner for all tiers

**Files:**

- Create: `src/sim/logistics/navigation/{plan,planner}.ts`
- Test: `src/sim/logistics/navigation/planner.test.ts`

**Interfaces:**

- Consumes: Task 3 functions; `ShipClass`, `Site` (Task 2).
- Produces:
  - `type Leg = { kind: 'hold'; bodyId: string; t0: number; t1: number; label: 'waiting'|'ascent'|'descent'|'charging' } | { kind: 'conic'; t0: number; t1: number; r0: Vec3; v0: Vec3; mu: number; centralBodyId: string | null } | { kind: 'torch'; t0: number; t1: number; from: Vec3; to: Vec3; accelKmS2: number; vMaxKmS: number } | { kind: 'jump'; t0: number; t1: number; from: Vec3; to: Vec3 }`
    (`from`/`to`/`r0` are heliocentric km except `conic` with non-null `centralBodyId`, which is relative to that body.)
  - `interface TrajectoryPlan { classId: string; fromSiteId: string; toSiteId: string; departJd: number; arriveJd: number; legs: Leg[]; deltaVKmS: number; fuelT: number }`
  - `evaluatePlan(plan: TrajectoryPlan, jd: number, eph: Ephemeris, out: Vec3): Vec3` — clamps jd to [departJd, arriveJd]; hold legs return the body position at jd.
  - `interface TripEstimate { departJd: number; arriveJd: number; deltaVKmS: number; fuelT: number }`
  - `estimateTrip(cls: ShipClass, from: Settlement, to: Settlement, earliestJd: number, ctx: NavContext): TripEstimate | null`
  - `planTrip(cls, from, to, earliestJd, ctx): TrajectoryPlan | null`
  - `class NavContext { constructor(eph: Ephemeris); readonly porkchop: PorkchopCache }`; `PorkchopCache.best(fromBody, toBody, cls, earliestJd): TripEstimate | null` — grid: 24 departure offsets over one synodic period × 16 TOFs between 0.5 and 2× Hohmann TOF; cache refreshed when `earliestJd` moves > 30 days past the cached grid start.
- Rules (from spec §5):
  - Same body (e.g. Earth Exchange ↔ Gateway): single `hold` legs, 0.5 day, Δv 0.
  - Same parent (Earth↔Luna, Mars↔Phobos, Jupiter moons): tiers 1–2 planet-centred Hohmann `conic`; tiers 3–5 torch/jump.
  - Surface sites add `ascent`/`descent` hold legs: duration 0.25 day, Δv = 1.2 × circular orbital speed at the surface (√(GM/R)); bodies without `gm` use 0.
  - Tiers 1–2 heliocentric: Lambert between parent-planet positions; Δv = |v1 − vDepartBody| + |v2 − vArriveBody| (+ surface legs); reject if > `deltaVBudgetKmS`.
  - Tier 3: brachistochrone `t = 2√(d/a)`; tier 4 with velocity cap `vMax = maxSpeedFractionC × c` (coast phase); target position iterated 4× for arrival time.
  - Tier 5: `charging` hold of `jumpChargeHours`, then `jump` leg of duration `d / (jumpSpeedC × c)`.
  - `fuelT = deltaVKmS × fuelTPerKmS` (tiers 4–5 use `exoticFuelCost` credits instead; fuelT 0).

- [ ] **Step 1: Failing tests**

```ts
it('tier 1 Earth→Mars takes 150–330 days and has a launch window', ...)  // departJd may be > earliestJd
it('tier 3 Earth→Mars at 0.1 g takes 2–8 days', ...)
it('tier 5 Earth→Callisto is charge time + minutes', ...)
it('same-body hop Earth Exchange → Gateway is hold-only with Δv 0', ...)
it('evaluatePlan is continuous at leg boundaries (< 1000 km jump) and never NaN across 500 samples', ...)
it('estimateTrip returns null when Δv budget is insufficient', ...)
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(navigation): trajectory plans and trip planner for tiers 1–5`.

---

### Task 5: Economy — markets, production, population, treasury

**Files:**

- Create: `src/sim/logistics/economy/{markets,production,population}.ts`
- Modify: `src/sim/logistics/core/world.ts` (register phases: production → consumption/population → prices)
- Test: `src/sim/logistics/economy/economy.test.ts`

**Interfaces:**

- Produces:
  - `priceFor(basePrice: number, stock: number, targetStock: number, c: EconomyConstants): number` (target ≤ 0 ⇒ treat ratio as 1)
  - `askPrice(entry: MarketEntry, c): number` (settlement sells), `bidPrice(entry, c, treasury: number, qty: number): number` (0 if treasury can't pay `qty`)
  - `updateMarket(s: Settlement, world: LogisticsWorld): void` — recompute `targetStock` = (daily consumption + daily production) × `bufferDays` (min 1 t), `price`; deep market: fixed base price, stock pinned at a large constant.
  - `runProduction(s: Settlement, recipes: Map<string, Recipe>, dtDays: number): void` — facilities in declared order; rate = min(maxRate, workers left / workersPerUnitPerDay, inputs / qty); workers = population × 0.5.
  - `runPopulation(s: Settlement, world: LogisticsWorld, dtDays: number): void` — consume needs per capita (constants in `economyConstants.ts`), update EMA satisfaction, growth/emigration per spec §6.5 bounded by `maxGrowthPerYear` and housing; `build_housing` when occupancy > 0.85 and inputs exist (+10% housing per batch); emits `Shortage`/`ShortageResolved` (survival < threshold edge), `PopulationMilestone` (each 10k crossing), `HousingExpanded`.
  - Treasury: `+stipendPerCapitaPerDay × population × dtDays` each tick.
  - `PriceChanged` emitted only when price crosses ±25% of the last emitted value for that settlement/good.

- [ ] **Step 1: Failing tests** — price clamps at 0.25×/4× and equals base at ratio 1; zero treasury ⇒ bid 0 (Review Focus 3); production limited by missing input; starving colony shrinks but population stays ≥ 0 and treasury never NaN (Review Focus 3); well-supplied colony grows but never exceeds housing; housing expands when habitat modules + steel present; deep market price constant after large trades.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(economy): markets, production and population`.

---

### Task 6: Ships, fuel and commands

**Files:**

- Create: `src/sim/logistics/core/commands.ts`
- Modify: `src/sim/logistics/economy/types.ts` (Ship, Company, Contract), `core/world.ts` (scheduler items for departure/arrival/delivery, `issue()`)
- Test: `src/sim/logistics/core/commands.test.ts`

**Interfaces:**

- Produces:
  - `type ShipState = 'docked'|'waiting'|'in_transit'|'building'`
  - `interface Ship { id; companyId; classId; name; state: ShipState; siteId: string | null; plan: TrajectoryPlan | null; cargo: Partial<Record<GoodId, number>>; contractId: string | null; intent: string; pendingRemoval: boolean; stats: { trips: number; revenue: number; costs: number } }`
  - `interface Company { id; name; color; personalityId; cash: number; shipIds: string[]; status: 'active'|'distress'|'bankrupt'; distressSinceJd: number | null; stats: { revenue: number; costs: number } }`
  - `interface Contract { id; kind: 'delivery'|'freight'; settlementId: string /* buyer & destination */; pickupSettlementId: string | null /* freight only */; good: GoodId; qty: number; reward: number; postedJd: number; deadlineJd: number; status: 'open'|'accepted'|'loaded'|'completed'|'expired'; companyId: string | null; shipId: string | null }`
  - `type Command = { type: 'PlanAndDispatch'; shipId; toSiteId } | { type: 'BuyCargo'; shipId; good; qty; maxPrice } | { type: 'SellCargo'; shipId; good; qty; minPrice } | { type: 'AcceptContract'; contractId; shipId } | { type: 'LoadContractCargo'; contractId } | { type: 'DeliverContract'; contractId } | { type: 'AbandonContract'; contractId } | { type: 'PurchaseShip'; classId; shipyardSiteId } | { type: 'SellShip'; shipId }`
  - `applyCommand(world: LogisticsWorld, companyId: string, cmd: Command): boolean` — validates ownership, state, cash, stock, cargo capacity, price limits; on failure appends `CommandRejected { companyId, command, reason }` and returns false.
  - `LogisticsWorld.issue(companyId: string, cmds: Command[]): void`
- Rules: dispatch buys `fuelT` from the departure market at ask price (rejects if stock insufficient; tiers 4–5 pay `exoticFuelCost` credits instead, only at shipyards); charges docking fee on arrival; sets `state='waiting'` until `departJd` then `in_transit`; schedules `ShipArrived` at `arriveJd` (state → docked, `siteId` → destination, emits `ShipIdle` if no contract); upkeep deducted per tick; ship purchase schedules `ShipDelivered` after `buildDays`; resale value = 60% of price.

- [ ] **Step 1: Failing tests** — happy path buy→dispatch→arrive→sell moves stock and cash correctly and emits events in order; rejects: not owner, not docked, insufficient cash, cargo over capacity, price above maxPrice, no fuel at site; dispatch to own current site is rejected with reason `same-site` (Review Focus 1); purchase delivers after buildDays; selling a ship with cargo is rejected.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(logistics): ships, fuel and validated commands`.

---

### Task 7: Contracts lifecycle

**Files:**

- Create: `src/sim/logistics/economy/contracts.ts`
- Modify: `core/world.ts` (contract generation phase, expiry via scheduler)
- Test: `src/sim/logistics/economy/contracts.test.ts`

**Interfaces:**

- Produces:
  - `generateContracts(world: LogisticsWorld): void` — per settlement (not deep market) per good where `stock + inbound < 0.5 × targetStock` and no open contract exists for that good: post a contract for `qty = targetStock − stock − inbound` (capped by treasury at current ask). Choose **freight** when some non-deep market or Earth Exchange has ask ≤ local price and the buyer can pay for goods there (buyer pays the source market immediately; goods reserved at pickup); otherwise **delivery**. Reward = `qty × localPrice × (1 + contractPremium)` for delivery; for freight, fee = estimated tier-2 trip cost × 1.3. Deadline = now + 2 × tier-2 estimate (min 30 days).
  - `inboundQty(world, settlementId, good): number` (accepted/loaded contracts to that settlement)
  - Expiry scheduled at deadline: open → `expired` (`ContractExpired`); accepted-but-undelivered → `expired` + company penalty 10% of reward; freight goods remain in pickup stock.

- [ ] **Step 1: Failing tests** — shortage posts exactly one contract per good; freight chosen when source cheaper, buyer treasury debited; expiry emits event and applies penalty; a broke settlement posts nothing (Review Focus 3); `DeliverContract` completes and pays reward.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(economy): contract generation and lifecycle`.

---

### Task 8: Companies — costs, fleet changes, bankruptcy, new entrants

**Files:**

- Create: `src/sim/logistics/economy/companies.ts`
- Modify: `core/world.ts` (company phase)
- Test: `src/sim/logistics/economy/companies.test.ts`

**Interfaces:**

- Produces:
  - `runCompanies(world: LogisticsWorld, dtDays: number): void` — upkeep; cash < 0 ⇒ `status='distress'`, `CompanyInDistress` once; recovery ⇒ `active`; distress ≥ `bankruptcyGraceDays` ⇒ `CompanyBankrupt`: docked ships removed immediately, in-transit ships flagged `pendingRemoval` and removed on arrival, their contracts reopened (`status='open'`, company/ship null). Schedule entrant at `+entrantDelayDays`.
  - `spawnEntrant(world: LogisticsWorld): Company` — RNG-picked personality, name from a fixed name pool, colour from palette, `entrantSeedCash`, one ship of a class matching the personality at a shipyard; emits `CompanyFounded`.
  - `netWorth(world, companyId): number` = cash + Σ resale value of ships + cargo at Earth base price.

- [ ] **Step 1: Failing tests** — company with negative cash for 90 days goes bankrupt; in-transit ship survives until arrival then is removed (Review Focus 4); its accepted contract reopens; entrant appears after 180 days with `CompanyFounded`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(economy): company finances, bankruptcy and entrants`.

---

### Task 9: Controllers — company view and AI brain

**Files:**

- Create: `src/sim/logistics/controllers/{types,view,aiBrain}.ts`
- Modify: `core/world.ts` (controller phase: collect wake reasons from events since last call + periodic every 4 ticks; call `decide`; `issue` results), `data/scenario.ts` (default controller factory)
- Test: `src/sim/logistics/controllers/aiBrain.test.ts`

**Interfaces:**

- Produces:
  - `type WakeReason = { kind: 'shipIdle'; shipId } | { kind: 'shipArrived'; shipId } | { kind: 'contractPosted'; contractId } | { kind: 'periodic' } | { kind: 'fleetReview' }` (`fleetReview` every 30 days)
  - `interface CompanyController { decide(view: CompanyView, wake: WakeReason[]): Command[] }`
  - `interface CompanyView { readonly jd: number; readonly company: Readonly<Company>; readonly personality: Personality; ships(): readonly Readonly<Ship>[]; settlements(): readonly Readonly<Settlement>[]; openContracts(): readonly Readonly<Contract>[]; shipClass(id): ShipClass; ask(settlementId, good): number; bid(settlementId, good, qty): number; estimateTrip(shipId, fromSiteId, toSiteId): TripEstimate | null; setIntent(shipId: string, text: string): void }` — `setIntent` is the only mutation and only touches the company's own ships' `intent`.
  - `createCompanyView(world, companyId): CompanyView`
  - `class AiBrain implements CompanyController` implementing spec §7 steps 1–5: candidate enumeration (contracts, trade pairs over goods × (current site or reposition) × destinations, reposition-only), score = (expected profit after fuel, upkeep × days, docking) / days with risk discount `profit × (1 − riskAversion × min(1, days/365))`, personality weights; greedy assignment with in-company reservations; emits commands for the chosen job's next step (buy → dispatch; or accept contract → (load) → dispatch; on arrival sell/deliver); intents like `"Trade: steel Mars ₡410 → Ceres ₡690 (+₡182k est.)"`; fleet review buys a class from `preferredTiers` when cash > threshold and utilisation > target, sells worst ship when cash < 10% threshold and utilisation < 0.4.
  - World keeps `controllers: Map<companyId, CompanyController>`; `setController(companyId, c)` for future player swap.

- [ ] **Step 1: Failing tests** — with a hand-built scenario (2 settlements, big price gap, one idle ship) the brain buys at the cheap one and dispatches to the expensive one and sets an intent; two idle ships of the same company don't both take the single contract; a high-risk-aversion personality skips a marginal 300-day trade a low-risk one takes; fleet review purchases a ship when rich and busy.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(controllers): company view and AI brain`.

---

### Task 10: Stats, integration into Simulation, soak/determinism/perf

**Files:**

- Create: `src/sim/logistics/economy/stats.ts`, `src/sim/logistics/soak.test.ts`
- Modify: `src/sim/simulation.ts` (`logistics?: LogisticsWorld` built when `options.scenario` given; `step()` calls `logistics.advanceTo(clock.jd, maxTicksPerStep)` and, if behind, reports `lagDays`), `src/sim/logistics/index.ts`
- Test: `src/sim/logistics/soak.test.ts`

**Interfaces:**

- Produces:
  - `class StatsRecorder { sampleDaily(world): void; series(key: StatKey, id: string): readonly { jd: number; v: number }[] }` with keys `companyCash`, `companyNetWorth`, `settlementPopulation`, `price:<good>` per settlement, `tradeVolumeT` (global, 365-day rolling); capped at 3650 samples per series (downsample ×2 when full).
  - `Simulation` options: `{ scenario?: ScenarioConfig; maxTicksPerStep?: number /* default 400 */ }`; `Simulation.logistics: LogisticsWorld | null`; `Simulation.lagDays: number`.
  - In logistics mode `Simulation.step` clamps the clock: never reverse (rate < 0 ⇒ set to |rate|), rate ≤ `MAX_RATE_SECONDS_PER_SECOND`, and if `lagDays > 2` pins clock jd to `logistics.jd + TICK_DAYS` (so the clock shows achieved time).

- [ ] **Step 1: Failing tests**
  - determinism: two worlds from `DEFAULT_SCENARIO` advanced 365 days ⇒ identical `events.hash()`.
  - soak (timeout 120 s): 20 years ⇒ no NaN/negative stock anywhere; all prices within clamp; ≥ 3 companies `active`; Mars population at end > start; no settlement with survival satisfaction < `emigrationThreshold` continuously for > 365 days; ≥ 1 ship purchase occurred.
  - perf: headless ≥ 2,000 ticks/s over a 2-year run (log the number; assert ≥ 1,000 to avoid CI flakiness).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement stats and integration; **tune constants in `economyConstants.ts` / scenario until the soak passes** (record final values in a comment).
- [ ] **Step 4:** Run + `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(logistics): stats, simulation integration and soak tests`.

---

### Task 11: Presentation — selection store, focus targets, map layers

**Files:**

- Create: `src/state/selectionStore.ts`, `src/render/logistics/{focus,ShipLayer,TrajectoryLayer,SettlementLayer,TradeFlowLayer}.tsx|ts`
- Modify: `src/render/SimulationContext.tsx`, `src/render/scene/SimDriver.tsx`, `src/render/scene/CameraRig.tsx`, `src/render/scene/SolarSystemScene.tsx`, `src/app/App.tsx` (construct `Simulation({ scenario: DEFAULT_SCENARIO, startJd: START_JD })`)
- Test: `src/render/logistics/focus.test.ts` (pure function tests only)

**Interfaces:**

- Produces:
  - `type EntityRef = { kind: 'body'|'settlement'|'ship'|'company'|'contract'; id: string }`
  - `useSelectionStore`: `{ selected: EntityRef | null; history: EntityRef[]; future: EntityRef[]; follow: boolean; companyFilter: string | null; overlays: { tradeFlows: boolean; allTrajectories: boolean; shortages: boolean }; select(ref): void; back(): void; forward(): void; setFollow(b): void; setCompanyFilter(id|null): void; toggleOverlay(k): void }`
  - `resolveFocusPosition(sim: Simulation, ref: EntityRef | null, fallbackBodyId: string, out: Vec3): Vec3` in `focus.ts` — body ⇒ body position; settlement ⇒ its body position; ship ⇒ `evaluatePlan` or docked site; company/contract ⇒ first ship / destination; unknown (e.g. removed ship) ⇒ fallback body. `SimDriver` uses it when `follow` is on (otherwise view-store focus body as today).
  - `ShipLayer`: one `THREE.Points` (or instanced sprites) with per-ship colour = company colour, fixed pixel size, positions from `resolveFocusPosition`-equivalent per ship; click picks nearest ship within 8 px ⇒ `select`. Hidden ships: company filter mismatch.
  - `TrajectoryLayer`: for selected ship (or all with overlay/company filter) sample `evaluatePlan` 256 points between departJd and arriveJd into a line; past part opacity 0.25; jump legs dashed.
  - `SettlementLayer`: marker per settlement at body position (orbit sites offset 2× body radius along +scene-y for legibility); registers DOM labels in `frame.labels` with id `settlement:<id>`; shortage overlay colours marker red/amber/green by survival satisfaction.
  - `TradeFlowLayer`: lines between settlements, width from last-365-day tonnage (aggregated from `CargoSold`/`ContractCompleted` events), colour by company when filtered.

- [ ] **Step 1: Failing tests** — `resolveFocusPosition` returns fallback for a removed ship (Review Focus 4); returns plan position mid-flight; selection history back/forward behaves like a browser (select A, B, C, back ⇒ B, select D clears forward).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run + `pnpm check` — PASS; `pnpm dev`, verify ships move, clicking a ship selects it, F follows it.
- [ ] **Step 5:** Commit `feat(render): logistics map layers and selection`.

---

### Task 12: HUD — top bar, ledgers, inspectors, feed, time controls

**Files:**

- Create: `src/ui/logistics/{TopBar,Ledgers,Inspector,EventFeed,Sparkline,EntityLink}.tsx`, `src/ui/logistics/inspectors/{Ship,Settlement,Company,Contract}Inspector.tsx`
- Modify: `src/ui/Hud.tsx` (layout of spec §8.2: left ledgers with tabs Companies/Settlements/Ships/Contracts, right inspector above existing InfoPanel/LayerToggles, bottom time controls + feed, top bar), `src/ui/TimeControls.tsx` (hide reverse & Now and cap presets at 1 year/s when `sim.logistics`; show achieved rate when lagging), `src/ui/LayerToggles.tsx` (+ overlays), `src/index.css`
- Test: `src/ui/logistics/format.test.ts` for any pure formatting helpers (money `₡1.2M`, tonnes, ETA)

**Interfaces:**

- Consumes: `useSelectionStore`, `useSimulation().logistics`, `StatsRecorder`, `usePolled` (5–10 Hz).
- Produces:
  - `EntityLink({ refTo: EntityRef, children })` — clickable name, selects on click, double-click selects + follow.
  - Inspectors per spec §8.2 bullet list; every entity name rendered via `EntityLink`; ship inspector shows `intent`; removed entities render "This {kind} no longer exists." (Review Focus 4).
  - Keyboard: `F` follow, `Esc` clear selection, `Alt+←/→` back/forward.
  - `EventFeed`: last 200 events, filters (company, settlement, type group), click selects primary entity; human-readable lines e.g. `14:02 Orbis bought 400 t steel @ Mars (₡410/t)`.
  - `TopBar`: date, achieved rate, global trade volume/yr, leader by net worth with trend arrow.

- [ ] **Step 1: Failing tests** for formatting helpers (money, tonnes, durations).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement components.
- [ ] **Step 4:** `pnpm check` — PASS; in the browser: select a company from ledger → inspector shows fleet + chart; click a ship link → ship inspector with intent; feed click selects; bankrupt company's ship shows "no longer exists"; reverse/Now hidden; at 1 year/s the top bar shows achieved rate.
- [ ] **Step 5:** Commit `feat(ui): logistics ledgers, inspectors and event feed`.

---

## Self-review notes

- Spec coverage: §4.1 → T1/T10; §4.2 → T1/T6; §4.3 → T9; §5 → T3/T4/T6 (fuel); §6.1–6.3 → T2; §6.4–6.5 → T5; §6.6 → T7; §6.7 → T6/T8; §7 → T9; §8 → T11/T12; §9 → T2; §10 → T1/T3/T4/T5/T10.
- Review Focus items each have a test in their owning task (T1, T3, T4/T6, T5/T7, T8/T11/T12).
