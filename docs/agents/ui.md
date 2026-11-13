# UI (DOM HUD) and app state

The HUD panels, how they read the simulation, and the zustand stores. Read this before changing
`src/ui/**` or `src/state/**`.

**Source of truth:** `src/ui/Hud.tsx`, `src/ui/hooks.ts`, `src/ui/logistics/common.tsx`, `src/ui/logistics/format.ts`,
`src/sim/logistics/format.ts`,
`src/ui/logistics/inspectors/*.tsx`, `src/state/*.ts`, `src/index.css`.

## Layout

`Hud` lays out regions: top (`TopBar`), left, right, and bottom (`TimeControls`,
`EventFeed`, the key hint).

- **Economy mode** (`sim.logistics !== null`): `Ledgers` on the left and `Inspector` on the
  right.
- **Orrery mode:** `BodyPicker` and `InfoPanel`.
- Each independent region is wrapped in `<ErrorBoundary label="…">`. Pass `resetKey` when the
  subject changes, e.g. the inspector resets on selection change.

## Reading the simulation

The sim mutates in place every frame, so the UI **polls** instead of subscribing:

- `useClockState(clock)` covers discrete clock state (rate, paused) through
  `useSyncExternalStore`, and re-renders only on change.
- `usePolled(read, hz)` re-reads a value at a fixed rate. Wrap `read` in `useCallback`,
  because it's an effect dependency.
- `usePolledKeyed(read, key, hz)` (`render/logistics/usePolled.ts`) re-renders only when
  `key(value)` changes. Use it when the value is a fresh object each time, which is the case for
  everything coming from the worker replica (see [threading.md](threading.md)).
- `useTick(hz)` (`ui/logistics/common.tsx`) re-renders a panel at a fixed rate (default 4 Hz) so
  it can read the live world directly while rendering. Ledgers and inspectors use it.

Never write to the sim from the UI except through its public control API (`clock.setRate`,
`clock.togglePaused`, `clock.setJd`). In economy mode, the UI hides reverse time and
"Now" and caps the rate presets at `MAX_RATE_SECONDS_PER_SECOND`.

## State (zustand)

- `useViewStore`: `focusId` (the floating origin), `layers` (orbits, moon orbits, labels,
  belts, stars), `minPixelRadius`.
- `useSelectionStore`:
  - `selected` (`EntityRef { kind, id }`), with back/forward history capped at 50;
  - `follow`, `companyFilter` and map `overlays`.
- Cross-store actions live in `state/actions.ts`. For example, `focusBody` clears follow, sets
  focus and selects. Use these actions rather than poking two stores from a component.
- Stores hold UI state only. Never copy simulation entities into them; store ids.

## Entities and formatting

- `EntityLink refTo={{ kind, id }}` renders a clickable name: click selects, double-click
  selects and follows. `nameOf(world, id)` resolves any id to a display name.
- **Inspectors must tolerate missing entities.** Ships and contracts disappear, so render a
  "no longer exists" note; a test covers this.
- The HUD and AI intent text share `fmtMoney` (₡ and k/M/B) and `fmtTonnes` from
  `sim/logistics/format.ts`. The HUD also uses `ui/logistics/format.ts` for `fmtDays`,
  `fmtGood` and `describeEvent`, and `ui/format.ts` for dates, rates and presets.
  - `describeEvent` must cover every event type; the switch is exhaustive.
  - Use typographic minus `−` for negatives, as the helpers do.

## Keyboard

`TimeControls` and `TopBar` register `window` keydown handlers. Both ignore events from
`<input>`, and `TopBar` also ignores `<select>`:

- Space pauses or resumes; `[` and `]` change speed; `R` reverses and `N` jumps to now (orrery
  mode only).
- Esc clears the selection; `F` toggles follow; Alt+←/→ goes back and forward.

Update the hint text in `Hud.tsx` and the README controls table when shortcuts change.
