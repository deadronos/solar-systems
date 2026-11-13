# Orbits, ephemeris, units and frames

The orrery layer: how body positions are computed, the units and frames involved, and how to add
bodies or belts. Read this before touching `src/sim/{orbits,data,belts,world,time,math}` or any
code that converts positions for rendering.

**Source of truth:** `src/sim/orbits/{kepler,models,frames}.ts`, `src/sim/world/ephemeris.ts`,
`src/sim/data/*.ts`, `src/sim/belts/*.ts`, `src/sim/time/*.ts`, `src/sim/constants.ts`,
`src/render/coords.ts`.

## Units and frames

| Quantity | Unit / frame                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Position | km, **heliocentric, J2000 ecliptic** (z = ecliptic north)                                            |
| Velocity | km/s (`helioStateAt`, Lambert); per-day rates inside orbit models                                    |
| Time     | **Julian date** (`jd`, days, float64). `J2000 = 2451545.0`. UTC stands in for TDB.                   |
| Angles   | Radians in code. Data files and model inputs are degrees (`iDeg`, `OmegaDeg`), converted with `DEG`. |
| Scene    | 1 unit = 1,000,000 km (`UNITS_PER_KM`); three.js is y-up: ecliptic (x, y, z) → scene (x, z, −y)      |

Always convert through `src/render/coords.ts` (`relativeToScene`, `eclipticToScene`,
`eclipticDirToScene`). Never hand-roll the axis swap.

**Precision rule:** compute in float64 heliocentric km, subtract the floating origin (still
float64), then scale to float32 scene units. GPU code receives only small, origin- or
epoch-relative values (see `BeltPoints` epoch rebasing and `TrajectoryLayer` anchors in
[rendering.md](rendering.md)).

## Orbit models (`OrbitModel`)

- `jplApprox`: Standish "Keplerian Elements for Approximate Positions of the Major Planets",
  Table 1 (valid **1800–2050**), with secular rates per Julian century. Used for the planets and Pluto.
  The economy runs past 2050, which is a known gap (#17).
- `meanElements`: elements at an epoch with uniform mean motion and optional nodal or apsidal
  precession (deg/day). Used for moons (JPL mean elements; the Moon has its 18.6-yr nodal and
  8.85-yr apsidal rates) and for small bodies via `heliocentric({ aAU, … })`, which derives the
  period from Kepler's third law.
- `elementsAt(model, jd)` gives osculating `KeplerElements`. `elementRates(model)` gives their
  time derivatives, which `Ephemeris.helioStateAt` uses for exact analytic velocities.
- `solveKepler` is Newton–Raphson, valid for all e < 1. There are no hyperbolic orbits in the
  catalog; `navigation/kepler2.ts` handles universal-variable propagation for ship arcs.

## Ephemeris

- `new Ephemeris(catalog)` sorts bodies topologically (parents first). `update(jd)` fills every
  body's `position` (heliocentric) and `local` (relative to parent) **in place**.
  `position(id)` returns that live object, so copy it if you need it later.
- Moons with `orbitFrame: 'parentEquator'` are rotated into the ecliptic by the parent's
  equator frame, which is built from its IAU pole (`poleToEcliptic`, `equatorialToEcliptic`).
  That's why Uranus's moons orbit on their side and Triton orbits retrograde.
- `positionAt(id, jd, out)` evaluates at an arbitrary date **without** touching cached state.
  The economy and planner use it, never `position()`, so the economy doesn't depend on the
  render clock.
- `orientation(id)` gives the pole plus prime-meridian angle. `rotation: 'synchronous'` uses
  the parent's pole and the orbital period. The meridian _phase_ is currently arbitrary (#23).

## Catalog data (`BodyDefinition`)

Add a body by appending to `PLANETS`/`SUN` (`data/planets.ts`), `MINOR_BODIES` (use
`heliocentric({...})`) or `MOONS` (use the local `moon({ el: [a, e, i, ω, Ω, M0, period] })`
helper: frame `parentEquator`, synchronous rotation by default). Optional styling goes in
`src/render/appearance.ts`; the sim catalog holds physical data only. `gm` (km³/s²) is
the single source of gravity for the trip planner. Every body a settlement sits on, and its
planet, must have one; `data/data.test.ts` checks this. A body without `gm` counts as
massless.

## Belts

`BeltDefinition { id, count, seed, sample(orbits, k, rng) }` in `belts/belts.ts`.
`sample` fills particle `k` from statistical element distributions (Kirkwood gaps, Hildas,
trojans, Kuiper belt, scattered disc). `ParticleOrbits` stores structure-of-arrays elements plus
precomputed P/Q basis vectors, so a position is `P·(cos E − e) + Q·sin E`. The renderer solves
Kepler on the GPU; `propagate()` is the CPU equivalent, used in tests. Belts are presentation
only. The economy never reads them.

## Known simplifications (documented, not drift)

The Sun is fixed at the origin; there are no mutual perturbations; small bodies follow
two-body motion; UTC is used in place of TDB. Earth is placed at the Earth–Moon barycenter (#18).
The full list for users is in the README's "Accuracy notes".
