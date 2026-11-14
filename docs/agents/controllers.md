# Company controllers and the AI

How companies make decisions: the controller interface, the company view, wake-ups, command
batches and the default AI. Read this before changing `src/sim/logistics/controllers/*`,
adding a command, or building a player or alternative controller.

**Source of truth:** `src/sim/logistics/controllers/{types,view,runner,aiBrain}.ts`,
`src/sim/logistics/core/commands.ts` (`Command`, `applyCommands`).

## The seam

```ts
interface CompanyController {
  decide(view: CompanyView, wake: WakeReason[]): Command[];
}
```

- `installControllers(world, factory?)` (from `createWorld({ controllers: true })`) gives every
  company an `AiBrain`. New entrants get one when `CompanyFounded` fires. Swap one with
  `world.setController(id, controller)`.
- **Wake-ups:** `ShipIdle`, `ShipDelivered` and `ShipArrived` events queue reasons per company.
  Every company also gets `periodic` (daily) and `fleetReview` (every `ai.fleetReviewDays`, 30 days by default). Companies decide
  once per tick, in sorted id order, during the `controllers` phase (the last one).
  To add a wake reason, add it to `WakeReason` _and_ emit it in `installControllers`.
- **`CompanyView`** (`createCompanyView`) is a company-scoped window: own ships, settlements,
  open contracts, market quotes (`ask`, `bid`, `demandRoom`), trip estimates, fuel prices and
  the scenario docking fee. `inbound(settlement, good)` is public tracking data: tonnes aboard
  _other_ companies' ships bound there (in transit or waiting to depart). `bid(…, incomingT)`
  prices a sale after `incomingT` more tonnes have landed (`projectedBidPrice`; colonies only,
  and equal to the plain bid at 0). The view also exposes a read-only copy of the scenario AI policy
  and the source stock reserve fraction shared with contract posting.
  Quotes use the same functions as command validation, so a decision made on the view matches
  what the command will see. Same tick, same state.
- The view exposes deeply read-only, frozen copies of world data, including market entries
  and cached trip estimates. Copies are made on first access and reused within a decision.
  Create a new view for each decision so its queries and quotes use current world state.
- Controllers update the ship's human-readable intent with `SetIntent`. The command checks
  ownership and emits `ShipIntentChanged` only when the text changes. The worker sends the
  updated intent as part of its regular ship data.

## Command batches

`world.issue(companyId, cmds)` → `applyCommands`:

- Commands apply **in order**, each validated against the state left by the previous ones.
- A ship's commands form a plan. Once one of them is rejected, that ship's **later commands in
  the same batch are skipped** (`CommandRejected`, reason `earlier-step-failed`). A failed
  `BuyCargo` therefore never leads to an empty `PlanAndDispatch`. Commands are mapped to ships
  by `shipId`, or through the contract's `shipId` (`commandShipId`).
- Other ships' commands in the batch are unaffected.

To add a command: add a union member to `Command`, a `case` in `apply()` that validates fully
(`reject('reason')`) before mutating, emit the matching event(s), and make sure
`commandShipId` maps it to its ship if it has one.

## AiBrain (default controller)

- **Greedy and explainable.** For each idle docked ship:
  1. Continue its job: a contract step, or the buy/haul/sell stages of a trade.
  2. Otherwise sell any unassigned cargo here or route it to the best buyer.
  3. Otherwise pick the best-scoring candidate.
- **Candidates and scoring:**
  - Open contracts are shortlisted by profit before travel (reward less the cheapest goods,
    the freight fee, or a sell order's resale gain); only the top 8 are costed per ship,
    using landed source cost plus the cost of each leg.
    Contract and trade estimates include the scenario docking fee per leg.
  - Sell orders (`export` contracts) are scored like trades: the offer price plus legs to the
    seller and on to the best bid, risk-discounted. On loading, the ship's job becomes a
    trade to that buyer.
  - Trades come from here, or after repositioning to a cheap source. The top 6 raw margins get
    a real trip estimate.
  - **Competition (#16):** at every destination the AI expects `#incoming` tonnes to land
    first: its own trade jobs bound there plus `competitionWeight` × rivals' `inbound`
    (`ai.defaultCompetitionWeight` if unset). That cuts the demand room it plans for and
    prices the sale with `bid(…, incoming)`, for trades, sell-order buyers and rerouted
    leftovers. Arbitrageurs weight rivals most (0.9), frontier outfitters least (0.3).
  - The score is profit per day, weighted by the company's personality (`contractVsTradeBias`,
    `riskAversion`, `regionBias`, `preferredGoods`, `minMarginPct`, `competitionWeight`).
- The AI builds intent labels lazily for the chosen plan. It emits the final label once,
  before the ship's action commands, so the label can explain the plan even if an action
  is rejected.
- **Fleet review**:
  - Buys a ship when cash is above `expansionCashThreshold` and utilisation is at least
    `targetUtilisation`.
  - Sells the worst idle ship when in distress or when idle and poor.
- Memory (`#jobs`, `#nextLook`, `#lastBusy`) is **advisory**. The world is the truth: a ship's
  `contractId` overrides remembered jobs. Snapshots preserve that memory, the last fleet
  review date and the runner's queued wake reasons for exact continuation.

## Known gaps (documented, not drift)

- Competition ignores arrival times: a rival landing after this ship counts the same as one
  landing before it, scaled only by `competitionWeight`. No soft demand booking either (#16).
