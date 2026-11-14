# Navigation and trajectories

How ships get from A to B: engine tiers, transfer solvers, caching and trajectory plans. Read
this before changing `src/sim/logistics/navigation/*` or ship classes.

**Source of truth:** `src/sim/logistics/navigation/{planner,lambert,kepler2,plan}.ts`,
`src/sim/logistics/data/shipClasses.ts`.

## Entry points

- `estimateTrip(cls, from, to, jd, ctx, cargoT)` → `TripEstimate | null` (depart/arrive jd,
  Δv, fuel tonnes, exotic cost) with `cargoT` aboard. It is cheap, builds no legs, and AI
  scoring and contract pricing use it. Go through `world.nav.estimateCached(..., cargoT)` in
  economy code. Estimates are cached by class, route, exact request Julian date and load, in
  eighths of the class's capacity rounded up (never optimistic).
- `planTrip(..., cargoT)` → `TrajectoryPlan | null` with renderable `legs`. Only
  `PlanAndDispatch` calls it, with the ship's exact cargo.
- Both return `null` for infeasible trips (propellant over the tank for this load, from ===
  to, no Lambert solution). Callers must handle `null`; never throw for infeasibility.
- `NavContext` (`world.nav`) holds the caches: per-pair porkchop grids (rebuilt every 120
  days), immediate-departure sweeps shared by estimates and plans at the exact transfer
  start date, and estimates. Sweep and estimate caches are cleared wholesale
  past a size cap. Snapshots carry the launch grids and cached estimates. The grid
  start depends on past queries, so rebuilding it at restore time can change routes.

## Engine tiers (`ShipClass.tier`)

| Tier                      | Model                                                                                                                                                                                                                                                                                                                                                                                                                                 | Cost                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1 chemical, 2 nuclear/ion | Heliocentric **Lambert** transfers (single-rev, prograde) over a launch-window grid: 24 departures across one synodic period × 16 times of flight (0.4–2× Hohmann). Picks the cheapest window for this class and load: days × `upkeepPerDay` + propellant × `nav.planningFuelPrice`. Same-planet-system hops use a planet-centred Hohmann.                                                                                            | Rocket equation (below); the total Δv must fit the tank at this load.           |
| 3 fusion torch            | One accelerate / flip / decelerate profile toward the target's predicted position (fixed-point iteration to 60 s, at most 10). Acceleration = `thrustKN` ÷ starting mass (dry + cargo + propellant, iterated 4×), so a loaded ship is slower. A path that would pass inside `nav.torchSunKeepOutAU` (0.3 AU) of the Sun bends through one waypoint on that sphere (`sunWaypoint`). Δv = burn + the origin–target velocity difference. | Rocket equation.                                                                |
| 4 antimatter              | Torch profile with a speed cap (`maxSpeedFractionC`).                                                                                                                                                                                                                                                                                                                                                                                 | Rocket equation; the propellant costs `exoticCostPerT`, sold only at shipyards. |
| 5 jump drive              | Charge for `jumpChargeHours`, then a straight-line FTL jump.                                                                                                                                                                                                                                                                                                                                                                          | Flat exotic cost per jump, shipyards only.                                      |

- **Rocket equation (#20):** propellant = (`dryMassT` + cargo) × (e^(Δv/`exhaustVelocityKmS`)
  − 1) (`propellantT`). The reachable Δv is vₑ ln(1 + `tankT` / (dry + cargo)) (`maxDeltaV`).
  Exhaust velocities are physical for tiers 1–2 (hydrolox 4.4, NTR 9, ion 30 km/s), so
  chemical ships work Earth–Moon and Mars–Phobos or fly light. NTR and ion carry mid-range
  freight, and fusion carries interplanetary bulk.
- **Patched conics (#19):** the Lambert grid gives hyperbolic excess speeds (v∞) relative to
  each end's Sun-orbiting primary. Departure and capture burns start from the settlement's
  parking orbit: √(v∞² + 2μ/r) − √(μ/r) (`oberthDv`, `NavContext.wellDv`). Orbit sites park
  at their `parkingOrbitKm`, else low orbit (`nav.lowOrbitFactor` × radius). Surface sites
  always park in low orbit. From LEO, an Earth–Mars Hohmann v∞ of 2.95 km/s costs ≈ 3.6 km/s,
  and fast departures cost less than their v∞.
- **Moons** depart and capture through their planet's well: the Oberth formula at the moon's
  orbital radius turns the planet-relative v∞ into a moon-relative one (`excessAt`), then
  the moon's own well applies. Callisto's 8.2 km/s orbit around Jupiter makes it cheaper to
  leave than v∞ alone. Local hops in one planet system turn Hohmann burns at a moon the same way.
- **Low-thrust ships** (`ShipClass.lowThrust`, the ion clipper) spiral instead: each well
  level costs its circular speed plus v∞ (`spiralDv`, Edelbaum), and a transfer between two
  circular orbits costs |Δ circular speed|. Leaving LEO costs an ion ship ≈ 7.7 km/s more.
- **Surface sites** add ascent and descent Δv between the surface and low orbit of
  `nav.surfaceDvFactor` × circular speed and hold legs of `nav.surfaceLegDays` (default 1.2×
  and 6 hours).
- **Aerobraking:** arrivals at a body in `nav.aerobrakeBodies` (Earth, Mars, Venus, Titan),
  whether from another planet or from a moon down to its planet, pay `nav.aerobrakeKmS`
  (0.5 km/s) instead of the capture burn and the powered descent. Ascent is always powered.
- **Same-body hops** (orbit ↔ surface, station ↔ station) are a docking hold of
  `nav.sameBodyDays` (default 12 hours), plus a Hohmann transfer (or spiral) when the two
  sites park at different radii.
- `nav.lowOrbitFactor` sets the local transfer parking radius relative to the body radius.
  `nav.planningFuelPrice` is the fuel price the window scoring assumes.

## Plans and legs

`TrajectoryPlan.legs` is an ordered list of `hold` (at a body), `conic` (state vector plus μ,
optionally around a planet), `torch` (optionally bent through `via`) and `jump` legs, each
covering `[t0, t1]` in Julian dates.
`evaluatePlan(plan, jd, eph, out)` gives the heliocentric ship position, clamped to the plan.
The renderer samples it once per plan. Plans are plain data and are mirrored to the main thread.

## Known simplifications (documented, not drift)

- **Ion** ships are flown as impulsive Lambert transfers between the planets. Their escape
  and capture spirals cost Δv but take no extra time.
- **Patched conics** assume each escape or capture burn is aligned with the best direction
  (no phasing or plane-change cost), and moon orbits are taken as circular at their
  semi-major axis.
- **Torch** trips (tiers 3–4) pay no well escape or capture: a few percent of their Δv at most.
- **Torch flights** ignore solar gravity (at most 2% of the weakest torch's thrust outside
  the keep-out sphere), and velocity matching adds Δv but no time. The detour waypoint makes
  a sharp corner rather than a curve.

Treat these as the current spec. If you fix one, update this section and the issue.
