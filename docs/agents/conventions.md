# Code conventions

TypeScript style and patterns used throughout `src/`. Read this before writing code here.

**Source of truth:** `tsconfig.app.json`, `.oxlintrc.json`, `.oxfmtrc.json`. The patterns
below are drawn from `src/sim/**` and `src/render/**`.

## TypeScript

- **Import with the `.ts`/`.tsx` extension**: `import { vec3 } from '../math/vec3.ts'`.
  Type-only imports use `import type` (`verbatimModuleSyntax`).
- **No enums, no namespaces, no parameter properties** (`erasableSyntaxOnly`). Use string-literal
  unions (`'docked' | 'in_transit'`) and `as const` arrays (`GOOD_IDS`, then
  `type GoodId = (typeof GOOD_IDS)[number]`).
- **Discriminated unions** model variants: `Command`, `EventPayload`, `Leg`, `OrbitModel`,
  `WakeReason`. Handle them with an exhaustive `switch (x.kind | x.type)`.
- `noUncheckedIndexedAccess` is on. In hot loops over typed arrays, use `arr[k]!` when the index
  is known to be valid. Elsewhere prefer `?.` and `??`.
- Classes use **ES private fields** (`#jd`, `#heap`), not the `private` keyword. Public
  state that is read-only by intent is `readonly`.
- Prefer non-mutating array methods: `toSorted`, `toReversed`, `at(-1)`. Don't sort shared
  arrays in place.

## Naming and comments

- Units go in names when they aren't obvious: `radiusKm`, `periodDays`, `deltaVKmS`,
  `accelKmS2`, `upkeepPerDay`, `fuelTPerKmS`, `startJd`, `realDtSeconds`.
- Tunables are `SCREAMING_SNAKE` module constants at the top of the file, each with a
  one-line `/** … */` saying what it controls. Scenario-wide economy tunables live in
  `ECONOMY_CONSTANTS` (`src/sim/logistics/data/economyConstants.ts`).
- Doc comments explain **why** and the contract (units, frames, ownership, "live object, copy to
  keep"), not what the next line does. Mention a non-obvious trade-off in one sentence.
- Use readable numeric separators: `86_400`, `149_597_870.7`, `1e-9`.

## Math and allocation

- Vectors are plain `{ x, y, z }` (`Vec3` in `src/sim/math/vec3.ts`). Functions take an
  **`out` parameter** and return it: `add(out, a, b)`, `positionFromElements(el, out)`.
- Hot paths reuse **module-level scratch** objects (`const scratch = vec3()`,
  `const tmpPole = new Vector3()`) instead of allocating per call or per frame.
- Large homogeneous data uses **structure-of-arrays typed arrays** (`ParticleOrbits`:
  `Float64Array` per element).
- Precision: the sim is float64 everywhere. Convert to float32 only at the render boundary, after
  subtracting the floating origin (see [orbits.md](orbits.md)).
- Getters returning ephemeris positions return **live objects**. Copy them (`copy(out, p)`)
  if you need them past the current frame.

## Simulation code (`src/sim/**`)

- Deterministic: no `Math.random`, no `Date.now()`, no wall-clock reads in simulation logic.
  Use seeded RNGs (`createRng`, `world.rng(name)`). Pass any time source in as an option
  (`now` in `InlineOptions`). The only wall-clock reads are the orrery clock's default start
  and its "jump to now" (`SimClock`). See [economy.md](economy.md).
- Pure data in, pure data out: entity state is plain objects (structured-cloneable for the
  worker). No class instances or closures in entity state.
- Fail loudly on programmer errors (`throw new Error('Unknown body "x"')`). Handle _expected_
  failures with return values: `null` for infeasible trips, rejection events for commands.

## Errors in React

Wrap independent HUD regions in `<ErrorBoundary label="…">` so one failing panel doesn't take
down the app. Pass `resetKey` when the panel's subject changes.
