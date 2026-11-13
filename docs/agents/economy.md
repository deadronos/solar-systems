# Logistics economy

The economy's world model, tick loop, determinism rules, markets, contracts and money. Read
this before changing anything in `src/sim/logistics/{core,economy,data}` or `createWorld.ts`.

**Source of truth:** `src/sim/logistics/core/{world,scheduler,actions,events,commands,time}.ts`,
`src/sim/logistics/createWorld.ts`, `src/sim/logistics/economy/*.ts` (money: `money.ts`),
`src/sim/logistics/data/*.ts`.

Related: [navigation.md](navigation.md) (trip planning), [controllers.md](controllers.md)
(company AI and the command seam), [threading.md](threading.md) (worker mirroring).

## World model

`LogisticsWorld` owns plain-data entity maps: `settlements`, `companies`, `ships`,
`contracts`, plus static `goods`, `recipes`, `shipClasses` and `personalities` from the
`ScenarioConfig`. Entities are **plain objects**, because they cross `postMessage` by structured
clone. Ids are deterministic (`world.nextId('ship')` → `ship-12`).

The scenario (`data/scenario.ts` → `DEFAULT_SCENARIO`) is pure data: 2040 start, 14 goods,
recipes, 9 settlements (Earth Exchange is the **deep market**: unlimited stock and money,
outside the economy's ledger, with prices that move only with recent trade), 8 ship classes across 5 engine tiers, personalities and starting companies.

Scenario balance settings live in `ScenarioConfig.constants`, grouped into `markets`,
`population`, `contracts`, `ships`, `companies`, `ai` and `nav`. Defaults are defined in
`data/economyConstants.ts`. To sweep a setting, copy the scenario, its `constants` object, and
the section being changed. For example, a scenario with a lower contract size cap uses:

```ts
const scenario = {
  ...DEFAULT_SCENARIO,
  constants: {
    ...DEFAULT_SCENARIO.constants,
    contracts: { ...DEFAULT_SCENARIO.constants.contracts, maxContractQtyT: 200 },
  },
};
```

Both economy backends read the same plain-data config. The tick cadence, contract
pruning, numerical tolerances and cache limits remain implementation constants.

## Tick loop (never change the order casually)

Fixed **6-hour ticks** (`TICK_DAYS = 0.25`), never skipped or resized. `advanceTo(jd)`:

1. Run scheduled actions due before the tick's end, in (jd, insertion) order (`Scheduler`, a
   binary heap). A discriminated action record identifies the domain operation and its arguments.
2. Advance the clock, then run the phases installed by `createWorld`, in this order:
   **population → production → investment → markets → contracts → ships → companies → stats → controllers**.

Daily work (contract generation, stats samples, periodic controller wake-ups) is gated on
`tick % ticksPerDay === 0`, computed from `(jd − startJd) / TICK_DAYS`.

## Determinism rules

The same seed must produce the identical event log, and `events.hash()` checks it.

- Iterate entity maps in **sorted id order** (`sortedIds(map)`), never in raw insertion order,
  when the order affects outcomes. `sortedIds` reuses its last (frozen) array while the key set
  is unchanged, so never mutate the result.
- Randomness only from `world.rng('stream-name')`: independent named streams, so adding a stream
  doesn't perturb the others.
- Read planet positions only via `ephemeris.positionAt(id, jd)` at explicit dates, never the
  render-updated `position()`.
- Schedule future work with `world.schedule(jd, action)`; don't keep timers in phases.
- No wall clock, no `Math.random`. Floats are fine; evaluation order must be stable.

## Snapshots

Use `snapshotWorld(world)` between ticks to capture a detached versioned data object. After a
JSON round trip, `restoreWorld(snapshot, ephemeris)` resumes a standard `createWorld` economy
using the same ephemeris catalog. The snapshot includes the scenario, entity tables, ID
counters, named RNG states, scheduled actions, event hash and histories, stats and AI state.
In the snapshot, `treasury: null` represents the unlimited deep-market treasury.
`restoreWorld` fills balance settings missing from an older snapshot's config with defaults.

The snapshot API supports standard phase wiring with built-in AI or controllers disabled.
It rejects replica state, extra tick phases and custom controllers. External event listeners
are runtime wiring. Attach observers again after restoring, and keep their callbacks free of
world mutations for deterministic continuation.

