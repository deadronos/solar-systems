# Next steps

Working notes on which open issues to tackle next (as of 2026-11-14). Not a design doc.

## Done

- PR #43: #24 event log, #13 `PriceChanged` bands, #18 barycenters, #23 moon facing, #26 (part).
- PR #44: #36 orbit trails, #35 real starfield, #26 (rest).
- PR #45: #11 money ledger and conservation; fees, upkeep and penalties to
  settlements; GDP stipend; Earth export bounty; colony sell orders; price-elastic Earth;
  half of each ship's price to the yard. Colony money is steady in total but pools at Ceres
  (needs #14). Most sell orders expire unfilled.
- PR #46: #14 settlements invest (expand or build facilities from imported
  kits), machinery maintenance and wear, life-support reserve in production. Population 70k
  → 69k at year 20 with almost no shortages; fleet grows to ~63 ships. PR #47: weekly haul
  pricing and a contract shortlist (perf). Released as v0.3.0.
- Branch `feat/inbound-awareness`: #16 companies see rivals' inbound cargo, weighted by a
  per-personality `competitionWeight`. Over 20 years: rerouted unsold cargo 391 → 168,
  sales below purchase price 10.5% → 4.5%, `SellCargo:no-demand` 14 → 0, population
  69.7k → 72.0k. It exposed a #14 trap (Gateway built a fuel plant it could never sell from
  and starved), fixed with: output valued at local price only for the local gap, idle
  capacity counted, outbound local shuttle to Earth, survival budget only for the people's
  share of a survival good.

- PR #51: #21 torch Sun avoidance (merged). Branch `feat/rocket-equation`: #20.
- PR #50: #15 price formation (merged). PR #49: robustness soaks and production gate (merged).
- PR #48: #16 inbound awareness (merged). Branch `test/soak-robustness`: perturbed 20-year
  soaks (`soakHarness.ts`) and a production profitability gate. Before the gate, 5 of 11
  perturbed runs starved a colony for over a year (Gateway in 4, up to 1,960 days); after it,
  10 of 10 pass with the worst shortage at 110 days.

Every remaining issue is labelled `explore`: each needs a design decision before code (see
`docs/agents/workflow.md`). The options below are starting points for that decision.

## 1. Economy (#5): start here, highest gameplay impact

**#11 Colony liquidity drain**: done in PR #45 (see above). Leftovers: the Ceres
pooling and the low sell-order fill rate.

**#11 (original notes)**

- 20-year soak: colony treasuries 785M → 28M, contracts posted 171 → 3 per two years. Earth is an
  infinite source and sink, upkeep, fees and penalties are paid to no one, and the Earth stipend
  (~80M/yr) is the only colony income.
- Options to weigh: make colony exports to Earth pay the colony (not just the trader); route
  docking fees and penalties to the host settlement; tax company revenue back to colonies; scale
  the stipend with population or GDP.
- Decide the money-flow model first: it shapes #14, #15 and #16.

**#14**: done in PR #46. Original notes: only housing grew, and industry is frozen at 2040.
Depends on #11 (colonies need money to invest). Options: buy machinery and habitat modules from the
treasury, driven by local prices; give facilities depreciation so machinery has steady demand.

**#15 Price formation**: done on `feat/price-formation` (slippage + inertia; Earth depth came
with #11). Fleets end smaller (~30 ships at year 20, was ~45), because slippage trims trade
profits. Also needed: survival goods for industry only from local surplus, and repricing of
untaken survival orders. Leftover: non-survival orders are never repriced.

**#16 AI herding**: done on `feat/inbound-awareness`. Leftovers: competition ignores arrival
times, and there's no soft demand booking.

**Fragility**: addressed on `test/soak-robustness`. Unprofitable industry now idles, and four
perturbed scenarios run in CI. Leftover: the variants only cover four starting conditions, and
start + 700 days loses some population (66.5k vs 72k at year 20) without breaking an invariant.

## 2. Physics (#6)

- **#21 Torch trajectories**: done on `feat/torch-sun-avoidance` (velocity-matching Δv,
  convergence tolerance, Sun keep-out waypoint). Measured first: velocity matching is 1–4% of
  Δv, gravity ≤ 2%, but 2–6% of torch trips crossed within 0.1 AU of the Sun. GPU solving was
  ruled out (breaks determinism and headless runs). Original notes: straight-line brachistochrone ignores the origin/target velocity
  difference and solar gravity. Cheap first step: add `|v_target − v_origin|` to the Δv budget and
  a convergence check on the fixed-point loop.
- **#19 Patched-conic Δv**: done on `feat/patched-conic-dv`. Oberth burns from a parking
  orbit (low orbit, or a station's `parkingOrbitKm`), moons through their planet's well, and
  Edelbaum spirals for the ion clipper. Retune: NTR tank 6,000 → 8,000 t. Over 5 scenarios
  at year 20 the fleet mix matches main within run-to-run spread, with no shortages.
  Population is 73.2k against 74.2k (−1.4%), mostly at Ceres (−800). That gap remains with
  the spiral off, so it comes from the Oberth costs. Leftover: find why Ceres grows slower
  (it ends richer, with lower basic-goods satisfaction and no ice imports).
- **#20 Rocket-equation fuel**: done on `feat/rocket-equation`, realistic (hydrolox 4.4, NTR 9,
  ion 30 km/s) with aerobraking at Earth/Mars/Venus/Titan and load-dependent torch
  acceleration. By year 20: fusion freighters carry the bulk, ion clippers the light
  interplanetary freight, chemical ships mostly local hops, and NTRs make a small loss. Needed
  investment fixes: urgent life support can take workers from industry, chains are followed
  three links, and the minimum expansion is one worker. Leftover: NTRs are still bought early
  (one or two per company) before they show a loss; the am-courier loses money.

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
  `.gitguardian.yaml` now ignores the path; the existing incident still needs marking as a
  false positive in the dashboard.

## Suggested sequencing

- Most impact: #19 (parking-orbit Δv; it raises departure Δv, so recheck balance), then #25.
- Contained physics win: the cheap first step of #21.
- Scaling: #25 before large fleets, then #27.
