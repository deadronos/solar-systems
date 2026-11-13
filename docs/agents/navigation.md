# Navigation and trajectories

How ships get from A to B: engine tiers, transfer solvers, caching and trajectory plans. Read
this before changing `src/sim/logistics/navigation/*` or ship classes.

**Source of truth:** `src/sim/logistics/navigation/{planner,lambert,kepler2,plan}.ts`,
`src/sim/logistics/data/shipClasses.ts`.

## Entry points

- `estimateTrip(cls, from, to, jd, ctx)` → `TripEstimate | null` (depart/arrive jd, Δv, fuel
  tonnes, exotic cost). It is cheap, builds no legs, and AI scoring and contract pricing use it.
  Go through `world.nav.estimateCached(...)` (2-day buckets) in economy code.
- `planTrip(...)` → `TrajectoryPlan | null` with renderable `legs`. Only `PlanAndDispatch`
  calls it.
- Both return `null` for infeasible trips (over the Δv budget, from === to, no Lambert
  solution). Callers must handle `null`; never throw for infeasibility.
- `NavContext` (`world.nav`) holds the caches: per-pair porkchop grids (rebuilt every 120
  days), immediate-departure sweeps per whole day, and estimates. Caches are cleared wholesale
  past a size cap.

## Engine tiers (`ShipClass.tier`)

| Tier                      | Model                                                                                                                                                                                                                                                        | Cost                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1 chemical, 2 nuclear/ion | Heliocentric **Lambert** transfers (single-rev, prograde) over a launch-window grid: 24 departures across one synodic period × 16 times of flight (0.4–2× Hohmann). Picks earliest arrival + 0.5 × Δv. Same-planet-system hops use a planet-centred Hohmann. | Fuel = Δv × `fuelTPerKmS`; must fit `deltaVBudgetKmS` minus surface ascent/descent. |
| 3 fusion torch            | Straight-line accelerate / flip / decelerate toward the target's predicted position (5 fixed-point iterations).                                                                                                                                              | Fuel = Δv × `fuelTPerKmS`.                                                          |
| 4 antimatter              | Torch profile with a speed cap (`maxSpeedFractionC`).                                                                                                                                                                                                        | Exotic credits per km/s, sold only at shipyards.                                    |
| 5 jump drive              | Charge for `jumpChargeHours`, then a straight-line FTL jump.                                                                                                                                                                                                 | Flat exotic cost per jump, shipyards only.                                          |

- **Surface sites** add ascent and descent Δv of 1.2 × circular speed and 6-hour hold legs.
- **Same-body hops** (orbit ↔ surface, station ↔ station) are a 12-hour docking hold.

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
- **The estimate cache** shifts stale estimates in time instead of re-solving, so an estimate
  can differ from the dispatched plan (#22).

Treat these as the current spec. If you fix one, update this section and the issue.
