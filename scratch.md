# Next steps

Working notes on which open issues to tackle next (as of 2026-11-13). Not a design doc.

## Done

- PR #43: #24 event log, #13 `PriceChanged` bands, #18 barycenters, #23 moon facing, #26 (part).
- PR #44: #36 orbit trails, #35 real starfield, #26 (rest).
- Branch `feat/money-flow`: #11 money ledger and conservation; fees, upkeep and penalties to
  settlements; GDP stipend; Earth export bounty; colony sell orders; price-elastic Earth;
  half of each ship's price to the yard. Colony money is steady in total but pools at Ceres
  (needs #14). Most sell orders expire unfilled.

Every remaining issue is labelled `explore`: each needs a design decision before code (see
`docs/agents/workflow.md`). The options below are starting points for that decision.

## 1. Economy (#5): start here, highest gameplay impact

**#11 Colony liquidity drain**: done on `feat/money-flow` (see above). Leftovers: the Ceres
pooling and the low sell-order fill rate.

**#11 (original notes)**

- 20-year soak: colony treasuries 785M → 28M, contracts posted 171 → 3 per two years. Earth is an
  infinite source and sink, upkeep, fees and penalties are paid to no one, and the Earth stipend
  (~80M/yr) is the only colony income.
- Options to weigh: make colony exports to Earth pay the colony (not just the trader); route
  docking fees and penalties to the host settlement; tax company revenue back to colonies; scale
  the stipend with population or GDP.
- Decide the money-flow model first: it shapes #14, #15 and #16.

**#14 Settlements invest in industry**: only housing grows today, and industry is frozen at 2040.
Depends on #11 (colonies need money to invest). Options: buy machinery and habitat modules from the
treasury, driven by local prices; give facilities depreciation so machinery has steady demand.

**#15 Price formation**: price is a pure function of the stock/target ratio, so one ship swings a
thin market by 4× and there is no slippage. Options: price inertia (move toward target over time),
order-size slippage, real depth for deep markets.

**#16 AI herding**: companies don't see each other's inbound cargo, so ships converge on the same
sale (22 `SellCargo:no-demand` in the soak). Option: expose inbound tonnage per settlement and
good in `CompanyView`; personalities weight it differently.

## 2. Physics (#6)

- **#21 Torch trajectories**: straight-line brachistochrone ignores the origin/target velocity
  difference and solar gravity. Cheap first step: add `|v_target − v_origin|` to the Δv budget and
  a convergence check on the fixed-point loop.
- **#19 Patched-conic Δv**: costs use raw v∞, not `√(v∞² + 2μ/r) − √(μ/r)` from a parking orbit;
  matters for deep wells (Jupiter's moons). Needs a parking-orbit radius per settlement.
- **#20 Rocket-equation fuel**: fuel ignores cargo mass. Needs `dryMassT` and exhaust velocity per
  ship class, and cargo mass in `estimateTrip` cache keys. Changes AI route choice, so it touches
  economy balance too.

## 3. Performance (#7)

- **#25 Worker deltas**: every delta resends all entity tables 20×/s and the replica replaces
  every object. Option: per-entity dirty tracking with version counters, and apply only the
  latest table snapshot per frame.
- **#27 Batched ships and trajectories**: one DOM marker and one `Line` per ship. Option: one
  `InstancedMesh`/`Points` for ships and one `LineSegments` for all trajectories. Fold in the
  orbit-style trailing fade for trajectories (left over from #36).

## 4. Visuals (#9)

- **#34 Atmospheres, night sides, ring shadows, eclipses**: all analytic in shaders (Fresnel rim,
  ray–sphere and ray–ring tests), no shadow maps. Each piece can ship on its own; the atmosphere
  rim is the cheapest win.
- Follow-up from #35 (no issue yet): constellation lines and labels.

## Housekeeping

- GitGuardian flags `src/render/data/brightStars.ts` (base64 star data) as a "Generic Password".
  Mark the incident as a false positive in the dashboard; consider a `.gitguardian.yaml` that
  ignores the path so a regenerated file doesn't trip it again.

## Suggested sequencing

- Most impact: design pass on #11, then #14 and #16 on top of it.
- Contained physics win: the cheap first step of #21.
- Scaling: #25 before large fleets, then #27.
