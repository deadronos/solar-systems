# Threads: worker economy, replica and fallback

Where the economy runs and how the main thread sees it. Read this before changing
`src/sim/logistics/sync/*`, `Simulation.step`, or anything that reads `sim.logistics` from the UI.

**Source of truth:** `src/sim/logistics/sync/{economy,delta,spawn,economy.worker}.ts`,
`src/sim/simulation.ts`, `src/sim/logistics/sync/sync.test.ts`.

## Where work runs

| Work                                          | Where                        | Why                                            |
| --------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Economy (AI, planning, markets)               | Web Worker                   | Heavy, branchy, deterministic float64          |
| Belt particles (~30k Kepler solves per frame) | GPU vertex shader            | Independent, presentation only                 |
| Ship trajectory dimming                       | GPU (two uniforms per frame) | Uploaded once per plan                         |
| Ephemeris (~45 bodies), labels, camera        | Main thread                  | Tiny, needed on the CPU for labels and picking |

## Backends (`EconomyBackend`)

- `InlineEconomy`: the authoritative world on the calling thread, advanced within a per-frame
  budget (8 ms, at most 400 ticks). Used in tests, Node, `?economy=inline`, and as a fallback.
- `WorkerEconomy`: spawns the worker **lazily on the first `advance`** (so StrictMode
  double-construction costs nothing). It keeps a **read-only replica** world built with the
  same `createWorld(..., { controllers: false })`, so the UI has data before the first delta.
  Unmounting `SimulationProvider` or replacing its simulation disposes the old worker.
- `Simulation` falls back to inline if the worker fails **before** it delivered anything. A
  failure after start applies all queued valid deltas, sets `economyError`, and freezes the
  map clock at the last applied economy tick. The authoritative snapshot
  API currently runs independently of the worker protocol (see [economy.md](economy.md)).

## Protocol

Main → worker: `init { scenario, catalog }`, then `target { jd }` (monotonic; at most one per
frame). Worker → main: `delta` or `error`.

The worker (`createEconomyServer`, independent of the Worker API so tests can drive it):

- runs ticks toward the target in 12 ms slices;
- yields through a `MessageChannel` (not `setTimeout`, which is clamped to 4 ms);
- posts deltas at most every 50 ms while catching up, and immediately once caught up.

A `WorldDelta` carries the changed rows for ships, settlements, companies and contracts, plus
the full id order when membership or order changes (removals are implied). Ship rows contain
the changing ship fields, while a separate sequence carries trajectory plans when assigned,
replaced or cleared. Plans are fixed after dispatch and compared by reference. Other field
changes are found by comparing number-exact JSON signatures. The delta also carries new
events and stats samples, the event count and the hash state. The replica applies deltas from
the first in order and ingests events without notifying listeners.

Run `pnpm bench:payload` to measure median component sizes across seven one-day deltas after
a warmup. The script uses Node V8 serialization as a proxy for structured-clone payload size.

| Scenario                                    | Ships | Total bytes before | Total bytes after | Plan bytes before | Plan bytes after |
| ------------------------------------------- | ----: | -----------------: | ----------------: | ----------------: | ---------------: |
| After 20 years                              |   125 |            159,670 |           126,132 |            37,780 |            1,481 |
| After 30 days with a requested fleet of 300 |   304 |            194,609 |           156,448 |            46,702 |            2,411 |

Plan sizes are measured separately from the ship fields on both versions, so the before
column includes an estimate of the bytes taken by plans embedded in ship records.

## Rules for code that reads the economy

- Treat `sim.logistics` as **read-only** in render and UI code. In worker mode it's a replica
  that is overwritten every delta.
- An entity's object is replaced when its fields change and kept otherwise. Replica ships
  reuse their plan objects across counter updates. Inline objects are mutated in place, so
  render code can continue keying trajectories by value using `planKey(plan)`. Polled UI uses
  string keys (`usePolledKeyed`).
- The replica lags the clock by a few frames (~0.25 s of simulated time). Code that positions
  ships handles a clock ahead of the economy (`shipAnchorBody` treats a ship past its
  `arriveJd` as already docked).
- Don't subscribe to replica events for logic. `ingest` doesn't fire listeners. Poll
  `events.recent()` instead.
- Anything new in world state must be plain structured-cloneable data, or it won't reach the
  replica.

## Parity guarantee

The inline and worker economies produce the same economy tick for tick: same tables, same event
hash. `sync/sync.test.ts` checks this with a fake in-process port that `structuredClone`s
every message. Keep it passing for any change to world state or deltas.
