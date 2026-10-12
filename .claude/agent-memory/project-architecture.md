---
name: Project architecture
description: Key file roles, class layout, test mock patterns, and how eager module imports work
type: project
---

## Key Source Files

- `src/bun-test-runner.ts` — `BunTestRunner` class (implements Stryker TestRunner). Injects `commonTokens.logger` and `commonTokens.options`. Stores `options.mutate` as `mutateGlobs`. In `init()`, resolves eager modules via `resolveEagerModulesFromGlobs(mutateGlobs)` (cached as `cachedEagerModules`) and passes them to `generatePreloadScript`.
- `src/coverage/preload-generator.ts` — `generatePreloadScript` reads `src/templates/coverage-preload.ts`, replaces `__PRELOAD_LOGIC_PATH__` and `__EAGER_MODULES_FILE__` placeholders, writes to `$TMPDIR/stryker-bun-runner/stryker-coverage-preload-$PID.ts` and the eager module list (JSON array) beside it at `eagerModulesFileFor(preloadPath)` (`...-$PID.eager-modules.json`, only when non-empty). Also exports `resolveEagerModulesFromGlobs` which uses `tinyglobby` to resolve `StrykerOptions.mutate` glob patterns to sorted absolute paths.
- `src/templates/coverage-preload.ts` — Bun preload template. Key placeholders: `__PRELOAD_LOGIC_PATH__` (import path), `__EAGER_MODULES_FILE__` (JSON string path of the eager module list, or null). The eager-import block (Section 3) reads the list (`readEagerModules`) and imports it only inside `if(shouldCollectCoverage)`, so mutant runs never parse it, after `setActiveMutant`, before `beforeEach` registration.
- `src/coverage/preload-logic.ts` — The real preload logic module (imported by the generated preload script at runtime).

## Eager Module Import Pattern (bistable coverage fix)

**Why:** Module-level top-level code runs when a module is first imported. With multiple workers doing work-stealing, which test imports source module M first is nondeterministic. Without eager imports, module-level mutants land in `perTest[firstTestThatImports]` — nondeterministic, causing bistable coverage maps across runs and breaking Stryker's incremental cache.

**Fix:** In the preload script (before any tests run, while `strykerGlobal.currentTestId` is undefined), `await import(modPath)` each source module listed in the eager module list file. Module-level code then records to the `static` bucket deterministically.

**Source of truth:** `StrykerOptions.mutate` — exactly what Stryker instruments. Resolved via `tinyglobby.glob()` with `!`-prefixed negation patterns passed to `ignore`. Mutation-range suffixes (`:1:3-2:5`) are stripped before globbing.

**Guard:** The eager-import block is wrapped in `if(shouldCollectCoverage)` — skipped during mutantRun (where shouldCollectCoverage is false), so mutant runs don't pay the startup cost.

## Test Mock Patterns

- `tests/test-preload.ts` — Preload file that mocks `node:fs/promises`, `net`, `node:child_process`, `src/utils/port.js`. Must be configured via `bunfig.toml` preload.
- `tests/unit/bun-test-runner.test.ts` — Spies on all I/O: `runBunTests`, `generatePreloadScript`, `cleanupPreloadScript`, `generateSanitizedBunfig`, `discoverTestFiles`, **`resolveEagerModulesFromGlobs`** (mocked to return `[]` by default to avoid real filesystem I/O).
- `tests/unit/preload-generator.test.ts` — Mocks `fs/promises`. Tests for `resolveEagerModulesFromGlobs` use real temp directories (not mocked) because tinyglobby does its own fs access.

## Dependencies

- `tinyglobby` (direct dep, v0.2.16) — used in `resolveEagerModulesFromGlobs` for glob expansion with negation support.
- `smol-toml` — TOML parsing for bunfig sanitizer.
- `@stryker-mutator/api` — Stryker types, DI tokens.
