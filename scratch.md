# Next steps

Working notes on which open issues to tackle next (as of 2026-11-13). Not a design doc.

## Quick wins, in order

1. **Event log cleanup: #13 + #24 (one PR)**
   - #13: `PriceChanged` is ~35% of the log (9,855 of ~28k events in a 20-year soak). It pushes
     meaningful history out of the 10k ring buffer and floods the activity feed. Add hysteresis or
     a per-(settlement, good) minimum interval, or move price history to the stats series and keep
     only band crossings (cheap / normal / scarce).
   - #24: `EventLog` does an O(n) `shift()` per event once full, `JSON.stringify` per event just to
     hash it, and never prunes `#byEntity`. Use a circular buffer, hash fields directly, prune on
     `ShipRemoved` and contract pruning, and add a 1M-append micro-benchmark.
   - Same files (`src/sim/logistics/core/events.ts`, `markets.ts`), well specified, low risk.

2. **Earth–Moon barycenter: #18** (good first issue)
   - Earth is drawn at the EMB, ~4,670 km (0.73 Earth radii) from its true centre.
   - Treat the JPL "Earth" orbit as the EMB: offset Earth by `−μ·r_moon` and the Moon by
     `(1−μ)·r_moon`, with `μ ≈ 0.01215`. Generalise via an optional `barycentricPartner`
     (also covers Pluto–Charon).

3. **Tidally locked moons face the wrong way: #23** (bug)
   - Synchronous rotation has the right rate but an arbitrary phase, so the Moon's near side
     doesn't face Earth.
   - Derive the angle from the direction to the parent, projected onto the equator plane, against
     the same prime-meridian axis `equatorialToEcliptic` uses, and use that axis in `Body.tsx`.
   - Natural follow-on to #18 (same ephemeris and frames code).

4. **Tick-loop allocations: #26**
   - Cache sorted settlement ids, build `createCompanyView` once per tick, make
     `Ephemeris.positionAt` iterative with scratch vectors, precompute the production order.

## The big one

**Colony liquidity drain: #11**

- In a 20-year soak, colony treasuries fall from 785M to 28M and contracts posted drop from 171
  to 3 per two years. Earth is an infinite source and sink (`treasury: Infinity`), so money leaves
  the colonies and never returns. The Earth stipend (~80M/yr) is the only colony income.
- Most important for gameplay, but it's a design question about money flows, not a quick fix.
- The answer also feeds #14 (settlements investing in industry) and #15 (price formation).

## Suggested sequencing

- Fast, clean win: start with #13 + #24.
- Most impact: start a design pass on #11.
