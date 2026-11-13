# Navigation and trajectories

How ships get from A to B: engine tiers, transfer solvers, caching and trajectory plans. Read
this before changing `src/sim/logistics/navigation/*` or ship classes.

**Source of truth:** `src/sim/logistics/navigation/{planner,lambert,kepler2,plan}.ts`,
`src/sim/logistics/data/shipClasses.ts`.

## Entry points

- `estimateTrip(cls, from, to, jd, ctx)` → `TripEstimate | null` (depart/arrive jd, Δv, fuel
  tonnes, exotic cost). It is cheap, builds no legs, and AI scoring and contract pricing use it.
  Go through `world.nav.estimateCached(...)` in economy code. Estimates are cached by class,
  route and exact request Julian date.
- `planTrip(...)` → `TrajectoryPlan | null` with renderable `legs`. Only `PlanAndDispatch`
  calls it.
- Both return `null` for infeasible trips (over the Δv budget, from === to, no Lambert
  solution). Callers must handle `null`; never throw for infeasibility.
- `NavContext` (`world.nav`) holds the caches: per-pair porkchop grids (rebuilt every 120
  days), immediate-departure sweeps shared by estimates and plans at the exact transfer
  start date, and estimates. Sweep and estimate caches are cleared wholesale
  past a size cap. Snapshots carry the launch grids and cached estimates. The grid
  start depends on past queries, so rebuilding it at restore time can change routes.

## Engine tiers (`ShipClass.tier`)

| Tier                      | Model                                                                                                                                                                                                                                                                           | Cost                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1 chemical, 2 nuclear/ion | Heliocentric **Lambert** transfers (single-rev, prograde) over a launch-window grid: 24 departures across one synodic period × 16 times of flight (0.4–2× Hohmann). Scores arrival time plus a configurable weight on Δv. Same-planet-system hops use a planet-centred Hohmann. | Fuel = Δv × `fuelTPerKmS`; must fit `deltaVBudgetKmS` minus surface ascent/descent. |
| 3 fusion torch            | Straight-line accelerate / flip / decelerate toward the target's predicted position (5 fixed-point iterations).                                                                                                                                                                 | Fuel = Δv × `fuelTPerKmS`.                                                          |
| 4 antimatter              | Torch profile with a speed cap (`maxSpeedFractionC`).                                                                                                                                                                                                                           | Exotic credits per km/s, sold only at shipyards.                                    |
| 5 jump drive              | Charge for `jumpChargeHours`, then a straight-line FTL jump.                                                                                                                                                                                                                    | Flat exotic cost per jump, shipyards only.                                          |

- **Surface sites** add ascent and descent Δv of `nav.surfaceDvFactor` × circular speed
  and hold legs of `nav.surfaceLegDays` (default 1.2× and 6 hours).
- **Same-body hops** (orbit ↔ surface, station ↔ station) are a docking hold of
  `nav.sameBodyDays` (default 12 hours).
- `nav.lowOrbitFactor` sets the local transfer parking radius relative to the body radius.
  `nav.transferDaysPerKmS` weights Δv when scoring Lambert launch windows.

## Plans and legs

`TrajectoryPlan.legs` is an ordered list of `hold` (at a body), `conic` (state vector plus μ,
optionally around a planet), `torch` and `jump` legs, each covering `[t0, t1]` in Julian dates.
`evaluatePlan(plan, jd, eph, out)` gives the heliocentric ship position, clamped to the plan.
The renderer samples it once per plan. Plans are plain data and are mirrored to the main thread.

## Known simplifications (documented, not drift)

- **Transfer Δv** counts hyperbolic-excess differences only, with no parking-orbit
  escape or capture (Oberth) (#19).
- **Fuel** is linear in Δv and ignores cargo mass (#20).
- **Torch flights** ignore solar gravity and the velocity difference between origin and
  target (#21).

Treat these as the current spec. If you fix one, update this section and the issue.
