# Solar Systems

A true-to-scale, real-time model of the Solar System built with React Three Fiber — and, on top
of it, a near-future (2040) **interplanetary logistics economy** you can watch: colonies with
markets and populations, and AI transport companies flying realistic trajectories to trade.

- **Stack:** React 19 · @react-three/fiber 9 · three r187 · TypeScript 7 (native `tsc`) · Vite 8 · oxlint · oxfmt · Vitest
- **Distances and radii are to scale** (1 scene unit = 1,000,000 km). Bodies smaller than a few pixels are drawn at a minimum on-screen size, which you can turn off with "Strict true size". Distances are never exaggerated.
- **Real orbital motion:** Kepler's equation is solved for every body and every belt particle on every frame (belt particles on the GPU, in the vertex shader).

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # typecheck + lint + format check + tests
```

## Logistics simulation

- **Places:** Earth Exchange (deep market), Gateway Station, Luna Base, Mars Colony, Phobos
  Station, Ceres Colony, Vesta and Psyche mines, Callisto Outpost — all data in
  `src/sim/logistics/data/`.
- **Economy:** 14 goods, recipe-based production (chains are just recipes with inputs),
  supply/demand prices per settlement, population with survival/basic/comfort needs, housing
  growth, Earth charter funding.
- **Orders:** settlements post _delivery_ orders (carrier sources the goods) or _freight_ orders
  (goods pre-bought at the source; carrier only hauls). Unfilled orders are reposted with
  rising fees. Same-body neighbours trade directly via a local shuttle.
- **Ships:** 5 engine tiers — chemical and nuclear/ion (Lambert transfers, launch windows),
  fusion torch and antimatter (accelerate/flip/decelerate, antimatter capped below c), jump
  drive (charge, then FTL). Fuel is bought at the departure port (emergency fuel at 3× if dry).
- **Companies:** 5 AI companies with personalities (bulk hauler, arbitrageur, contract carrier,
  express courier, frontier outfitter). They pick contracts and trades by expected profit per
  day, explain every ship's job in its _intent_ line, buy ships when rich and busy, and can go
  bankrupt; new companies then enter.
- **Control seam:** every decision goes through validated commands (`src/sim/logistics/core/
  commands.ts`) and every outcome is an event. A company's `CompanyController` can be swapped
  (e.g. for a player) with `world.setController(id, controller)`.

### UI

Top bar (speed, trade volume, leader) · tabbed ledgers (companies, places, ships, orders,
bodies) · inspectors for ships, places, companies and orders with click-through links ·
activity feed · map overlays (ships, trade flows, all routes, supply status).
Click to inspect · **F** or _Follow_ to ride along · **Esc** clear · **Alt+←/→** back/forward.
In economy mode time only runs forward, up to 1 year/s.

## Controls

| Input            | Action                             |
| ---------------- | ---------------------------------- |
| Drag / scroll    | Orbit / zoom                       |
| Click body/label | Focus the body                     |
| Space            | Play / pause                       |
| `[` `]`          | Slower / faster (1 s/s to 10 yr/s) |
| `R`              | Reverse time                       |
| `N`              | Jump to now                        |

## Architecture

```
src/
  sim/      Pure TypeScript simulation. No React, no three.js (enforced by oxlint).
    orbits/   Kepler solver, orbit models (JPL approx. elements, mean elements), frames
    data/     Body catalog: Sun, planets, moons, dwarf planets, asteroids
    belts/    Statistical belt models + structure-of-arrays particle propagation
    world/    Ephemeris: hierarchical positions, orientations, orbit paths
    time/     Julian dates, SimClock (rate, pause, reverse)
    simulation.ts  Simulation = clock + ephemeris + belts
    logistics/ Economy sim: core (tick loop, scheduler, events, commands), navigation (Lambert,
               torch, jump planner), economy (markets, production, population, contracts,
               companies, stats), controllers (company view + AI brain), data (scenario)
  render/   Presentation: R3F scene, floating origin, procedural textures, label overlay,
            logistics map layers (markers, trajectories, trade flows, follow)
  ui/       DOM HUD (time controls, ledgers, inspectors, feed). Reads the sim through context.
  state/    zustand view + selection state (focus, layers, selection, follow, overlays).
  app/      Composition root
```

**Data flow:** `SimDriver` (a `useFrame` hook that runs first) calls `sim.step(dt)`, then sets the
_floating origin_ to the focused body. All scene components read float64 positions from the
ephemeris, subtract the origin, and only then convert to float32 scene space. This keeps
Phobos stable even when you are 30 AU from the Sun. The camera always orbits (0,0,0).

**Extending:** add a body by appending a `BodyDefinition` to `src/sim/data/*`, with optional
styling in `render/appearance.ts`. Add a belt by appending a `BeltDefinition` to
`sim/belts/belts.ts`. The sim can run without a browser (see `src/sim/sim.test.ts`), so it can
move into a Web Worker or onto a server unchanged.

## Accuracy notes

- **Planets & Pluto:** JPL/Standish approximate Keplerian elements with secular rates
  (1800–2050 AD, arc-minute level; less accurate outside that range). The tests check these
  against JPL Horizons positions at J2000.
- **Moons:** JPL mean elements at J2000. Most moons use their parent's equatorial frame
  (IAU poles), so Uranus's moons orbit on their side and Triton orbits retrograde. The Moon
  includes its 18.6-year nodal regression and 8.85-year apsidal precession. The phases of
  the smaller moons are approximate.
- **Dwarf planets & asteroids:** two-body propagation from osculating elements, with no
  perturbations.
- **Belts:** synthetic particles drawn from the observed element distributions: Kirkwood gaps,
  Hildas in 3:2 resonance, L4/L5 trojans, plutinos, cold and hot classical Kuiper belt,
  and the scattered disc.
- **Simplifications:** the Sun stays fixed at the origin (no barycentric wobble). Earth is
  placed at the Earth–Moon barycenter. UTC is used in place of TDB. There are no mutual
  perturbations between bodies.