## Events

Every state change appends a typed event (`core/events.ts` `EventPayload`) via
`world.events.append(world.jd, payload)`. The UI feed, controllers' wake-ups, stats and trade
flows all consume the same log. Events carry the ids they concern (`shipId`, `companyId`,
`settlementId`, `contractId`…), which drive per-entity indexing and click-through in the UI.
A new event type needs: a union member, a `describeEvent` case in `ui/logistics/format.ts`
(the switch is exhaustive) and, if it concerns new id fields, an update to `eventEntityIds`.

The log (`EventLog`) keeps the last 10,000 events and the last 200 per entity in circular
buffers. Per-entity histories of removed ships, completed or expired contracts and bankrupt
companies are dropped 90 days after their terminal event, on both the worker and the replica.
The running hash folds each event's fields directly (key order as built by the emitter, numbers
by their float64 bits), so the key order of a payload is part of the determinism contract.

`PriceChanged` is announced only when a price crosses into another band relative to the good's
base price (`cheap` below 0.7×, `scarce` above 1.5×, with a 15% hysteresis margin) and at most
once per 30 days per (settlement, good). Price history itself lives in the daily stats series.

## Commands: the only way companies act

Companies never mutate the world. Their controller returns `Command[]`, and
`world.issue(companyId, cmds)` validates and applies each one (`core/commands.ts`). A
rejection throws an internal `Rejection(reason)`, which becomes a `CommandRejected` event, and
the command returns `false`. Validation checks ownership, docking, cash, stock and capacity
**before** any mutation. Batch semantics are in [controllers.md](controllers.md).

## Markets, production, population

- **Market entry per good:** `stock`, `targetStock`, `price`, EMA `consumptionPerDay` and
  `productionPerDay`.
  - **Deep market:** stock stays unlimited, but `netSoldT` (net tonnes traders sold to it,
    decaying over `markets.deepMarketRecoveryDays`) moves its price:
    `deepPriceFor` = reference × ((depth + netSoldT)/depth)^−elasticity, clamped to
    [`deepPriceClampMin`, `deepPriceClampMax`]. Every trade with it calls `recordDeepTrade`.
  - `priceFor` = base × (stock/target)^−elasticity, clamped to [0.25, 4]× base by default.
  - Settlements sell at `askPrice` (+spread/2) and buy at `bidPrice` (−spread/2). They buy
    only if they consume the good and can pay from **available funds**, and only up to
    `markets.maxStockMultiple` × target stock (3× by default).
- **Production** (`production.ts`): life-support recipes get workers and inputs first.
  Output is limited by capacity, workers and input stock. Nominal input demand is recorded
  even when inputs are missing, so shortages show up as prices.
  - **Life-support reserve:** other recipes may only use stock above
    `industry.survivalInputReserveDays` of the people's survival needs plus the inputs local
    life support uses at capacity (water → fuel, ice → fuel), and record demand only for what
    they use of those goods, so industry never drives survival imports.
  - **Maintenance:** employed workers wear out `industry.maintenancePerWorkerDay` of
    machinery. A shortfall wears every facility's capacity by up to `wearPerYear`
    (compounding per tick, floored at `minRatePerDay`).
  - Each facility keeps a rolling `utilisation`; `idleWorkers` records unemployment.
- **Population** (`population.ts`):
  - Consumes survival, basic and comfort needs, and updates satisfaction EMAs.
  - Grows, or emigrates below the survival threshold (people leave; nobody dies).
  - Expands housing from goods. Life support for the new districts is an investment (below).
  - Collects the Earth charter stipend: `stipendPerCapitaPerDay` per head plus
    `stipendGdpFraction` of the day's output value at base prices.

## Investment (`investment.ts`, #14)

Every `industry.reviewDays` (gated on the tick, like contract generation), a settlement with
no project and idle workers evaluates every recipe in sorted id order:

- **Expand** an existing facility running at ≥ `minUtilisation`, by `expansionFraction`.
- **Build** a new one sized for up to `newFacilityWorkers` idle workers. Processing recipes
  can be built anywhere; extraction recipes (no inputs) only on the site's `deposits`.
- **Margin per day** = added rate × (outputs − inputs) − maintenance. Output is worth the
  local price while local use exceeds local output, otherwise Earth's price ×
  `exportNetback`. Inputs that local output can't cover cost the import price (the dearer
  of local and Earth's).
