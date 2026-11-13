# Workflow and tooling

Commands, toolchain, branches, releases. Read this before running or shipping anything.

**Source of truth:** `package.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `tsconfig*.json`,
`vite.config.ts`, `scripts/release.mjs`, `.github/workflows/`, `.claude/launch.json`.

## Toolchain

| Tool       | Version               | Notes                                                                                                      |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| pnpm       | 12 (`packageManager`) | Only package manager. Don't add `npm`/`yarn` lockfiles.                                                    |
| Node       | 26                    | Runs `.ts` files directly (type stripping), handy for scratch scripts.                                     |
| TypeScript | 7 (native `tsc -b`)   | Strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums or namespaces). |
| Vite       | 8                     | Dev server and build. `VITE_BASE` sets the GitHub Pages base path.                                         |
| Vitest     | 5                     | `environment: 'node'`. Tests are `src/**/*.test.ts(x)`.                                                    |
| oxlint     | 1.x                   | `correctness` errors; `suspicious`/`perf` warn; `import/no-cycle` is an error.                             |
| oxfmt      | 0.x                   | Prettier-like: 100 columns, single quotes, trailing commas, semicolons.                                    |

## Commands

```bash
pnpm dev            # Vite dev server (the desktop preview uses port 5179, see .claude/launch.json)
pnpm check          # typecheck + lint + format:check + test — must pass before "done"
pnpm test           # vitest run (~10 s; the 20-year soak is the slow one)
pnpm vitest run src/sim/logistics/economy   # one folder or file
pnpm format         # apply oxfmt (run before committing; check fails on unformatted files)
pnpm lint:fix       # oxlint autofixes
pnpm build          # tsc -b && vite build
```

Add `?economy=inline` to the dev URL to run the economy on the main thread instead of the Web
Worker (useful when debugging with breakpoints).

## Scratch experiments

To measure the economy (soak runs, money flows), write a throwaway `.ts` script **outside the
repo**, import modules by absolute path and run it with `node script.ts`. The sim is
framework-free, so this works without Vite. Don't commit ad-hoc probes. Turn lasting checks
into tests instead (see [testing.md](testing.md)).

## Git, PRs and releases

- Branch from `main` (`feat/…`, `fix/…`, `docs/…`, `perf/…`). Never commit directly to `main`.
- Commits use Conventional Commits with a scope where it helps:
  `fix(economy): …`, `perf(economy): …`, `feat(render): …`, `test: …`, `chore(release): vX.Y.Z`.
  Put `Closes #N` in the body for issues the change fixes.
- PRs are merged with merge commits ("Merge pull request #N …").
- **CI:** only `.github/workflows/release.yml` exists. It runs on `v*` tags and runs
  `pnpm check` → build → deploy to GitHub Pages plus a GitHub Release. Nothing runs on
  push or PR yet (#28), so run `pnpm check` locally before opening or merging a PR.
- **Release:** `pnpm release [patch|minor|major]` on a clean, up-to-date `main`. It runs
  `pnpm check`, bumps the version, tags and pushes, and the tag triggers the deploy.

## Issue tracker

Work is tracked in GitHub issues under umbrella issues (`umbrella` label):
#5 economy, #6 physics, #7 performance, #8 code quality, #9 visuals. Items labelled
`explore` need a design decision before implementation. Don't pick an approach for them
without asking.
