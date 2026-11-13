# Rendering (three.js / React Three Fiber)

Scene structure and the patterns every scene component follows. Read this before changing
`src/render/**`.

**Source of truth:** `src/render/scene/*.tsx`, `src/render/logistics/*.tsx`,
`src/render/{coords,labelPlacement,textures,appearance}.ts`, `src/render/SimulationContext.tsx`.

## Scene

`SolarSystemScene` creates the `<Canvas>`:

- `logarithmicDepthBuffer`, ACES tone mapping, `dpr` from 1 to 2;
- camera near 1e-7 / far 1e8 scene units.

`SceneContents` mounts:

- `SimDriver` and `CameraRig`;
- an ambient light and the `Starfield`;
- one `Body` and one `OrbitPath` per catalog body, and one `BeltPoints` per belt;
- with an economy: `MarkerLayer`, `TrajectoryLayer` and `TradeFlowLayer`.

## Per-frame pattern (follow this exactly)

- **All per-frame work happens in `useFrame`** and mutates three.js objects through refs.
  Never call `setState` per frame, and never derive per-frame values in render.
- **Priorities:** `SimDriver` uses `PRIORITY_SIM` (−2): it steps the sim and sets the floating
  origin. Everything that reads sim positions uses `PRIORITY_SCENE` (−1). Import both from
  `scene/SimDriver.tsx`.
- **Read stores imperatively inside `useFrame`:** `useViewStore.getState()` and
  `useSelectionStore.getState()`, not hooks. A hook re-renders the component; `getState()`
  doesn't. Use hooks only for values that change the React tree (`visible={…}` on
  `Starfield`, the list of trajectories).
- **Positions:** `relativeToScene(eph.position(id), frame.origin, obj.position)`. Groups are
  placed relative to the origin. Geometry stays origin-free (local to its parent or anchor).
- **Sizes:** `pixelsPerUnit(camera, distance, size.height)` drives the minimum on-screen body
  size (`minPixelRadius`), the orbit fade-out (20 → 8 px semi-major axis), and label
  decluttering.

## Resources

- Create geometries and materials in `useMemo`. Dispose them in a `useEffect` cleanup
  (`OrbitPath`, `TrajectoryLayer`, `TradeFlowLayer`). Use `<primitive object={…}>` for objects
  you build yourself.
- Textures are **procedural** (`textures.ts`, cached per body): the app ships no binary
  assets. Styling per body lives in `appearance.ts`. Keep visual data out of the sim catalog.
- Preallocate fixed-size buffers (`SEGMENTS + 1`, `SAMPLES`, `MAX_FLOWS`). Update with
  `attr.needsUpdate = true` instead of recreating geometry.

## GPU work

- Extend stock materials with `material.onBeforeCompile` (inject attributes and uniforms with
  `#include <common>` / `<begin_vertex>` replacements). Set `customProgramCacheKey`, and
  expose uniforms via `material.userData`. Examples: `beltShader.ts` (Kepler on the GPU),
  `TrajectoryLayer` (flown/unflown dimming).
- Keep float32 values small: `BeltPoints` re-anchors its epoch so `uDt` stays short.
  Trajectories upload positions relative to an anchor sample and dim by `aTime` (days after
  departure) against `uNow`.
- If GLSL has a JS mirror (`solveKeplerFixed`), keep the two in sync. A test checks the mirror.
- Orbit lines (`OrbitPath`) are `Line2`/`LineMaterial` fat lines (1.5 CSS px; set
  `material.resolution` to the canvas size each frame). Each segment endpoint carries its
  eccentric anomaly as a fraction of a turn, and `uBodyPhase` (from
  `Ephemeris.eccentricAnomaly`) makes the line brightest just behind the body. Rebuilds write
  the interleaved `instanceStart` buffer in place.

## DOM labels and markers

Body labels (`LabelOverlay`), settlement and ship markers (`LogisticsOverlay`) are DOM buttons
in one absolutely positioned layer:

- React renders them once and registers each element in `frame.labels` under a key: the body
  id, `settlementLabelKey(id)` or `shipLabelKey(id)`.
- Scene components position them every frame with `placeLabel(el, scenePos, camera, size,
  visible, dx, dy)`, which writes `transform` and `visibility` only when needed.
- They cost no React renders.

## Camera

`CameraRig` wraps drei `OrbitControls` around (0, 0, 0). The target entity comes from
`cameraTarget(follow, selected, focusId)` (`logistics/focus.ts`). Focusing eases the distance
over 1.4 s.

## Known gaps

- One DOM marker and one `Line` per ship doesn't scale to large fleets (#27).
- Visual polish backlog (atmospheres, real stars, orbit fades) is in umbrella #9.
