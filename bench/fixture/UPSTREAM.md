# Benchmark fixture: remeda (vendored)

| | |
| --- | --- |
| Upstream | https://github.com/remeda/remeda (monorepo; the library is `packages/remeda`) |
| Commit | `8e6e78f6eaf66eaf0b4797d72cc3691823c91335` (2026-10-04, "fix: handle missing values differently than optional ones (#1456)"; package version 2.0.0) |
| Licence | MIT, Copyright (c) 2018 remeda (`LICENSE`, copied from the repo root) |

Vendored files: `packages/remeda/src/` (runtime sources and `*.test.ts`), `packages/remeda/tsconfig.json`
(unchanged; Bun uses its `paths` entry to map `import … from "remeda"` to `src/index.ts`), and the two
helpers in `packages/remeda/test/` that the vendored tests import (`lazyInvocationCounter.ts`,
`typesDataProvider.ts`, both unchanged).

Added (not upstream): `package.json`, `stryker.conf.mjs`, this file.

The fixture has **no dependencies**. The tests import from `"vitest"`, which `bun test` maps to
`bun:test` itself; `type-fest` and `@types/node` are only needed for type checking, which nothing here
does. With nothing to install there is no `bun.lock`: `bun install` deletes an empty lockfile. There is no
`bunfig.toml`, so Bun's defaults apply (Bun does not read the repo root's `bunfig.toml` from here).

## Running

```sh
bun install && bun run build                         # at the repo root: builds dist/ (the plugin)
cd bench/fixture && bun test                         # 2085 pass, 1 skip, 1 todo, 165 files, about 0.35 s
../../node_modules/.bin/stryker run                  # from bench/fixture; writes reports/mutation/mutation.json
```

Or use `bun run bench` from the repo root (see `bench/README.md`). `BENCH_PLUGIN` overrides the plugin path.

## Why remeda

Measured on this machine (4 CPUs, Bun 1.4.2, Stryker 10.0.0, concurrency 4, perTest, no checker, no
incremental). Each runner spawn costs about 50–120 ms per mutant per worker, so 500–1500 mutants finish in
15–25 s, short of the 60–180 s the brief asked for. The orchestrator chose a larger library with many test
files instead, and accepted a run of about 30 s.

| candidate @ commit | src / test files | bun test | mutants | full run | notes |
| --- | --- | --- | ---: | ---: | --- |
| ts-pattern @ `a3fce98` | 18 / 48 | 453 pass, unmodified | 719 | 14 s | Mostly type-level code; too small |
| superstruct @ `e414c8a` | 8 / 7 | 225 pass (deps installed) | 781 | 23 s | Killed 630, Survived 131, NoCoverage 19, Timeout 1. Only 7 test files |
| neverthrow @ `5ef3a01` | 5 / 2 | 1 failure, needs `testdouble` | — | — | Only 2 test files |
| fast-equals @ `39bb9e2` | 5 / 4 | 2 failures, needs react/lodash | — | — | Only 4 test files |
| colord @ `1404cfe` | 41 / 4 | Fails to load (`export { Plugin }` type re-export) | — | — | Only 4 test files |
| **remeda @ `8e6e78f`** | 226 / 165 | 2085 pass after the edits below | 1766 | about 29 s | Pure TypeScript with no runtime deps, one colocated test file per function, every mutant got the same status in all 15 runs of the final config (a 10-run batch, then the 5 baseline runs) |

remeda gives one small test file per function, so perTest coverage narrows each mutant to a single file.
That is the targeting the runner optimises. 112 static mutants also exercise full-suite runs.

Final status breakdown: Killed 1604, Survived 146, Timeout 16 (all from the hit limit), NoCoverage 0. See
`bench/BASELINE.md` for the baseline timings.

## Modifications to upstream

### Upstream files not vendored

- `*.test-d.ts` (type-only tests, run by vitest's typechecker) and `*.test-prop.ts` (property tests that
  need `@fast-check/vitest`), plus `test/` helpers that only those use.
