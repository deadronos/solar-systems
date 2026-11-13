# Logistics economy

The economy's world model, tick loop, determinism rules, markets, contracts and money. Read
this before changing anything in `src/sim/logistics/{core,economy,data}` or `createWorld.ts`.

**Source of truth:** `src/sim/logistics/core/{world,scheduler,events,commands,time}.ts`,
`src/sim/logistics/createWorld.ts`, `src/sim/logistics/economy/*.ts`,
`src/sim/logistics/data/*.ts`.

Related: [navigation.md](navigation.md) (trip planning), [controllers.md](controllers.md)
(company AI and the command seam), [threading.md](threading.md) (worker mirroring).

## World model

`LogisticsWorld` owns plain-data entity maps: `settlements`, `companies`, `ships`,
`contracts`, plus static `goods`, `recipes`, `shipClasses` and `personalities` from the
`ScenarioConfig`. Entities are **plain objects**, because they cross `postMessage` by structured
clone. Ids are deterministic (`world.nextId('ship')` → `ship-12`).

The scenario (`data/scenario.ts` → `DEFAULT_SCENARIO`) is pure data: 2040 start, 14 goods,
recipes, 9 settlements (Earth Exchange is the **deep market**: infinite treasury and fixed
prices), 8 ship classes across 5 engine tiers, personalities and starting companies. Tunables are in
`ECONOMY_CONSTANTS`; others are still module constants (#30).

## Tick loop (never change the order casually)

Fixed **6-hour ticks** (`TICK_DAYS = 0.25`), never skipped or resized. `advanceTo(jd)`:

1. Run scheduled actions due before the tick's end, in (jd, insertion) order (`Scheduler`, a
   binary heap).
2. Advance the clock, then run the phases installed by `createWorld`, in this order:
   **population → production → markets → contracts → ships → companies → stats → controllers**.

Daily work (contract generation, stats samples, periodic controller wake-ups) is gated on
`tick % ticksPerDay === 0`, computed from `(jd − startJd) / TICK_DAYS`.

## Determinism rules

The same seed must produce the identical event log, and `events.hash()` checks it.

- Iterate entity maps in **sorted id order** (`sortedIds(map)`), never in raw insertion order,
  when the order affects outcomes.
- Randomness only from `world.rng('stream-name')`: independent named streams, so adding a stream
  doesn't perturb the others.
- Read planet positions only via `ephemeris.positionAt(id, jd)` at explicit dates, never the
  render-updated `position()`.
- Schedule future work with `world.schedule(jd, action)`; don't keep timers in phases.
- No wall clock, no `Math.random`. Floats are fine; evaluation order must be stable.

## Events

Every state change appends a typed event (`core/events.ts` `EventPayload`) via
`world.events.append(world.jd, payload)`. The UI feed, controllers' wake-ups, stats and trade
flows all consume the same log. Events carry the ids they concern (`shipId`, `companyId`,
`settlementId`, `contractId`…), which drive per-entity indexing and click-through in the UI.
A new event type needs: a union member, a `describeEvent` case in `ui/logistics/format.ts`
(the switch is exhaustive) and, if it concerns new id fields, an update to `eventEntityIds`.

## Commands: the only way companies act

Companies never mutate the world. Their controller returns `Command[]`, and
`world.issue(companyId, cmds)` validates and applies each one (`core/commands.ts`). A
rejection throws an internal `Rejection(reason)`, which becomes a `CommandRejected` event, and
the command returns `false`. Validation checks ownership, docking, cash, stock and capacity
**before** any mutation. Batch semantics are in [controllers.md](controllers.md).

## Markets, production, population

- **Market entry per good:** `stock`, `targetStock`, `price`, EMA `consumptionPerDay` and
  `productionPerDay`.
  - `priceFor` = base × (stock/target)^−elasticity, clamped to [0.25, 4]× base.
  - Settlements sell at `askPrice` (+spread/2) and buy at `bidPrice` (−spread/2). They buy
    only if they consume the good and can pay from **available funds**, and only up to
    3× target stock.
- **Production** (`production.ts`): life-support recipes get workers and inputs first.
  Output is limited by capacity, workers and input stock. Nominal input demand is recorded
  even when inputs are missing, so shortages show up as prices.
- **Population** (`population.ts`):
  - Consumes survival, basic and comfort needs, and updates satisfaction EMAs.
  - Grows, or emigrates below the survival threshold (people leave; nobody dies).
  - Expands housing from goods; survival facilities scale with housing.
  - Collects the Earth stipend, the colonies' only income besides sales.

## Contracts (orders) and settlement money

`generateContracts` runs daily. For each good a colony is short of (projected stock +
inbound below half the desired level):

- **Local shuttle**: a same-body neighbour (e.g. Gateway ↔ Earth Exchange) sells directly. No
  ship is needed, and payment is immediate.
- **Freight**: goods are _reserved_ at the cheapest source (stock removed). The buyer pays the
  escrow to the source **at loading** and pays the carrier's fee on delivery.
- **Delivery**: the carrier sources the goods anywhere; the buyer pays the reward on delivery.
- Unfilled orders expire and are reposted with fees raised by 1.5× per expiry (capped at 8×).
  Accepted contracts that expire penalise the carrier, and loaded freight stays deliverable
  ("late").

**Treasury invariant** (`economy/treasury.ts`): every promise to a live contract is
`settlement.committed`, equal to the sum of `outstanding(c)` (reward, plus escrow until
loaded). Spending decisions use `availableFunds(s) = max(0, treasury − committed)`. Whenever
you add a payment path, `commit` it at posting and `release` it on payment or expiry. The soak
test enforces `treasury ≥ 0` and `committed == Σ outstanding`.

## Companies

`companies.ts`: cash below 0 → `distress`. Still below 0 after `bankruptcyGraceDays` →
`bankrupt`: accepted contracts reopen, loaded freight is lost and the buyer refunded, and
ships are removed (in-flight ones on arrival). A new entrant spawns `entrantDelayDays`
later. Ship upkeep, docking fees and penalties are paid to no one; they are money sinks (#11).

## Known gaps (documented, not drift)

Colony money drains to companies and Earth over the years (#11). Prices have no memory or
order-size slippage (#15). Industry never expands (#14). `PriceChanged` events flood the log
(#13).
