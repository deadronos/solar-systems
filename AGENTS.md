# AGENTS.md

A true-to-scale Solar System orrery (React Three Fiber) with a deterministic interplanetary
logistics economy running in a Web Worker. Read only the docs your task needs.

## Rules

1. Run `pnpm check` (typecheck, lint, format, tests) before calling anything done.
2. `src/sim` stays framework-free (no React or three.js) and deterministic.
3. **Docs move with the code.** When you change behaviour that a `docs/agents` file describes,
   update that file in the same commit. If the code and the docs disagree, say so and ask
   which one is intended before acting; don't silently follow either. Each doc lists its
   source-of-truth files, and documented "known gaps" link to issues, so they are not drift.

## Docs (`docs/agents/`)

| When you are…                                       | Read                                           |
| --------------------------------------------------- | ---------------------------------------------- |
| Running, testing, committing or releasing           | [workflow.md](docs/agents/workflow.md)         |
| Adding a module or crossing layers                  | [architecture.md](docs/agents/architecture.md) |
| Writing any code                                    | [conventions.md](docs/agents/conventions.md)   |
| Writing or fixing tests                             | [testing.md](docs/agents/testing.md)           |
| Touching orbits, bodies, belts, units or frames     | [orbits.md](docs/agents/orbits.md)             |
| Changing markets, contracts, money or the tick loop | [economy.md](docs/agents/economy.md)           |
| Changing trip planning or ship classes              | [navigation.md](docs/agents/navigation.md)     |
| Changing company AI, commands or controllers        | [controllers.md](docs/agents/controllers.md)   |
| Changing the worker, deltas or replica              | [threading.md](docs/agents/threading.md)       |
| Changing the 3D scene or shaders                    | [rendering.md](docs/agents/rendering.md)       |
| Changing HUD panels or app state                    | [ui.md](docs/agents/ui.md)                     |