- **Real-timer tests** (they wait on `setTimeout`/`test/sleep.ts`, which is slow and timing-dependent):
  `debounce.test.ts`, `funnel.test.ts`, `funnel.lodash-debounce.test.ts`,
  `funnel.lodash-debounce-with-cached-value.test.ts`, `funnel.lodash-throttle.test.ts`,
  `funnel.lodash-throttle-with-cached-value.test.ts`, `funnel.remeda-debounce.test.ts`,
  `funnel.reference-batch.test.ts`. Under bun, 7 tests in the throttle, debounce and reference-batch files failed. The sources
  `src/debounce.ts` and `src/funnel.ts` are vendored but excluded from `mutate`.
- `randomBigInt.test.ts`: 18.5 M hit-counter increments per run made it take about 1 s per run when
  instrumented. Every static mutant runs the whole suite, so this one file doubled the benchmark (65 s
  against about 35 s). Its mutants also gave 10 wall-clock (not hit-limit) Timeouts. `src/randomBigInt.ts`
  is excluded from `mutate`.

### Edits to vendored test files (made so they pass under `bun test`)

| file | failure under bun | edit |
| --- | --- | --- |
| `src/tap.test.ts` (2 sites), `src/omitBy.test.ts`, `src/pickBy.test.ts`, `src/internal/withPrecision.test.ts` | `toHaveBeenCalledExactlyOnceWith` is not a bun matcher | Replaced with `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(<same args>)` |
| `src/range.test.ts` (10 sites) | `test.fails` is not a function | `test.fails(` → `test.failing(` (bun's equivalent) |
| `src/conditional.test.ts` | Bun's `toThrowErrorMatchingInlineSnapshot` serialises the error differently (`"msg"` against `[Error: msg]`) | `.toThrowError(/^conditional: data failed for all cases$/u)` |
| `src/isObjectType.test.ts` | Bun's inline-snapshot printer indents a `Set` inside an array differently | That one test changed to `test.skip` |

`randomBigInt.test.ts`'s `vi.stubGlobal` failure is moot because the file is not vendored.

### Excluded from `mutate` for determinism

`src/internal/binarySearchCutoffIndex.ts`, `src/internal/heap.ts`, `src/isDeepEqual.ts`, `src/pipe.ts`,
`src/stringToPath.ts`, `src/times.ts` (334 mutants). Each had hit-limit Timeout mutants covered by more
than one test file, or static mutants, which run every file. Four of these mutants flipped between
Killed and Timeout across three identical runs (binarySearchCutoffIndex #513/#514/#516, pipe #1435).

Cause: the runner orders a mutant's test files by their dry-run wall-clock duration
(`orderCheapestFirst` in `src/bun-test-runner.ts`), and bun bails on the first failure. Durations vary
between runs, so the file order varies too. For a looping mutant, whether a failing test or the hit
limit comes first then depends on that order. The remaining Timeouts (16, all hit-limit) are each
covered by a single test file and none is static, so the order cannot change them.

`src/randomInteger.ts`, `src/randomString.ts`, `src/sample.ts`, `src/shuffle.ts` (64 mutants) are
excluded because they call `Math.random`, so whether a test kills a mutant, and how many hits count
towards the hit limit, depends on the random draws. Evidence: across about 32 baseline-attempt runs,
`src/shuffle.ts:41` ArithmeticOperator (id 1398) was Killed 15 times in 16 and Survived once, and about
2 statuses flapped in total. The hit-limit Timeouts in `sample.ts`, `shuffle.ts` and `randomString.ts`
were random-dependent too. These, with `randomBigInt.ts` (already excluded), are the only sources that
use `Math.random` or `crypto`. Nothing else imports them except `src/index.ts`. Their tests still run,
unmodified and unseeded; seeding would change what the upstream tests mean. They also cover
`difference`, `unique` and `times`, whose mutants have deterministic killers in their own test files.
After this exclusion, a 10-run batch and the 5 baseline runs all agreed for every mutant.

Also excluded, as upstream's coverage config does: `src/index.ts` (re-exports only) and
`src/internal/types/**` (type-only).
