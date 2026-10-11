# stryker-bun-runner

A [Stryker](https://stryker-mutator.io) test runner plugin for [Bun](https://bun.sh). It runs your
`bun test` suite under Stryker's mutation testing with per-test coverage, so each mutant runs only
the tests that cover it.

[![npm version](https://img.shields.io/npm/v/@hughescr/stryker-bun-runner)](https://www.npmjs.com/package/@hughescr/stryker-bun-runner) [![LICENSE](https://img.shields.io/badge/LICENSE-Apache--2.0-blue)](LICENSE.md) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.7-f9f1e1?logo=bun)](https://bun.sh) [![Stryker](https://img.shields.io/badge/Stryker-9%20%7C%2010-e74c3c?logo=stryker)](https://stryker-mutator.io) [![Mutation testing badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fhughescr%2Fstryker-bun-runner%2Fmain)](https://dashboard.stryker-mutator.io/reports/github.com/hughescr/stryker-bun-runner/main)

- **Per-test coverage** from Bun's inspector protocol, so each mutant runs only its covering tests,
  in the covering test files only, cheapest file first.
- **Honest scoring**: a crash or a run that proves nothing is an Error, not a kill; a test file
  that a mutant stops from loading is a kill; an infinite loop is stopped by Stryker's hit limit
  and scored Timeout.
- **A strict dry run** that fails loudly rather than hand Stryker incomplete coverage.
- **Works with** Stryker's incremental mode, `testFiles`, `disableBail`, `ignoreStatic` and the
  TypeScript checker, including a helper that keeps your tests out of the type check.

## Contents

- [Quickstart](#quickstart)
- [Requirements and compatibility](#requirements-and-compatibility)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Speeding up runs](#speeding-up-runs)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Advanced topics](#advanced-topics)
- [Contributing](#contributing)
- [License](#license)

## Quickstart

**1. Install** the runner and Stryker (a peer dependency):

```bash
bun add -D @hughescr/stryker-bun-runner @stryker-mutator/core
```

Optionally, to have Stryker skip mutants that do not compile, add the TypeScript checker. Its
default mode needs TypeScript 6 or earlier (TypeScript 7's package has no JavaScript API; see
[TypeScript 7's native checker](#typescript-7s-native-checker-experimental)):

```bash
bun add -D @stryker-mutator/typescript-checker 'typescript@<7'
```

**2. Configure.** Create `stryker.conf.mjs` in your project root:

```javascript
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  // coverageAnalysis: 'perTest' is Stryker's default.
  // mutate defaults to the source files under src/ and lib/, excluding tests.
};
```

`appendPlugins` is required: Stryker only loads plugins named `@stryker-mutator/*` on its own, so
without it `testRunner: 'bun'` is never registered. `appendPlugins` adds to Stryker's default
plugins rather than replacing them.

**3. Run** it:

```bash
bunx stryker run
```

**What success looks like.** Each Stryker worker logs a start line, the dry run passes, and Stryker
prints the mutation score:

```text
INFO BunTestRunner Bun test runner started: bun 1.4.2 at bun; 1 test file(s) from auto-discovery; sanitized bunfig /tmp/stryker-bun-runner-1000-3a9a519de34952d7-0/stryker-bun-runner-bunfig-20671-1791681289690.toml; bail on
INFO DryRunExecutor Initial test run succeeded. Ran 2 tests in 0 seconds (net 3 ms, overhead 75 ms).
----------|------------------|----------|-----------|------------|----------|----------|
File      |  total | covered | # killed | # timeout | # survived | # no cov | # errors |
----------|--------|---------|----------|-----------|------------|----------|----------|
All files | 100.00 |  100.00 |        7 |         0 |          0 |        0 |        0 |
INFO BunTestRunner Mutant runs on this worker: 4 (killed 4, survived 0, timeout 0, error 0); full-suite fallbacks: 0
```

If something goes wrong instead, see [Troubleshooting](#troubleshooting).

## Requirements and compatibility

| Component | Supported | Notes |
|---|---|---|
| Bun | 1.3.7 or later | Tested with 1.3.7 (CI), 1.3.14 and 1.4.2. 1.3.7 added the inspector `TestReporter` events the runner needs ([oven-sh/bun#25986](https://github.com/oven-sh/bun/pull/25986)); older versions do not work. |
| `@stryker-mutator/core` | 9.x and 10.x | Peer dependency. Stryker's `testFiles` option needs 9.6 or later. |
| Node.js | 20 or later with Stryker 9; 22 or later with Stryker 10 | Stryker itself runs on Node; only the test processes run on Bun. |
| Operating system | Linux, macOS | |
| `@stryker-mutator/typescript-checker` (optional) | same version as `@stryker-mutator/core` | Needs `typescript` 6 or earlier, plus TypeScript 7 for the native preview. |

At startup the runner runs `<bunPath> --version` and stops with a clear error if Bun cannot be run
or is older than 1.3.7. To upgrade Bun, run `bun upgrade`.

## Configuration

Runner options go under `bun` in your Stryker config. Stryker validates them: an unknown key under
`bun`, a wrong type, or an out-of-range value stops the run with a configuration error.

| Option | Type | Default | Description |
|---|---|---|---|
| `bun.bunPath` | `string` | `'bun'` | Bun executable to run. |
| `bun.timeout` | `number` (ms, >= 0) | `10000` | Wall-clock limit for the **dry run's** `bun test` process, which gets 30 s more for the coverage handshake. Set it comfortably above your full suite's run time; the runner warns when a dry run uses more than 80% of it. Mutant runs follow Stryker's per-mutant timeout instead (see [Timeouts](#timeouts)). Not the same as Bun's per-test `[test].timeout`. |
| `bun.inspectorTimeout` | `number` (ms, >= 0) | `5000` | Bound on each step of connecting to Bun's inspector in the dry run: waiting for bun to print its inspector URL, connecting, and each inspector request. Raise it if bun is slow to start. |
| `bun.env` | `object` of strings | none | Extra environment variables for every `bun test` process (and for the startup `bun --version` check). |
| `bun.bunArgs` | `string[]` | none | Extra `bun test` flags. Some are rejected, removed or handled specially; see [bun.bunArgs](#bunbunargs). |
| `bun.testFiles` | `string[]` (non-empty) | none | The test files or directories to run, instead of auto-discovery. See [Choosing the test files](#choosing-the-test-files). |
| `bun.smol` | `boolean` | `false` | Pass Bun's `--smol` to every process: a smaller JavaScriptCore heap at some cost to speed. |
| `bun.maxChildRss` | `number` (bytes, >= 0) | none | Soft memory ceiling per `bun test` process. One that exceeds it is killed and that run scored Timeout. |
| `bun.rssCheckIntervalMs` | `number` (ms, >= 0) | `1000` | How often to check `maxChildRss`. |
| `bun.maxSpawnDepth` | integer (>= 1) | `1` | How deeply `bun test` processes may nest before the runner refuses to spawn. Raise to `2` only if your own tests drive this runner; see [recursion containment](docs/internals.md#recursion-containment). |

### Example with every option

```javascript
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  bun: {
    bunPath: 'bun',                // found on PATH; or an absolute path to a specific Bun
    timeout: 60_000,               // the dry run's limit, not a per-test timeout
    inspectorTimeout: 10_000,
    env: { NODE_ENV: 'test' },
    bunArgs: ['--randomize'],      // the dry run randomizes; mutant runs never do
    testFiles: ['tests'],          // a directory: every test file below it (omit to auto-discover)
    smol: true,
    maxChildRss: 1_500_000_000,    // about 1.5 GB per bun test process
    rssCheckIntervalMs: 1000,
    maxSpawnDepth: 1,
  },
};
```

### bun.bunArgs

The runner owns parts of the `bun test` command line (sequential execution, the per-mutant test
name pattern, the config file, the inspector, bail and the file list). So:

- **Rejected at startup with an error** (rather than silently producing wrong scores):
  `--concurrent`, `--max-concurrency`, `--parallel` and `--test-worker` (break per-test coverage
  attribution); `--shard` and `--changed` (run only part of the suite); `-t`/`--test-name-pattern`
  (the runner builds its own per mutant); `-u`/`--update-snapshots` (snapshot tests could never
  fail); `--pass-with-no-tests` (a selection that matched nothing would be scored as survived);
  `--watch` (never exits); `--coverage`, `--coverage-reporter` and `--coverage-dir` (re-enable
  Bun's own coverage); `--cwd` (moves bun out of the Stryker sandbox); `--inspect`,
  `--inspect-wait` and `--inspect-brk` (collide with the runner's inspector); `--retry` and
  `--rerun-each` (re-run tests, which only costs time and repeats test names, so a killing test
  cannot be identified).
- **Removed**: bail flags (`--bail`, `--bail=<N>`, `--bail <N>`). Mutant runs bail on the first
  failing test unless you set Stryker's `disableBail`; the dry run never bails.
- **Dry run only**: `--randomize` and `--seed` (`--seed=<N>` or `--seed <N>`). Mutant runs drop
  them so a verdict never depends on a random order.
- **Used as your bunfig**: `--config=<path>`, `--config <path>` or `-c <path>` is taken out of the
  command line and names the bunfig the runner reads and sanitizes instead of `bunfig.toml` (see
  [Your bunfig.toml](#your-bunfigtoml)). The path is resolved against the project directory (in
  Stryker's sandbox, so check that `ignorePatterns` does not leave the file out), and the file must
  exist. A `--config` or `-c` with no path is rejected.
- **Fine**: anything else, for example `--only` (only `.only` tests then count as the suite, and
  the dry run fails if none is marked), `--isolate`, `--dots` or a `--reporter`.

### Choosing the test files

The runner passes `bun test` an explicit list of files, from the first of these that is set:

1. **Stryker's `testFiles` option** (Stryker 9.6 or later). Mutant runs stay within that
   selection too. If `bun.testFiles` is also set and differs, the runner warns and uses Stryker's.
2. **`bun.testFiles`.** Entries are exact paths, absolute or relative to the project directory: a
   file, or a directory to run every test file below it. A bare name fragment is not a filter.
   Use relative paths: under Stryker an absolute path points at your original files rather than the
   sandbox copy, so the mutants would never be seen (the runner warns about this).
3. **Auto-discovery**, following `bun test`'s own rules: files named `*.test.*`, `*_test.*`,
   `*.spec.*` or `*_spec.*` with a JavaScript or TypeScript extension, skipping `node_modules`
   and dot-directories, starting at `[test].root` from your bunfig when it is set.
   `[test].pathIgnorePatterns` applies too.

Discovery searches `dist` and `build` like `bun test` does, so compiled copies of your tests run
as well; the runner warns once when it finds any. To leave them out, set `[test].root` (for
example `root = "./tests"`), add them to `[test].pathIgnorePatterns`, or use `bun.testFiles`.
Details: [Choosing the test files](docs/internals.md#choosing-the-test-files).

### Your bunfig.toml

`bun test --config` replaces your bunfig rather than adding to it, so the runner passes bun a
sanitized copy of yours:

- everything outside `[test]` is kept as it is (`[install]`, `[loader]`, `define`, `jsx*`,
  `[macros]`, `[run]`, `smol`, `logLevel`, and anything else);
- in `[test]`, only `preload`, `root`, `pathIgnorePatterns`, `timeout`, `smol`, `randomize` and
  `seed` are kept; `coverage` and `onlyFailures` are forced off; `retry` and `rerunEach` are dropped
  with a warning; every other `[test]` key is dropped (logged at debug);
- mutant runs use a copy with `randomize = false` and no `seed`;
- relative `preload` and `root` paths are anchored at the project directory.

Your `[test].preload` files run first, then the runner's own coverage preload. Details:
[the sanitized config](docs/internals.md#your-bunfigtoml-the-sanitized-config).

## How it works

1. **Startup.** Each Stryker worker checks Bun's version, validates `bun.bunArgs`, creates a
   private temporary directory, writes the coverage preload and the sanitized bunfig, and finds the
   test files.
2. **Dry run.** One `bun test` run of the whole suite, one test at a time (`--max-concurrency=1`;
   `test.concurrent` is run sequentially). The runner follows each test through Bun's inspector
   while the preload records which mutants every test executed, and how often. Before the dry run
   counts as passed, bun's summary, the inspector's events and the coverage records must agree
   exactly; any loss fails the dry run (see
   [the completeness gate](docs/internals.md#the-completeness-gate)). The test names, file timings
   and selection are saved in a registry the other workers read.
3. **Mutant runs.** A fresh `bun test` process per mutant, with the mutant switched on. It runs only
   the covering tests (`--test-name-pattern`) in only their files, cheapest file first, in a fixed
   order, and stops at the first failure unless `disableBail` is set. Stryker's hit limit stops
   infinite loops early.

### How results are scored

| What happened | Result |
|---|---|
| A test failed | **Killed** (`killedBy` names the tests) |
| A test file failed to load (bun reports a fail or error count but no failing test) | **Killed**, empty `killedBy` |
| All selected tests passed | **Survived** |
| Stryker's hit limit was exceeded, the time limit was reached, or `bun.maxChildRss` was exceeded | **Timeout** |
| The process crashed (a signal) with no failing test that could be matched to a known test, could not be started, or exited non-zero with no failing test and no fail/error count | **Error** |
| A full-suite fallback hit a time limit Stryker sized for the covering tests only | **Error** (`inconclusive timeout`) |
| The test name pattern matched no test, even after one retry with the full suite | **Error** |

Stryker shows Error as RuntimeError and leaves it out of the mutation score. The full table and
the reasoning: [How results are scored](docs/internals.md#how-results-are-scored).

### Timeouts

Stryker sizes a timeout for every mutant run from the dry-run time of the tests it will run, plus
`timeoutMS`. The runner kills the `bun test` process a little before that, at Stryker's timeout
minus the larger of 750 ms and 5% (never more than a quarter of the timeout), and reports the
Timeout itself; if Stryker's own timer fired first, it would restart the whole worker. `bun.timeout`
only bounds the dry run. To give mutant runs more time, raise Stryker's `timeoutMS` or
`timeoutFactor`. Details: [Timeouts](docs/internals.md#timeouts).

## Speeding up runs

- **Bail (the default).** Mutant runs stop at the first failing test. Stryker's `disableBail: true`
  runs every covering test to completion instead, so `killedBy` lists every test that kills the
  mutant, at a cost in time. The dry run never bails.
- **Incremental mode.** With Stryker's `incremental: true`, a run reuses the previous results
  (`reports/stryker-incremental.json` by default) and only re-tests mutants whose code or covering
  tests changed. Test ids are stable across runs, so results stay reusable. Use `--force` only when
  the cached results look wrong.
- **`concurrency`.** Stryker runs this many workers, each with one `bun test` process at a time;
  with checkers, Stryker splits it between checker and test-runner processes. More is faster until
  CPU or memory runs out: peak memory is roughly `concurrency` × the memory one run of your suite
  needs. On a memory-constrained machine, lower it first, then consider `bun.smol` and
  `bun.maxChildRss` ([memory](docs/internals.md#memory)).
- **`ignoreStatic`.** See [below](#ignorestatic-faster-but-skips-module-level-code).
- **Keep tests out of the type check** with
  [`withTestFilesExcludedFromTypeCheck`](#keep-tests-out-of-the-typescript-checker).
- **TypeScript 7's native checker**, see [below](#typescript-7s-native-checker-experimental).

### `ignoreStatic`: faster, but skips module-level code

Static mutants are in code that runs only while a file is loading (module-level constants, top-level
setup), so no single test covers them. Testing one means running the whole suite in a fresh process.
In one measured project, static mutants were 11% of all mutants but about 41% of the mutation time.

Stryker's `ignoreStatic: true` skips them. They are then never tested and not counted in your
score, so a bug a mutant there would have revealed goes unnoticed. Leave it off if module-level
behaviour matters to you; turn it on if run time matters more.

```javascript
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  ignoreStatic: true,
};
```

### Keep tests out of the TypeScript checker

`@stryker-mutator/typescript-checker` type-checks every mutant against the program of its
`tsconfigFile` (default `tsconfig.json`) and re-checks every file that imports the mutated one. If
that tsconfig includes your tests, a mutant in a widely imported module re-checks much of the test
suite too. Wrap your config in `withTestFilesExcludedFromTypeCheck` to check only the code under test:

```javascript
// @ts-check
import { withTestFilesExcludedFromTypeCheck } from '@hughescr/stryker-bun-runner';

export default await withTestFilesExcludedFromTypeCheck({
  appendPlugins: ['@hughescr/stryker-bun-runner', '@stryker-mutator/typescript-checker'],
  testRunner: 'bun',
  checkers: ['typescript'],
});
```

Each time Stryker loads the config, the helper reads your tsconfig with your project's TypeScript
(honouring `extends`, `files`, `include` and `exclude`) and writes `tsconfig.stryker-checker.json`
next to it. That file extends yours and lists everything your tsconfig covers except:

- test files, found the way this runner finds them: Bun's naming rules under `[test].root`, plus
  `bun.testFiles` and Stryker's `testFiles` patterns;
- your bunfig's `[test].preload` scripts;
- files only those import, such as test helpers, unless a `mutate` pattern covers them or they shape
  the types of other files (a global script with no imports or exports, or a module with a
  `declare global` or `declare module "x"` augmentation).

Anything the remaining code imports still comes in through the import, so the program compiles as
before. As a safety net, the helper type-checks the new program once and compares its errors in
non-test files with the original's; if leaving the tests out adds an error (a global declared only
through a test's `/// <reference types>`, say), it warns with the first few and falls back. The
returned config has `tsconfigFile` pointing at the new file and, if you set `ignorePatterns`, a
negation for it appended so Stryker copies it into the sandbox. Add `*.stryker-checker.json` to your
`.gitignore`.

It logs one line per call: an info naming the file and how many files it excluded and kept, or a
warning with the reason it fell back. It falls back, returning your config unchanged, when
TypeScript cannot be loaded from the project, the tsconfig is missing, has errors or uses project
references, includes no test files or would be left with none, leaving the tests out adds errors, or
the file cannot be written or was not generated by the helper. With no `'typescript'` in `checkers`
it does nothing (logged at info), so list the checker in the config you wrap.

The tradeoff: a mutant that only breaks types your tests use, and that no test then fails at run
time, survives instead of counting as a compile error. On this repository, in a checker-only run
with the JavaScript checker, it cut the checkers' CPU time by about a quarter (4,445 s to 3,398 s)
and found exactly the same 1,012 compile errors.

### TypeScript 7's native checker (experimental)

`@stryker-mutator/typescript-checker` 10 can type-check mutants with TypeScript 7's native compiler.
Upstream marks this experimental: it uses TypeScript 7's unstable API, does not support project
references, and checks mutants one at a time. To opt in, install TypeScript 7 under the name the
checker loads it by, next to your existing `typescript` 6 or earlier, and set the option:

```bash
bun add -D --exact @typescript/native@npm:typescript@7.0.2
```

```javascript
// @ts-check
import { withTestFilesExcludedFromTypeCheck } from '@hughescr/stryker-bun-runner';

export default await withTestFilesExcludedFromTypeCheck({
  appendPlugins: ['@hughescr/stryker-bun-runner', '@stryker-mutator/typescript-checker'],
  testRunner: 'bun',
  checkers: ['typescript'],
  typescriptChecker: { experimentalNativePreview: true },
});
```

- The checker imports `@typescript/native/unstable/sync`. Its error message suggests a `typescript7`
  alias, but it never looks for one, so use the `@typescript/native` name above.
- Pin TypeScript 7.0.2 exactly. TypeScript 7.1 renames the `unstable/sync` entry point to `sync`,
  which checker 10.0.0 cannot load.
- Keep `typescript` 6 or earlier for everything else, including `withTestFilesExcludedFromTypeCheck`,
  which works the same with either checker. The alias installs a second `tsc` that takes over
  `node_modules/.bin/tsc`, so call TypeScript 6 by its path (`node node_modules/typescript/bin/tsc`)
  where that matters.
- Checker 10.0.0 has a bug in this mode: it writes a copy of your tsconfig with `noUnusedLocals` and
  `noUnusedParameters` turned off, but when `tsconfigFile` is a relative path (the default, and what
  `withTestFilesExcludedFromTypeCheck` sets) the native compiler never receives that copy. Mutants
  whose only effect is an unused variable or parameter then count as compile errors and never get
  tested; on this repository that was 540 of them. This repository fixes it with a one-line
  `bun patch` ([`patches/@stryker-mutator%2Ftypescript-checker@10.0.0.patch`](patches/%40stryker-mutator%252Ftypescript-checker%4010.0.0.patch))
  that you can copy into your project. If your tsconfig turns neither option on, the bug does not
  affect you.

On this repository, with the patch, a checker-only run (a no-op test runner) took 3 min 36 s and
829 s of CPU, against 14 min 10 s and 3,291 s with the JavaScript checker, and found exactly the
same 1,162 compile errors. A full `bun run mutate --force` went from 21 min 17 s to 10 min 4 s
(4,908 s to 2,283 s of CPU), still at 100%. The native compiler runs as one extra process per
checker (about 210 MB each here), yet the checkers used less memory in all: in the checker-only
runs, the six checkers and their compiler processes peaked at about 2.2 GB together, against
5.1 GB for the six JavaScript checkers.

## Troubleshooting

Run Stryker with `logLevel: 'debug'` (or `--logLevel debug`) for the full detail behind any of
these. A warning that repeats for many mutants is logged in full once per worker, then at debug,
with a summary at the end: `<kind>: <N> mutants affected (first: <ids>); see debug log for details`.
The complete list of log messages: [Log output](docs/internals.md#log-output).

### The run stops before the dry run

| Message | Cause | Fix |
|---|---|---|
| `Cannot find TestRunner plugin "bun"` (from Stryker) | The plugin was not loaded. | Add `appendPlugins: ['@hughescr/stryker-bun-runner']`. |
| `Config option "bun" must NOT have additional properties` (from Stryker) | A misspelt or unknown option under `bun`. | Check the name against the [options table](#configuration). |
| `stryker-bun-runner: could not run "<bunPath>" (<reason>). Install bun >= 1.3.7 or set bun.bunPath in your Stryker config.` | Bun is not installed, not on `PATH`, or `bun.bunPath` is wrong. | Install Bun or set `bun.bunPath`. `bun.env` can set `PATH`. |
| `stryker-bun-runner: bun <version> at "<bunPath>" is too old; version 1.3.7 or newer is required.` | Bun before 1.3.7 lacks the inspector events the runner needs. | `bun upgrade`. |
| `stryker-bun-runner: bun.bunArgs contains "<flag>", which <reason>. Remove it.` (or `contains unsupported flags`) | A flag that would corrupt the scores. | Remove it; see [bun.bunArgs](#bunbunargs). |
| `has no usable path: write --config=<path>, --config <path> or -c <path>` | A `--config`/`-c` with no file name. | Give the path. |
| `Failed to read bunfig.toml at <path>` or `Failed to read bunfig (named by --config in bun.bunArgs) at <path>` | The bunfig does not parse, or the file named by `--config` does not exist. | Fix the file or the path. |
| `stryker-bun-runner: refusing to use temporary directory <dir>: <problem>.` | The run's temp directory, or a directory above it, could be changed by another user. | Delete the directory if it is a stale run directory you trust, or set `TMPDIR` to a directory only you and root control. See [Temporary files](docs/internals.md#temporary-files). |
| `[Stryker] withTestFilesExcludedFromTypeCheck: not applied: <reason>` (warning) | The helper fell back to your own tsconfig. | Act on the reason; the run continues with the full type check. |

### The dry run fails

| Message | Cause | Fix |
|---|---|---|
| Stryker lists failing tests | Your suite fails under Stryker. A test that exceeds Bun's `[test].timeout` counts as failed. Each failure message includes the stack from Bun's inspector when Bun reports one. | Make `bun test` pass. Bun runs one test at a time here (`--max-concurrency=1`), with your bunfig sanitized; check order-dependent tests. |
| `Timeout waiting for inspector URL after <N>ms (raise bun.inspectorTimeout if bun is slow to start)` | Bun did not start in time, or exited first; the message ends with bun's last stderr. | Read that stderr (a preload that fails to resolve, say); raise `bun.inspectorTimeout` on a slow machine. |
| `Failed to connect to Bun inspector: <error>` | The inspector connection or `TestReporter.enable` did not succeed within `bun.inspectorTimeout`. | Raise `bun.inspectorTimeout` on a slow or loaded machine, and re-run. |
| `Failed to start sync server: <error>` | The runner could not open its local coordination socket on `127.0.0.1`. | Re-run; check that loopback networking is available. |
| `the dry run's sync connection to the runner` ... `before the runner signalled that it is ready to observe the tests` | The child lost its connection to the runner before the tests started. | Usually follows another error above it; re-run. |
| `Dry run timed out: bun.timeout is <N>ms` (and Stryker reports a timeout) | The dry run outgrew `bun.timeout` plus the 30 s handshake allowance. | Raise `bun.timeout` above your full suite's run time. |
| `Bun test process failed with exit code <N>` or `Bun test process terminated by signal <SIGNAL>` | Bun exited abnormally with no failing test (a missing module, a crash). The message includes stderr. | Fix what the stderr shows. |
| `stryker-bun-runner: dry run data-completeness check failed — <problems>` | The test results or coverage are incomplete or inconsistent. | Read the problems listed: a test calling `process.exit`, or a spec file that fails to load, is fixed in your suite; otherwise re-run, and report it if it recurs. See [the completeness gate](docs/internals.md#the-completeness-gate). |
| `stryker-bun-runner: the dry run produced no mutant coverage data` | The coverage preload never ran, could not write, or the process exited before its final `afterAll` (a test calls `process.exit`). An error with `coverageAnalysis: 'perTest'`, a warning with `'all'`. | Fix the cause the message names, or set `coverageAnalysis` to `'all'` or `'off'` to run without per-test coverage. |
| `refusing to spawn` ... `at nesting depth` | Your tests drive this runner, which nests `bun test` processes. | Raise `bun.maxSpawnDepth` on the nested runner ([recursion containment](docs/internals.md#recursion-containment)). |

### Warnings during the dry run

| Message | Cause | Fix |
|---|---|---|
| `The dry run took <N>ms, more than 80% of bun.timeout` | The next, slightly slower dry run may be killed. | Raise `bun.timeout`. |
| `Test discovery found <N> test file(s) under a "dist" or "build" directory` | Compiled copies of your tests run too. | Set `[test].root` or `[test].pathIgnorePatterns`, or use `bun.testFiles`. |
| `discoverTestFiles: no test files found in <dir>; falling back to Bun discovery` | Auto-discovery found nothing under the project (or `[test].root`). | Check `[test].root` and your test file names, or set `bun.testFiles`. |
| `bun.testFiles contains absolute path(s) and the current working directory appears to be a Stryker sandbox` | Absolute paths point at your original, unmutated files. | Use paths relative to the project. |
| `Both Stryker's testFiles option and bun.testFiles are set and select different test files` | Two selections disagree; Stryker's wins. | Remove one, or make them agree. |
| `These bunfig settings were ignored for mutation runs` | `[test].retry` or `[test].rerunEach` in your bunfig. | Remove them to silence the warning. |
| `The coverage preload reported problems on the dry-run child's stderr` | The preload could not write coverage, for example. | Read the `[Stryker Coverage]` lines it quotes. |
| `The dry run's coverage data shows no mutant covered by any test` | Every mutant would be NoCoverage. | Check that `mutate` matches the files your tests import, and that tests import sources, not a built copy in `dist/`. |
| `Bun exited with code <N> and its console output reported <N> failed test(s), but no failing test could be identified` | Usually an unhandled error between tests (a rejected fire-and-forget promise). | Look for unawaited async work, especially in the file that ran last. |
| `mutant coverage was recorded between tests, after '<test>' completed` | Async work from that test kept running after it ended, or a `beforeAll` ran between tests. | `await` the work in the test. Harmless if it is a `beforeAll`. |
| `Inspector data looks abnormal after the dry run:` | The inspector stream may be incomplete. | Re-run with debug logging; report it if it recurs. |
| `Inspector request unanswered after <N>ms` | An inspector request stalled while other traffic flowed. | Diagnostic; report it if the dry run then fails. |
| `Failed to write dryRun registry file` | Other workers cannot read the dry run's test names. | Check the temp directory; mutants still run, with less precise test selection. |

### Warnings and results during mutant runs

| Message or symptom | Cause | Fix |
|---|---|---|
| `Mutant <id>: bun test terminated by <SIGNAL>` ... `scoring as Error rather than Killed` | The process crashed (SIGSEGV, an out-of-memory kill) without a failing test. | A few can be a real crash in your suite; many mean memory pressure: lower `concurrency`, set `bun.maxChildRss`. |
| `Mutant <id>: could not start bun test: <error>` | Bun could not be spawned. | Check `bun.bunPath`, `PATH` and system limits. |
| `Mutant <id>: bun test exited with code <N> but reported no failing test and no fail/error count` | Bun failed before running tests (a missing preload, an unreadable bunfig). | Read the output head in the warning. |
| `Mutant <id>: inconclusive timeout, scoring as Error rather than Timeout` | A full-suite fallback did not finish within the time Stryker sized for the covering tests. | Raise Stryker's `timeoutMS` or `timeoutFactor`. |
| `Mutant <id>: --test-name-pattern matched 0 tests` | The mutant changed a test's name (often an interpolated `it.each` title); the runner retries with the full suite. | Usually nothing; spot-check that the mutant changes a title. |
| `no exact-name registry available` or `missing from exact-name registry` | A worker could not match test ids to bun's exact names; tests whose titles contain ` > ` may have been skipped in that run. | Check for an earlier registry warning; re-run. |
| `could not be resolved to dry-run test ids` or `no killing test identifiable — emitting empty killedBy` | A killed mutant whose killing test is unknown; it re-runs on every incremental run. | Usually a test whose output imitates bun's; harmless otherwise. |
| `bun test child exceeded maxChildRss` | A run went over `bun.maxChildRss`; scored Timeout. | Expected for runaway mutants; raise the limit if many hit it. |
| Many mutants Timeout | Stryker's timeout is tight for your suite, or many infinite loops. | Raise `timeoutMS`; check the hit-limit reason in the report. |
| Every mutant runs the whole suite | No per-test coverage: `coverageAnalysis` is not `'perTest'`, or coverage was missing. | Use `'perTest'` and check the dry-run warnings. |
| The score changed after upgrading from 1.4.0 | Scoring changed: a crash without a matched failing test is now Error (it was Killed), a test file that a mutant stops from loading is now Killed (it was Error), and a full-suite fallback stopped at Stryker's time limit is Error. | Expected. See [How results are scored](#how-results-are-scored). |

## Limitations

- **One test at a time.** Tests run sequentially, `test.concurrent` included, so per-test coverage
  is exact. Mutation runs are slower than a parallel `bun test`.
- **`mock.module()` of a mutated file** has no effect when the module was already imported, because
  the dry run imports every mutated file before the tests run. Use dependency injection or spy on
  methods instead. [Details](docs/internals.md#test-names-and-coverage-attribution).
- **Cross-file order dependence.** Mutant runs order files by cost, not as in the dry run, so a
  global change one test file leaves behind (an unrestored `mock.module()`) can change results.
- **No randomized order in mutant runs**, and `retry`/`rerunEach` are not supported.
- **Static mutants** run the whole suite in a fresh process each. See
  [`ignoreStatic`](#ignorestatic-faster-but-skips-module-level-code).
- **`bun.maxChildRss` is a polled, soft limit**, not a kernel-enforced one.
- **The dry run's fixed bounds** (the 30 s drain ceiling, the 4 s silence limit) have no options.

## Advanced topics

[docs/internals.md](docs/internals.md) covers how the runner works in detail:

- [Mutant runs](docs/internals.md#mutant-runs): test selection, cheapest-first ordering, fallbacks
- [How results are scored](docs/internals.md#how-results-are-scored) and
  [the hit limit](docs/internals.md#infinite-loops-the-hit-limit)
- [The dry run in detail](docs/internals.md#the-dry-run-in-detail): the start and drain handshakes,
  the completeness gate, coverage checks
- [Temporary files](docs/internals.md#temporary-files): the private per-run directory
- [Child processes](docs/internals.md#child-processes): process groups, orphan prevention,
  recursion containment
- [Memory](docs/internals.md#memory) and
  [`maxTestRunnerReuse`](docs/internals.md#maxtestrunnerreuse-compatibility)

## Contributing

Issues and pull requests are welcome at
[github.com/hughescr/stryker-bun-runner](https://github.com/hughescr/stryker-bun-runner).

- **Tests and lint**: `bun test` and `bun run lint` (and `bun run typecheck`).
- **Mutation testing**: this project's own mutation score is held at 100%. Run
  `bun run build && bun run mutate`. The local config is incremental: it reuses
  `reports/stryker-incremental.json` and only re-tests what changed. Use `bun run mutate --force`
  (or delete that file) only when the cached results look wrong, that is, when they do not reflect a
  change you made.
- **Tests never wait on the real clock.** Stryker re-runs a mutant's covering tests for every
  mutant, so any real wait is paid thousands of times. Use bun:test's fake timers
  (`jest.useFakeTimers()`, with helpers in `tests/helpers/fake-clock.ts`) or wait on events (exit,
  close, a line of output). `tests/real-clock-guard.ts`, loaded by `tests/test-preload.ts`, fails any
  test whose real timer with a delay above zero fires, and ESLint rejects timer imports in tests.
- **Orphan prevention check**: `bun scripts/verify-orphan-lifeline.ts` spawns a real host process
  that runs a one-test suite, holding Bun's fake timers, through the runner's spawn path and
  coverage preload, kills the host with SIGKILL, and waits up to 5 s for the child to exit. It prints
  `PASS` or `FAIL` with timings and exits 0 or 1. `FAIL` with a timer in the child's fake-timer queue
  means the lifeline pipe is unavailable on that machine and the child fell back to the timer
  watchdog. The orphan integration test in the suite also passes through that fallback (more
  slowly), so this script is the check that the lifeline itself works on a given machine.
- **`// Stryker disable` comments** in `src/` are only for genuinely equivalent mutants, with an
  independently confirmed reason; prefer writing the test that kills the mutant. Mind their scope:
  Stryker only honours a `// Stryker disable` or `// Stryker restore` comment that comes directly
  before a statement or expression it visits. A comment that is the last line before a closing brace
  (the end of an `if` block, a `catch` clause or a function body) is ignored without any warning.
  When that comment is a `// Stryker restore`, the range disable it was meant to end stays active to
  the end of the file and silently marks every later mutant of those mutators as Ignored. Put the
  restore before the next statement after the block, or prefer `// Stryker disable next-line` on the
  exact line. `tests/unit/stryker-disable-scopes.test.ts` fails on any directive Stryker would ignore
  and on any range disable without a matching restore.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
