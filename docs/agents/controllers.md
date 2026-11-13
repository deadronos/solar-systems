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
  Every company also gets `periodic` (daily) and `fleetReview` (every 30 days). Companies decide
  once per tick, in sorted id order, during the `controllers` phase (the last one).
  To add a wake reason, add it to `WakeReason` _and_ emit it in `installControllers`.
- **`CompanyView`** (`createCompanyView`) is a company-scoped window: own ships, settlements,
  open contracts, market quotes (`ask`, `bid`, `demandRoom`), trip estimates and fuel prices.
  Quotes use the same functions as command validation, so a decision made on the view matches
  what the command will see. Same tick, same state.
- The view's objects are **typed `Readonly` but are the live world objects**. Never mutate them.
  The one sanctioned side channel is `view.setIntent(shipId, text)`, the human-readable
  "what is this ship doing" line shown in the UI (#31 tracks tightening this).

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
  - Open contracts are costed per ship, using landed source cost plus legs.
  - Trades come from here, or after repositioning to a cheap source. The top 6 raw margins get
    a real trip estimate.
  - The score is profit per day, weighted by the company's personality (`contractVsTradeBias`,
    `riskAversion`, `regionBias`, `preferredGoods`, `minMarginPct`).
- Every decision sets the ship's intent. Labels are built lazily (only for the chosen
  candidate) because formatting every option was measurable.
- **Fleet review** (every 30 days):
  - Buys a ship when cash is above `expansionCashThreshold` and utilisation is at least
    `targetUtilisation`.
  - Sells the worst idle ship when in distress or when idle and poor.
- Memory (`#jobs`, `#nextLook`, `#lastBusy`) is **advisory**. The world is the truth: a ship's
  `contractId` overrides remembered jobs. Memory is not serialised.

## Known gaps (documented, not drift)

- Companies don't see each other's inbound cargo and can herd onto the same sale (#16).
- `AiBrain` duplicates some helpers and constants from commands and UI (`cargoMass`,
  `fmtMoney`, `DOCKING_FEE_ESTIMATE`) (#29).
