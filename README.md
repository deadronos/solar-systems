# Solar Systems

A true-to-scale, real-time model of the Solar System built with React Three Fiber.

- **Stack:** React 19 · @react-three/fiber 9 · three r187 · TypeScript 7 (native `tsc`) · Vite 8 · oxlint · oxfmt · Vitest
- **Distances and radii are to scale** (1 scene unit = 1,000,000 km). Bodies smaller than a few pixels are drawn at a minimum on-screen size, which you can turn off with "Strict true size". Distances are never exaggerated.
- **Real orbital motion:** Kepler's equation is solved for every body and every belt particle on every frame.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # typecheck + lint + format check + tests
```

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
  render/   Presentation: R3F scene, floating origin, procedural textures, label overlay
  ui/       DOM HUD (time controls, body picker, info, layers). Reads the sim through context.
  state/    zustand view state (focus, layers). Only UI state lives here.
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
