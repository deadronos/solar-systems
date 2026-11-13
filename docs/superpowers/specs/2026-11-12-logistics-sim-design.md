# Logistics Sim — Design

Status: draft for approval · Branch: `feature/logistics-sim` · Date: 2026-11-12

## 1. Intent

Turn the existing true-scale solar-system viewer into a **near-future interplanetary logistics
simulation** that you _watch_. Settlements (Mars, Ceres, Luna, belt mining outposts, orbital
stations, Earth) produce and consume goods. AI-run transport companies fly ships on realistic
orbital trajectories, take contracts and trade between markets for profit, grow their fleets or go
bankrupt.

Why: an observable, emergent economy first; built so that a human player can later take over one
company by swapping that company's controller. Every decision therefore flows through the same
command interface an eventual player UI would use.

### Goals

- A living economy that stays stable for decades of sim time without hand-holding.
- Visible, explainable AI behaviour: you can click a ship and see _why_ it is doing what it does.
- Realistic flight for low-tier ships (launch windows, months-long transfers), with sci-fi tiers
  that are progressively faster.
- Inspection UI in the RTS / tycoon tradition: select, follow, drill down, ledgers, feed.
- Strict layering so each part can be extended or moved to a worker later.

### Non-goals (for this iteration)

- Player control (only the seam for it).
- Combat, piracy, politics, research trees.
- New settlements being founded (roster is fixed but data-driven).
- Light-speed communication delay for information.
- N-body perturbations, gravity assists, finite-burn modelling for low-thrust tiers.
- Save/load and multiplayer (determinism keeps the door open).

### Anti-goals (failure even if it "works")

- Economy collapses, freezes or runs away (hyperinflation, all colonies starving, everyone
  bankrupt) within a few sim years.
- AI behaviour that looks random or can't be explained from the UI.
- Needing the browser console / logs to understand what's happening.
- Sim code depending on React or three.js.

## 2. Decisions made together

| Topic             | Decision                                                                        |
| ----------------- | ------------------------------------------------------------------------------- |
| Purpose           | Observe AI companies + economy; later swappable to player control               |
| Control seam      | Per-company **controller** issues **commands**; world emits **events**          |
| Flight model      | Realistic orbital transfers at low tiers; sci-fi engine tiers above             |
| Layering          | Physics → Navigation → Economy (+ Production) → Controllers → UI                |
| Prices            | Market prices per settlement from supply/demand (stock levels)                  |
| Production chains | One recipe system; depth is data (raw → refined → manufactured)                 |
| Earth             | Deep external market anchoring prices and money                                 |
| Population        | Tiered needs drive growth/decline; population is workforce; housing caps growth |
| Settlement roster | Fixed list, fully data-driven so it can be extended                             |
| Companies         | ~5 AI companies with personalities; **growth and bankruptcy**                   |
| UI                | RTS/tycoon style: select, follow, inspector, ledgers, event feed, map overlays  |
| Architecture      | **Approach A** (below): layered, main thread, plain TS, worker-ready later      |
| Time              | Economy runs forward only; reverse disabled in this mode                        |

## 3. Approaches considered

- **A. Layered sim on the main thread, plain TypeScript stores — chosen.** Simplest to build,
  debug and test; enough performance for hundreds of ships and ~10 companies. The command/event
  boundary makes a later move into a Web Worker a relocation, not a rewrite.
- **B. Same layers inside a Web Worker from day one.** No UI stutter at any time speed, but all UI
  reads become async/stale-tolerant, debugging is harder and plumbing comes first. Deferred.
