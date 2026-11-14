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
  failure after start sets `economyError` and stops the economy. The authoritative snapshot
  API currently runs independently of the worker protocol (see [economy.md](economy.md)).

## Protocol

Main → worker: `init { scenario, catalog }`, then `target { jd }` (monotonic; at most one per
frame). Worker → main: `delta` or `error`.

The worker (`createEconomyServer`, independent of the Worker API so tests can drive it):

- runs ticks toward the target in 12 ms slices;
- yields through a `MessageChannel` (not `setTimeout`, which is clamped to 4 ms);
- posts deltas at most every 50 ms while catching up, and immediately once caught up.

A `WorldDelta` carries, per entity table (ships, settlements, companies, contracts), only the
entities that **changed** since the last delta, plus the full id order when membership or
order changed (removals are implied). Then come the events and stats samples appended since
the last delta, the event count and the hash state. The writer finds changes by comparing a
JSON signature of each entity with the one it last sent (non-finite numbers are kept apart),
so the sim needs no dirty marking. `applyDelta` sets the changed entities, rebuilds the map
order when ids are given, and ingests the events without notifying listeners. Deltas must be
applied in order, from the first; several queued in one frame are all applied (each is small).

Measured after 20 simulated years (77 ships, 300 contracts): a one-day delta fell from 210 KB
to 121 KB and an 18-day one from 354 KB to 274 KB. Ships still change on every tick (their
`stats` and `busyDays`), so they are always resent. Settlements, companies and contracts mostly
are not. Diffing costs the worker about 0.6 ms per delta.

## Rules for code that reads the economy

- Treat `sim.logistics` as **read-only** in render and UI code. In worker mode it's a replica
  that is overwritten every delta.
- **An entity's object is replaced when any of its fields changes**, and kept otherwise. A
  ship is replaced on nearly every delta (its stats tick), along with its `plan`, so key plans
  by value: `TrajectoryLayer` uses `planKey(plan)`. Polled UI uses string keys
  (`usePolledKeyed`). In inline mode objects are mutated in place, so identity says nothing
  there either.
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