- A **build kit** (`kitPerWorker` × added workers: machinery and steel) must be affordable
  from funds beyond the survival reserve and pay back within `maxPaybackDays`.
- **Urgent life support** (a survival output below `survivalMargin` × consumption) wins
  regardless of margin, but only if its inputs are produced locally.

The chosen project (`settlement.project`) emits `InvestmentDecision` with a plain reason. Its
kit is added to demand over `kitDemandDays`, so the settlement imports it through ordinary
buy orders. When the kit is in stock it is consumed and `FacilityBuilt` fires. After
`projectTimeoutDays` without the kit, `InvestmentAbandoned`.

## Contracts (orders) and settlement money

`generateContracts` runs daily. An order can be posted when projected stock plus inbound
falls below `contracts.postThreshold` times the desired level (half by default):

- **Local shuttle**: a same-body neighbour (e.g. Gateway ↔ Earth Exchange) sells directly. No
  ship is needed, and payment is immediate.
- **Freight**: goods are _reserved_ at the cheapest source (stock removed). The buyer pays the
  escrow to the source **at loading** and pays the carrier's fee on delivery.
- **Delivery**: the carrier sources the goods anywhere; the buyer pays the reward on delivery.
- **Sell order** (`kind: 'export'`): a producer with stock above `sellOrderStockMultiple` ×
  target offers the excess (at most one live order per good, ≥ `minSellOrderT`) at
  `sellOrderDiscount` below its ask. The goods are reserved. The carrier pays `escrowCost`
  on `LoadContractCargo`, which completes the order (`SellOrderFilled`) and makes the goods
  ordinary cargo. Sell orders are not inbound supply and owe nothing (`outstanding` = 0).
- Unfilled buy orders expire and are reposted with fees raised by 1.5× per expiry (capped at 8× by default).
  Accepted contracts that expire, or are abandoned, fine the carrier `penaltyFraction` of the
  reward (of the price, for sell orders), paid to the settlement that posted the order.
  Loaded freight stays deliverable ("late").

**Treasury invariant** (`economy/treasury.ts`): every promise to a live contract is
`settlement.committed`, equal to the sum of `outstanding(c)` (reward, plus escrow until
loaded). Spending decisions use `availableFunds(s) = max(0, treasury − committed)`. Whenever
you add a payment path, `commit` it at posting and `release` it on payment or expiry. The soak
test enforces `treasury ≥ 0` and `committed == Σ outstanding`.

## Money conservation (#11)

Money inside the economy is company cash plus colony treasuries (`moneySupply`). Every
payment between them goes through `economy/money.ts` (`companyPays`, `creditSettlement`,
`buyShip`), so money only appears or disappears on a **ledger line** (`world.ledger`, kept in
snapshots): `stipend`, `charter` (export bounty), `earth` (trade with a deep market), `shipyard`
(the Earth-made share of new ships, and resale) and `entrants` (seed capital). The soak test
checks `moneySupply − start == ledgerTotal(ledger)` at every step. Any new payment path must use
the helpers: paying a deep market directly would break the invariant.

Where money goes:

- Docking fees, fuel (emergency supply included) and exotic propellant go to the port.
- Ship upkeep is wages, paid to where the ship is, or the port it last left.
- Penalties go to the settlement that posted the order.
- A new ship pays `ships.shipyardShare` of its price to the yard; the rest leaves the economy.
- Selling to Earth earns the colony the goods were bought at (`ship.cargoOrigin`) a charter
  bounty of `markets.earthExportBounty` × base price per tonne.
- A bankrupt carrier's lost freight is charged to the company, which refunds the buyer.

## Companies

`companies.ts`: cash below 0 → `distress`. Still below 0 after `companies.bankruptcyGraceDays` →
`bankrupt`: accepted contracts reopen, loaded freight is lost and the buyer refunded, and
ships are removed (in-flight ones on arrival). A new entrant spawns `companies.entrantDelayDays`
later.

## Known gaps (documented, not drift)

Colony money holds roughly steady in total (#11), but it still pools at Ceres (the shipyard
colony and the largest exporter). Most sell orders expire unfilled. Investment only adds
capacity; nothing closes an unprofitable facility. Prices have no memory or order-size slippage (#15).
