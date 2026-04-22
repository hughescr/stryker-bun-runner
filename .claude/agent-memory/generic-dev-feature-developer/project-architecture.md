---
name: Project architecture
description: Key file roles, BunTestRunner class layout, dryRun/mutantRun data flow
type: project
---

## Key files

- `src/bun-test-runner.ts` — main `BunTestRunner` class; `buildTestNamePattern` and `discoverTestFiles` moved to `src/utils/`
- `src/process-runner.ts` — `runBunTests()` helper; already supports `testNamePattern`
- `src/parsers/console-parser.ts` — `parseBunTestOutput()` — parses Bun stdout for test results
- `src/inspector/types.ts` — `TestInfo` interface (requires `type: 'describe' | 'test'` field)
- `src/coverage/coverage-mapper.ts` — imports `buildUniqueTestName` from bun-test-runner

## BunTestRunner instance fields

- `cachedTestNames: Set<string>` — populated in `dryRun`, holds all registry IDs
- `baseNameIndex: Map<string, string[]>` — populated in `dryRun`; maps un-suffixed base name → all suffixed IDs; also has identity entries for already-suffixed names
- `cachedTestFiles: string[] | undefined` — pre-warmed in `init()` via `discoverTestFiles()`; passed as `testFiles` positional args to `runBunTests` in both dryRun and mutantRun
- `lastRegistryTmpPath?: string` — cached at write time in `dryRun()` (after `writeFile` succeeds); used by `dispose()` for unlink. If dryRun never ran, `dispose()` skips the unlink entirely.
- `preloadScriptPath`, `coverageFilePath` — paths to temp files

## Deterministic test-file ordering (Fix 6 — Apr 2026)

`discoverTestFiles(cwd, logger?)` — in `src/utils/test-file-discovery.ts`, re-exported via `src/utils/index.ts`. Walks `cwd` recursively (sorted readdir at each level), skipping `node_modules/.stryker-tmp/dist/build/.git`, matching `*.test.{ts,tsx,js,jsx,mts}` and `*.spec.*`. Returns sorted relative paths or `undefined` when nothing found (triggers Bun fallback). Pre-warmed in `init()` into `cachedTestFiles`. Contains local `hasExcludedAncestor(path)` helper used for symlink ancestor checks. Tests in `tests/unit/test-file-discovery.test.ts`.

`buildTestNamePattern(testFilter)` — in `src/utils/test-name-pattern.ts`, re-exported via `src/utils/index.ts`. Tests in `tests/unit/test-name-pattern.test.ts`.

**Import pattern**: `bun-test-runner.ts` uses `import * as fsPromises from 'node:fs/promises'` and calls `fsPromises.readdir/readFile/writeFile/mkdir` so tests can spy via `spyOn(fsPromises, ...)`.

## dryRun → mutantRun flow

1. `dryRun` calls `runBunTests` with `onInspectorReady` callback + inspector client
2. Inspector collects `TestInfo[]` with `getTests()` and `getExecutionOrder()`
3. `buildTestsFromInspector` deduplicates names by appending ` [N]` suffix
4. After sort, `cachedTestNames` and `baseNameIndex` are built from the final `tests[]`
5. **dryRun also writes registry to `$TMPDIR/stryker-bun-runner/dryrun-registry.json`** (version 1 JSON with `cachedTestNames` array and `baseNameIndex` entries array)
6. `mutantRun` calls `runBunTests` without inspector; uses `parseBunTestOutput` for failed names
7. If `cachedTestNames` is unset AND `testFilter` is empty (static-coverage mutant), `mutantRun` lazy-loads registry from file via `loadRegistryFile()`; caches into instance fields; subsequent calls skip the read
8. Resolver: exact match → pass-through; base-name match → expand; unknown → warn + include as-is
9. If `killedBy` set is empty after resolution → `logger.warn` + push `'unknown'`

## Registry file format

```json
{ "version": 1, "writtenAt": <ms>, "cachedTestNames": ["file > name [N]", ...], "baseNameIndex": [["base", ["file > name [0]", "file > name [1]"]], ...] }
```
Path: `path.join(tmpdir(), 'stryker-bun-runner', 'dryrun-registry.json')` — single well-known path, latest-write-wins safe because dryRun completes before any mutantRun starts.

## Coverage preload — per-file counter fix (Apr 2026)

**Root cause of 8/25-test nondeterminism:** The preload used a module-level `testFilePrefix` captured at init time from `Bun.main`, and a **global** `createTestCounter()` that incremented across all files. When Bun runs multiple test files sequentially in one worker, the prefix was fixed to the first file, so all N test IDs were like `firstFile@@test-1`…`firstFile@@test-N`. The mapper then looked up position N in firstFile's inspector list (only 8 tests) → dropped the rest.

**Key Bun behavior verified:** `Bun.main` IS updated per-test-file in `beforeEach` callbacks (even from the preload). The preload module is initialized once with the first file's path, but `Bun.main` dynamically reflects the currently-executing test file at `beforeEach` call time.

**Fix applied:** Replaced module-level `testFilePrefix` + global `createTestCounter()` with a `perFileCounters = new Map<string, number>()`. In `beforeEach`, reads `Bun.main` dynamically, extracts file prefix, increments the per-file counter. This ensures `tests/bar.test.ts@@test-1` maps to bar's first test regardless of execution order.

**Key facts about `expect.getState()` in Bun:** Does NOT exist. `jest.getState()` also does not exist. Error stacks from `new Error()` in `beforeEach` do not contain test names. `bun:test` ESM namespace exports are read-only (cannot be wrapped). `require('bun:test')` gives a mutable object but mutations don't affect ESM live bindings.

## `bun run lint` status

The `eslint n/no-unsupported-features/node-builtins` plugin error is **pre-existing** on the base branch — not caused by any edits. `bun run typecheck` and `bun test` are the reliable quality gates.

Per-file lint (`bunx eslint --no-cache <files>`) does work and reveals real issues. Known pre-existing warnings in test files: `unicorn/import-style` for `node:path` named imports, `import-x/order` for `node:*` before `bun:test`, `@typescript-eslint/no-confusing-void-expression` on `await expect(...).rejects/resolves` lines.

## Bunfig sanitizer (Fix 5)

- `src/utils/bunfig-sanitizer.ts` — `generateSanitizedBunfig(projectCwd, tmpDir)` + `cleanupSanitizedBunfig(filePath)`
- Wired into `BunTestRunner.init()` (stores `sanitizedBunfigPath`) and `dispose()` (cleanup)
- `dryRun()` and `mutantRun()` both pass `bunfigPath: this.sanitizedBunfigPath` to `runBunTests`
- `process-runner.ts`: `noCoverage` field removed; `bunfigPath?: string` added; emits `--config <path>` before `--preload`
- After Fix 5: non-zero exit + no parsed failures → `Killed` with `killedBy: ['unknown']` (not `Survived` — the old threshold-miss workaround is gone)
