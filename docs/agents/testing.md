# Testing

How tests are organised and which patterns to reuse. Read this before adding or changing tests.

**Source of truth:** `vite.config.ts` (`test` block), `src/**/*.test.ts(x)`. Key files:
`src/sim/logistics/soak.test.ts`, `src/sim/logistics/sync/sync.test.ts`, `src/sim/sim.test.ts`.

## Basics

- Vitest, `environment: 'node'`, colocated `*.test.ts` next to the code (one per area:
  `core/core.test.ts`, `economy/contracts.test.ts`…). There's no DOM. React components are
  tested with `renderToString` (`ui/logistics/inspectors/inspectors.test.tsx`).
- `pnpm test` runs everything in about 10 s. A three.js CJS deprecation warning in the output
  is expected noise.
- Slow tests (multi-year runs) declare an explicit timeout: `it('…', { timeout: 180_000 }, …)`.

## Building worlds in tests

- Build an economy with `createWorld(scenario, new Ephemeris(DEFAULT_CATALOG), options)` and
  advance it with `world.advanceTo(START_JD + days)`. It runs headless, with no `Simulation`.
- `controllers: true` installs AI brains. Leave it off for economy-only tests and drive the
  world with `world.issue(companyId, commands)` instead.
- Tests define small **local factories** that override defaults with a `Partial`:
  `colony(over)` → `SettlementDef`, `scenario(settlements, companies)` → `ScenarioConfig`
  spreading `DEFAULT_SCENARIO`. Copy this pattern rather than building scenarios by hand.
- Use `minimalScenario(seed)` (`core/world.ts`) for core tests with no places or companies.
- Mutate state directly to set up a case (`settlement.market.food.stock = 0`, `ship.cargo.food = qty`).

## Asserting

- Assert on **events**, not just state: `world.events.recent(n, filter)`, `forEntity(id, n)`.
  For an event that may fall out of the ring (busy runs), subscribe before advancing:
  `world.events.subscribe((e) => …)`.
- For command rejections, collect `CommandRejected` reasons. Issue unrelated invalid commands
  in **separate** `issue` calls, because a ship's later commands in one batch are skipped after
  a rejection (see [controllers.md](controllers.md)).
- Money: compare with `toBeCloseTo(x, 3)`, never exact equality.
- When several orders or contracts can exist at once, assert on deltas or sums, not on "the
  only contract".

## Guard-rail tests (keep them green, extend them)

| Test                              | Guards                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `soak.test.ts` → determinism      | Two runs from one seed give an identical `events.hash()`.                                                                                                                     |
| `soak.test.ts` → 20-year soak     | Finite non-negative stock, prices within clamps, population ≥ 0, treasury ≥ 0, `committed` equals what live contracts owe, survival shortages ≤ 1 year, ≥ 3 active companies. |
| `soak.test.ts` → performance      | ≥ 1,000 economy ticks/s headless.                                                                                                                                             |
| `sync/sync.test.ts`               | The worker backend (via an in-process fake `EconomyPort` with `structuredClone`) mirrors the inline economy tick for tick; fallback and failure paths.                        |
| `sim.test.ts`                     | Kepler solver, Julian dates, ephemeris vs JPL Horizons at J2000, periodicity.                                                                                                 |
| `navigation/lambert.test.ts`      | Lambert solver against a reference implementation (`lambertReference.ts`).                                                                                                    |
| `render/scene/beltShader.test.ts` | The JS mirror of the GPU Kepler solver (`solveKeplerFixed`). Keep GLSL and JS in sync.                                                                                        |

A new **invariant** (something that must hold for any run) belongs in the 20-year soak loop.
A new mechanic gets a focused test in its area file, plus an invariant if it touches money,
stock or population.

## Changes that alter the event stream

Any change to economy behaviour changes the event log, so the determinism hash changes too.
That's expected. There are no golden hashes. Tests compare two runs or the inline and
worker backends. If the two runs disagree, you introduced nondeterminism; find it, don't
loosen the test.
