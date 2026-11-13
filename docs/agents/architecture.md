# Architecture

Layers, dependency rules and the per-frame data flow. Read this before adding a module or moving
code between layers.

**Source of truth:** `src/app/App.tsx`, `src/sim/index.ts`, `src/sim/simulation.ts`,
`src/sim/logistics/index.ts`, `src/render/index.ts`, `src/render/SimulationContext.tsx`,
`src/render/scene/SimDriver.tsx`, `.oxlintrc.json`.

## Layers

```
src/
  sim/      Pure TypeScript simulation: no React, no three.js, no DOM (lint-enforced)
    orbits/ data/ belts/ world/ time/ math/   orrery            → orbits.md
    logistics/                                 economy           → economy.md, navigation.md,
                                                                    controllers.md, threading.md
    simulation.ts   Simulation = clock + ephemeris + belts + economy backend
  render/   three.js / R3F scene, floating origin, DOM label layer  → rendering.md
  ui/       DOM HUD (panels, ledgers, inspectors, feed)             → ui.md
  state/    zustand view and selection state (UI state only)        → ui.md
  app/      Composition root: builds the Simulation and mounts everything
```

## Dependency rules

- **`src/sim` must not import** `react`, `react-dom`, `three` or `@react-three/*`. oxlint's
  `no-restricted-imports` enforces this for every file outside `render/ ui/ app/ state/` and
  `main.tsx`. The sim must keep running in Node and in a Web Worker.
- `render/` and `ui/` import the sim through its public barrels, `src/sim/index.ts` and
  `src/sim/logistics/index.ts`. Add an export there rather than deep-importing internals.
  Tests may deep-import.
- `ui/` reads the simulation through `useSimulation()` and never touches three.js objects.
  `render/` doesn't render HUD panels.
- `state/` holds **UI state only**: focus, layers, selection, overlays. Simulation state lives in
  the sim (`SimClock`, `LogisticsWorld`) and is never mirrored into zustand.
- No import cycles (`import/no-cycle` is an error). Inside the sim, a module that needs a
  helper from a module that imports it gets a small leaf module instead. For example,
  `economy/treasury.ts` is used by both `core/commands.ts` and `economy/contracts.ts`.

## One simulation object, mutable by design

`App` creates a single `Simulation` (`economy: 'worker'`, the `DEFAULT_SCENARIO`) and provides it
through `SimulationProvider`. Simulation objects are **mutable and long-lived**: the sim
updates them in place every frame. React code doesn't hold them in state. It reads them in
`useFrame` (render) or polls them at a fixed rate (UI).

`RenderFrame` (also from context) is per-frame shared render state that never triggers React
renders:

- `origin`: the floating origin (heliocentric km);
- `labels`: DOM label elements by key, positioned imperatively by scene components.

## Per-frame data flow

1. `SimDriver` (`useFrame` priority `PRIORITY_SIM = -2`, runs first) calls `sim.step(dt)`:
   clock tick → economy `advance(clock.jd)` → `ephemeris.update(clock.jd)`.
2. `SimDriver` resolves the **floating origin**, the position of the focused or followed entity,
   into `frame.origin`.
3. Scene components (`PRIORITY_SCENE = -1`) read float64 heliocentric positions, subtract the
   origin, and only then convert to float32 scene units (`relativeToScene`). The camera always
   orbits (0, 0, 0). This keeps small moons stable 30 AU from the Sun.
4. The UI polls the sim at 2–20 Hz (`usePolled`, `useTick`, `usePolledKeyed`).

## The economy and the clock

When a scenario is loaded, `Simulation.step` enforces the economy's rules on the clock:
time only runs forward, at most 1 year/s (`MAX_RATE_SECONDS_PER_SECOND`). If the economy
falls more than 2 days behind (more in worker mode, to cover message latency), the clock
waits for it (`lagDays`, `economyBehind`). The economy never reads the render clock. It
advances only to explicit target dates. See [threading.md](threading.md).

## Historical design notes

`docs/superpowers/specs/2026-11-12-logistics-sim-design.md` and
`docs/superpowers/plans/2026-11-12-logistics-sim.md` are the original design and plan for the
economy. They're background reading, **not** current truth. Where they disagree with these
docs or with the code, the code and these docs win.