- **C. ECS library (bitECS / Koota).** Great bulk throughput; domain logic ("company decides to
  buy a ship") reads awkwardly and adds a paradigm the project doesn't need at this scale. Rejected.

## 4. Architecture

```
 ui/            DOM: ledgers, inspector, feed, overlays toggles          (reads, sends commands*)
 render/        three/R3F: ship icons, trajectories, settlement markers  (reads only)
 ─────────────────────────────── boundary: queries + commands in, events out ───────────────────
 sim/logistics/
   controllers/  CompanyController interface, AI brain (later: PlayerController)
   economy/      goods, markets, settlements, population, production, contracts, companies, ships
   navigation/   trip planning per engine tier → TrajectoryPlan
   core/         world store, scheduler, tick loop, command handlers, event bus, RNG
 sim/ (exists)   orbits/ephemeris: body position = f(time), stateless
```

\* In this iteration the UI sends no gameplay commands, only selection/view changes. The
command path exists for controllers and for the future player.

Dependency rule (enforced by lint as today): each layer imports only layers below it. Nothing in
`sim/` imports React/three. Navigation knows nothing about economy; economy asks navigation for
trip estimates/plans.

### 4.1 World, time and scheduling

- **Single `LogisticsWorld`** owns all mutable state in plain typed stores (`Map<Id, T>` +
  arrays), the event log and seeded RNG streams. It holds a reference to the existing
  `Ephemeris` for positions.
- **Hybrid clock:** a **discrete-event scheduler** (priority queue by sim time) for exact-time
  events (ship departures/arrivals, jump completion, ship deliveries from shipyards, bankruptcy
  deadlines) plus a **fixed economy tick of 6 sim-hours** for continuous processes (production,
  consumption, population, price updates, contract posting, controller wake-ups).
- `SimDriver` advances sim time; the world processes, in time order, all scheduled events and
  ticks up to the new time. Within a tick, order is fixed: scheduled events ≤ t → production →
  consumption → population → markets/prices → contract generation → controllers → command
  application.
- **Determinism:** fixed tick, seeded RNG per subsystem, stable iteration order (sorted ids), no
  wall-clock reads inside the sim. Same seed + same config ⇒ identical event log (tested by hash).
- **Time controls in this mode:** reverse and date-jump ("Now") are disabled. Max speed is capped
  at **1 year/s**. A per-frame work budget caps processed ticks; if exceeded, sim time simply
  advances slower than requested (the clock displays actual achieved rate). Determinism is kept
  because ticks are never skipped or resized.
- **Start date:** 2040-01-01 (builder may adjust). Physics/orbits use the same Julian date.

### 4.2 Commands and events

Controllers return `Command[]`; the world validates each (cash, stock, cargo space, ship docked
at the right place, contract still open…) and either applies it and emits events, or emits
`CommandRejected { command, reason }`.

Commands (initial set):

| Command                                         | Effect                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PlanAndDispatch { shipId, toSiteId, option? }` | Navigation plans the trip; fuel is bought and burned; ship departs (or waits for departure time) |
| `BuyCargo { shipId, goodId, qty, maxPrice }`    | Ship docked; transfers goods + cash; moves market stock                                          |
| `SellCargo { shipId, goodId, qty, minPrice }`   | Ship docked; inverse of above                                                                    |
| `AcceptContract { contractId, shipId }`         | Reserves contract for a ship; deadline clock starts                                              |
| `LoadContractCargo { contractId }`              | Freight contracts: picks up shipper-provided cargo                                               |
| `DeliverContract { contractId }`                | Ship docked at destination with cargo; pays reward                                               |
| `AbandonContract { contractId }`                | Penalty; contract reopens                                                                        |
| `PurchaseShip { classId, shipyardSiteId }`      | Pays; ship delivered after build time                                                            |
| `SellShip { shipId }`                           | Docked & empty; pays resale value                                                                |

Events (initial set, all timestamped, carry entity ids for click-through):
`ContractPosted`, `ContractAccepted`, `ContractCompleted`, `ContractExpired`,
`ContractAbandoned`, `ShipDeparted`, `ShipArrived`, `ShipIdle`, `CargoBought`, `CargoSold`,
`FuelPurchased`, `ShipOrdered`, `ShipDelivered`, `ShipSold`, `PriceChanged` (only on threshold
crossings, not every tick), `Shortage` / `ShortageResolved`, `PopulationMilestone`,
`HousingExpanded`, `CompanyFounded`, `CompanyInDistress`, `CompanyBankrupt`,
`CommandRejected`.

The event log is append-only, held in a ring buffer for the UI (e.g. last 10k) plus per-entity
indices so inspectors can show "history" for a ship/company/settlement. Subscribers: UI feed,
controllers (wake-ups), stats aggregation (charts).

### 4.3 Controllers

```ts
interface CompanyController {
  /** Called on wake-ups: ship idle, ship arrived, new contract nearby, periodic (every N ticks). */
  decide(view: CompanyView, wake: WakeReason[]): Command[];
}
```

`CompanyView` is a read-only query API scoped to one company: own fleet/cash/contracts, all
public markets (prices, stock), open contracts, and navigation **estimates** (cheap) for
candidate trips. Information is global and instantaneous (no comms delay — non-goal). A future
`PlayerController` queues commands from the UI and returns them on the next decide call.

## 5. Navigation (flight model)

Sites are located at a body (`surface` or `orbit`). Trips are planned between the _bodies'_
heliocentric positions; surface sites add a fixed **ascent/descent leg** (time + Δv/fuel cost by
body gravity) so surface bases pay a gravity-well tax (Earth market is accessed from orbit, see
§6.3).

A plan is a `TrajectoryPlan { departJd, arriveJd, legs[], deltaV, fuelMass, kind }` where each
leg can be evaluated at any time t → position (km, ecliptic). Ships in flight are not
simulated per tick; render and UI evaluate the plan.

| Tier | Engine (flavour)      | Model                                                                                                                                                               | Planning                                                                                                                    |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | Chemical              | Two-body **Lambert** transfer arc between departure body at t0 and arrival body at t0+TOF; ship flies a Kepler conic                                                | Search departure delay (0…1 synodic period) × TOF grid, minimise wait+TOF subject to ship Δv budget → launch windows emerge |
| 2    | Nuclear-thermal / ion | Same Lambert model, larger Δv budget ⇒ shorter TOF, windows matter less                                                                                             | Same search, different budget                                                                                               |
| 3    | Fusion torch          | **Brachistochrone**: constant accel to midpoint, flip, decel; straight heliocentric line to the target's position at arrival (fixed-point iterate on moving target) | Closed form + 3–5 iterations                                                                                                |
| 4    | Antimatter            | Brachistochrone at extreme accel with a **velocity cap** (fraction of c; coast phase)                                                                               | Same                                                                                                                        |
| 5    | Jump drive (FTL)      | Charge time at departure, then near-instant jump; arrival after `charge + distance / jumpSpeed`                                                                     | Trivial                                                                                                                     |

Same-parent trips (Earth↔Luna, Mars↔Phobos, Jupiter moons) use planet-centred Hohmann
approximations for tiers 1–2 (days) and the same torch/jump models above.

**Planning cost:** controllers use `estimateTrip(class, from, to, earliestJd)` backed by a
per-pair **porkchop cache** (coarse grid, refreshed every ~30 sim days) for tiers 1–2; exact
Lambert solve only on dispatch. Tiers 3–5 are closed-form and cheap.

**Fuel:** each ship class has a Δv budget per trip and a fuel mass per Δv. Fuel is **bought from
the departure site's market** (good `fuel`) at dispatch — this couples logistics to the economy
(fuel depots matter). If a site lacks fuel, dispatch is rejected (`CommandRejected`), and the
controller must route via a depot. Tier 4–5 use special fuels (antimatter / exotic) priced in
credits only, bought at shipyards (keeps them expensive without extra goods).

## 6. Economy

### 6.1 Goods (initial, tonnes as unit)

`water`, `oxygen`, `food`, `ice`, `regolith`, `ore` (metal ore), `rare_metals`, `steel`,
`fuel` (hydrogen/He-3 blend), `electronics`, `machinery`, `medicine`, `consumer_goods`,
`habitat_modules`. Each has a category (survival / basic / comfort / raw / industrial), a base
price (Earth reference), and mass per unit.

### 6.2 Production (recipes)

```ts
Recipe { id, inputs: {good, qty}[], outputs: {good, qty}[], workersPerUnitRate, maxRatePerDay }
```

Raw extraction = recipe with no inputs (e.g. `mine_ore`, `harvest_ice`, `grow_food`).
Refining/manufacturing = recipes with inputs (`ice → water + oxygen`, `ore → steel`,
`rare_metals + steel → electronics`, `steel + electronics → machinery`,
`steel + machinery → habitat_modules`, `ice → fuel`). Each settlement has a list of facilities
(recipe + capacity). Each tick, output = min(capacity, workers available, inputs available,
storage space); workers are allocated across facilities by a fixed priority order per settlement.

### 6.3 Settlements

```ts
Settlement {
  id, name, site: { bodyId, kind: 'surface' | 'orbit', orbitAltitudeKm? },
  population, housingCapacity, facilities[], market, treasury,
  isShipyard, isDeepMarket
}
```

Initial roster (data-driven, extendable):

| Site             | Body / kind                | Role                                                                                          |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Earth Exchange   | Earth orbit (deep market)  | Sells electronics, medicine, machinery, consumer goods; buys rare metals, He-3 fuel; shipyard |
| Luna Base        | Moon surface               | Regolith, He-3/fuel, oxygen; needs food, electronics                                          |
| Gateway Station  | Earth orbit (L1/LEO)       | Hub & fuel depot, shipyard; small needs of everything                                         |
| Mars Colony      | Mars surface               | Food, steel; needs electronics, machinery, habitat modules                                    |
| Phobos Station   | Phobos orbit/surface       | Fuel depot; needs water                                                                       |
| Ceres Colony     | Ceres surface              | Ice/water, fuel; belt capital; shipyard (small); needs food, electronics                      |
| Vesta Mines      | Vesta                      | Ore, rare metals; needs food, water, machinery                                                |
| Psyche Mines     | 16 Psyche (add to catalog) | Ore, rare metals (rich); needs food, water, machinery                                         |
| Callisto Outpost | Callisto surface           | Ice, fuel; needs nearly everything (frontier)                                                 |

**Earth deep market:** effectively infinite stock and demand for its goods at base price with a
fixed spread and slow small noise; it never runs out and never saturates. It anchors prices and is
the ultimate money source/sink. Its gravity well is abstracted (docking in orbit).

### 6.4 Markets and prices

Per settlement per good: `stock`, `targetStock` (derived from consumption/production rate ×
buffer days). Price follows stock ratio:

```
ratio = stock / targetStock
price = basePrice × clamp(ratio^(-elasticity), 0.25, 4.0)
sell-to-traders (ask) = price × (1 + spread/2), buy-from-traders (bid) = price × (1 − spread/2)
```

Prices recompute each tick; trades move stock immediately. Bids are capped by settlement
treasury (a broke colony can't import). Elasticity, spread and buffers are tunable.

### 6.5 Population

- Needs per capita per day by tier: **survival** (water, oxygen, food), **basic** (medicine,
  consumer goods), **comfort** (electronics).
- Each tick: consume from stock; satisfaction per tier = fulfilled fraction, smoothed
  (exponential moving average over ~30 days).
- Growth rate/day = f(satisfaction): survival < threshold ⇒ **emigration** (people leave for Earth;
  no deaths); basic/comfort raise growth and immigration. Population is capped by
  `housingCapacity`.
- **Housing expansion:** a settlement auto-runs a `build_housing` project when it holds
  `habitat_modules` + `steel` (+ `machinery`) and occupancy > ~85% → steady heavy-cargo demand.
- Population = workforce for facilities (with a working fraction).
- Treasury: income from selling to traders + a small **Earth charter stipend** per capita
  (prevents permanent insolvency spirals); spending on imports.

### 6.6 Contracts ("orders")

Settlements post contracts when projected stock (stock + inbound contracted deliveries) falls
below a threshold:

- **Delivery contract:** "Deliver N t of X to S by deadline, reward R" — carrier sources the
  cargo anywhere. R = expected local price × N × premium (urgency-dependent).
- **Freight contract:** "Move N t of X from A to B by deadline, fee F" — the buying settlement has
  already purchased the goods at A (paid A's market); the carrier only hauls. This is the
  "colony buys directly from source" case.

Contracts have expiry; expired → `ContractExpired`, settlement may repost at higher premium.
Accepted contracts reserve the cargo/slot; abandoning costs a penalty.

### 6.7 Companies and ships

- **Ship class** = engine tier × hull: `{ id, tier, cargoT, accel or Δv budget, fuelPerDv,
  price, upkeepPerDay, buildDays }`. Higher tiers: much faster, less cargo per credit, far more
  expensive. A handful of classes (e.g. 2 hulls × 5 tiers, not all combos).
- **Ship:** `{ id, companyId, classId, state: docked|waiting|in_transit|jumping|building,
  siteId?, plan?, cargo, contractId?, intent? }` — `intent` is a human-readable reason set by the
  controller ("Arbitrage: buy steel @ Mars 410 → sell @ Ceres 690, est. +₡182k").
- **Company:** `{ id, name, color, cash, shipIds, personality, controller, stats }`.
- Running costs: fuel per trip (from market), upkeep per day, docking fee per visit.
- **Bankruptcy:** cash < 0 → `CompanyInDistress`; controller must sell ships (docked ships first;
  in-flight ships finish their current leg). Still negative after a grace period (e.g. 90 days)
  → `CompanyBankrupt`, remaining ships auctioned (removed), contracts reopened. After a delay a
  **new company** enters with seed capital and a randomly drawn personality.

## 7. AI company brain

One brain implementation, parameterised by **personality**:

```ts
Personality {
  name, preferredTiers, preferredGoods?, regionBias?,   // e.g. outer system
  riskAversion, minMarginPct, contractVsTradeBias,
  expansionCashThreshold, targetUtilisation
}
```

Initial companies (names/colours are builder's call):

| Style              | Behaviour                                                       | Fleet bias        |
| ------------------ | --------------------------------------------------------------- | ----------------- |
| Bulk hauler        | Construction/raw cargo, long hauls, low margin                  | T1–T2 large hulls |
| Arbitrageur        | Chases price gaps, speculative                                  | T2–T3             |
| Contract carrier   | Prefers posted contracts, low risk                              | Mixed             |
| Express courier    | High value/mass goods (medicine, electronics), urgent contracts | T3–T4 small hulls |
| Frontier outfitter | Belt & Jupiter routes                                           | T2–T3             |

**Decision loop (per wake-up):**

1. For each idle (docked, unassigned) ship, enumerate candidate jobs:
   - open contracts it can feasibly meet (deadline vs `estimateTrip`), including repositioning leg;
   - trade opportunities: (buy at A, sell at B) for goods with positive spread after fuel,
     upkeep and docking, using current prices with a **risk discount** for price movement over
     travel time (longer trip ⇒ larger discount, scaled by riskAversion);
   - reposition-only moves toward high-opportunity regions when nothing else qualifies.
2. Score = expected profit / total days (incl. wait for launch window), weighted by personality.
3. Assign greedily, best score first; mark the opportunity (contract, or market good-volume) as
   **reserved within the company** so its own ships don't pile onto the same gap. Across
   companies there is no coordination — competition is emergent (first to arrive gets the price).
4. Issue commands; set ship `intent` text.
5. **Fleet management** (periodic, e.g. every 30 days): if cash > expansion threshold and
   utilisation > target ⇒ `PurchaseShip` of a class matching personality and observed best
   opportunities; if cash low or utilisation poor ⇒ `SellShip` the worst performer.

Every decision writes enough into `intent` and events that the UI can answer "why is this ship
doing this?".

## 8. Presentation

Builds on the existing scene and HUD; the solar-system viewer remains the map.

### 8.1 Map (render/logistics)

- **Ships:** screen-space icons (instanced, company colour, small heading chevron); positions from
  `TrajectoryPlan` evaluated at current time, through the existing floating origin.
- **Trajectories:** selected ship (or all ships of a filtered company) shows its planned path:
  conic arc for T1–T2, line for T3–T4, dashed "jump" line for T5. Past part dimmed.
- **Settlement markers:** at body position (orbit stations offset slightly for legibility), with
  label and shortage colouring when the overlay is on.
- **Overlays (toggles):** trade-flow lines between settlements (thickness = recent tonnage,
  colour = company or good), company filter, all trajectories, shortage heat.
- **Focus/follow generalised:** floating origin can be a body, a settlement or a ship.

### 8.2 HUD (ui/logistics) — layout as agreed

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 2040-04-12 ▸ 1 day/s   Trade vol 4.2 Mt/yr   Leader: Helix Freight ▲    │ top bar
├──────────────┬───────────────────────────────────────────┬───────────────┤
│[Cos|Sites|   │                                           │  Inspector    │
│ Ships|Contr] │              3D map                       │  (tabs per    │
│  ledgers     │                                           │   entity)     │
├──────────────┴───────────────────────────────────────────┴───────────────┤
│ time controls │ event feed (filterable, click → select)                  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Selection model:** click (map or lists) selects; double-click / `F` follows; `Esc` clears;
  hover tooltip. Selection = `{ kind: 'body'|'settlement'|'ship'|'company'|'contract', id }`
  with back/forward history. All entity names render as links.
- **Inspectors:**
  - Ship: overview (class, tier, state, ETA, intent), cargo, contract, trip log.
  - Settlement: population & satisfaction by tier, housing, market table (stock, bid/ask,
    trend sparkline), facilities/production, docked & inbound ships, open contracts.
  - Company: cash & net-worth chart, fleet list, active contracts, personality, recent
    decisions.
  - Contract: route, cargo, reward/fee, deadline, assignee, status.
- **Ledgers (left tabs):** companies (net worth, cash, ships, profit/yr), settlements
  (population, growth, shortages), ships (filterable by company/state), contracts (open/active).
- **Feed:** latest events, filter by company / settlement / type; click selects.
- Charts: lightweight hand-rolled SVG sparklines/line charts fed by a stats aggregator that
  samples daily (no charting dependency unless the builder finds it necessary).
- UI state (selection, history, filters, overlays) lives in zustand; sim data is read via
  polling selectors at ~5–10 Hz like the existing InfoPanel.

## 9. Configuration & data

All tunables in data modules under `sim/logistics/data/`: goods, recipes, settlements, ship
classes, personalities, economy constants (elasticity, spreads, buffers, stipend, tick length,
bankruptcy grace). A `ScenarioConfig { seed, startJd, settlements, companies, … }` builds a
world, so alternative scenarios and tests are just different configs.

## 10. Testing

- **Unit:** Lambert solver (Hohmann case, known Earth→Mars TOF/Δv range), brachistochrone
  timing, porkchop window search, price curve, population growth/decline, recipes, every command
  validator (accept + reject paths).
- **Determinism:** run scenario N sim days twice ⇒ identical event-log hash.
- **Economy soak (headless, in Vitest):** 20 sim years at default config:
  no NaN/negative stock; prices stay within clamps; ≥ 3 companies alive at end; Mars population
  grows; no settlement at survival satisfaction < threshold for > 1 year continuously; at least
  one bankruptcy _or_ explicit check that the mechanism works in a targeted test.
- **Performance:** benchmark ticks/sec headless; target ≥ 2,000 ticks/s with default fleet
  (≈ 1 year/s at 6 h ticks with headroom).

## 11. Builder's calls (decide during implementation, note in code)

Exact numbers and tuning; starting state (company cash and fleets, settlement stocks and
populations — chosen so the first year is already busy); Lambert solver variant (single-revolution
prograde is enough); what a ship does when it arrives and the bid is below its minimum (hold
cargo and let the controller re-plan on the `ShipArrived` wake-up); names, colours, icon art; ship class roster details; which settlements
are shipyards beyond Earth/Gateway; porkchop grid resolution; ring-buffer sizes; precise UI
styling (consistent with existing HUD); whether the plain orrery remains reachable as a separate
mode (default: logistics layers can be toggled off, physics viewer behaviour otherwise unchanged).
