# stryker-bun-runner

A [Stryker](https://stryker-mutator.io) test runner plugin for [Bun](https://bun.sh). Stryker
measures how good your tests are by making small changes (mutants) to your code and checking that
some test fails for each one. This plugin lets Stryker run your `bun test` suite, using per-test
coverage so that each mutant runs only the tests that reach it.

[![npm version](https://img.shields.io/npm/v/@hughescr/stryker-bun-runner)](https://www.npmjs.com/package/@hughescr/stryker-bun-runner) [![LICENSE](https://img.shields.io/badge/LICENSE-Apache--2.0-blue)](LICENSE.md) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.7-f9f1e1?logo=bun)](https://bun.sh) [![Stryker](https://img.shields.io/badge/Stryker-9%20%7C%2010-e74c3c?logo=stryker)](https://stryker-mutator.io) [![Mutation testing badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fhughescr%2Fstryker-bun-runner%2Fmain)](https://dashboard.stryker-mutator.io/reports/github.com/hughescr/stryker-bun-runner/main)

- **Per-test coverage**, so each mutant runs only its covering tests, in only their files,
  cheapest file first.
- **Honest scoring**: a crash or a run that proves nothing is an Error, not a kill; a test file
  that a mutant stops from loading is a kill; an infinite loop is stopped early and scored Timeout.
- **A strict dry run** that fails loudly rather than hand Stryker incomplete coverage.
- **Works with** Stryker's incremental mode, `testFiles`, `disableBail`, `ignoreStatic` and the
  TypeScript checker, with a helper that keeps your tests out of the type check.

## Contents

- [Quickstart](#quickstart)
  - [Before you start](#before-you-start) · [Install](#1-install) · [Configure](#2-configure) ·
    [Run](#3-run) · [Reading the output](#reading-the-output) ·
    [Optional: skip mutants that do not compile](#optional-skip-mutants-that-do-not-compile)
- [Upgrading from 1.4](#upgrading-from-14)
- [Terms](#terms)
- [Requirements and compatibility](#requirements-and-compatibility)
- [Configuration](#configuration)
  - [Example with every option](#example-with-every-option) · [bun.bunArgs](#bunbunargs) ·
    [Choosing the test files](#choosing-the-test-files) · [Your bunfig.toml](#your-bunfigtoml)
- [How it works](#how-it-works)
  - [How results are scored](#how-results-are-scored) · [Timeouts](#timeouts)
- [Speeding up runs](#speeding-up-runs)
  - [`ignoreStatic`](#ignorestatic-faster-but-skips-module-level-code) ·
    [Keep tests out of the TypeScript checker](#keep-tests-out-of-the-typescript-checker) ·
    [TypeScript 7's native checker](#typescript-7s-native-checker-experimental)
- [Troubleshooting](#troubleshooting)
  - [Before the dry run](#the-run-stops-before-the-dry-run) ·
    [Dry run fails](#the-dry-run-fails) · [Dry-run warnings](#warnings-during-the-dry-run) ·
    [Mutant runs](#warnings-and-results-during-mutant-runs)
- [Limitations](#limitations)
- [Advanced topics](#advanced-topics)
- [Contributing](#contributing)
- [License](#license)

## Quickstart

### Before you start

- **Bun 1.3.7 or later** (`bun --version`).
- **Node.js 22 or later** (`node --version`). Stryker itself runs on Node; only your tests run on
  Bun. Stryker 10, which the install below gets you, needs Node 22; Stryker 9 needs Node 20.
- **A project whose `bun test` passes**, with its source code under `src/` or `lib/` (Stryker's
  default; see `mutate` in [Stryker's options](https://stryker-mutator.io/docs/stryker-js/configuration/)
  otherwise).

### 1. Install

```bash
bun add -D @hughescr/stryker-bun-runner @stryker-mutator/core
```

> **Using TypeScript 7? Switch to TypeScript 6 first.** Stryker reads your `tsconfig.json` with the
> `typescript` package, and TypeScript 7's package cannot do that: `stryker run` stops with
> `TypeError: ts.parseConfigFileTextToJson is not a function`. A project created with `bun init`
> gets TypeScript 7. Check with `bun pm ls`, and if it lists `typescript@7`, run:
>
> ```bash
> bun remove typescript && bun add -D typescript@^6
> ```
>
> `bun add -D 'typescript@<7'` on its own is not enough when `typescript` is listed under
> `peerDependencies` (as `bun init` lists it): it rewrites that entry but leaves TypeScript 7
> installed.
>
> This package declares a peer dependency on `typescript` below 7. With TypeScript 7 present,
> `bun add` prints `warn: incorrect peer dependency "typescript@7.0.2"` and `npm install` stops
> with an `ERESOLVE` error. A project without TypeScript gets TypeScript 6 installed as
> that peer.

### 2. Configure

Create `stryker.conf.mjs` in your project root:

```javascript
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
};
```

`appendPlugins` is required: Stryker only loads plugins named `@stryker-mutator/*` by itself, so
without it `testRunner: 'bun'` is never registered.

### 3. Run

```bash
bunx stryker run
```

### Reading the output

Abridged output from a small project with one test file (your counts will differ):

```text
INFO DryRunExecutor Starting initial test run (bun test runner with "perTest" coverage analysis). This may take a while.
INFO DryRunExecutor Initial test run succeeded. Ran 2 tests in 0 seconds (net 1 ms, overhead 90 ms).
[Survived] EqualityOperator
src/math.ts:6:12
-       return n > 0;
+       return n >= 0;
Tests ran:
    tests/math.test.ts > isPositive
----------|------------------|----------|-----------|------------|----------|----------|
          | % Mutation score |          |           |            |          |          |
File      |  total | covered | # killed | # timeout | # survived | # no cov | # errors |
----------|--------|---------|----------|-----------|------------|----------|----------|
All files |  85.71 |   85.71 |        6 |         0 |          1 |        0 |        0 |
INFO HtmlReporter Your report can be found at: file:///home/me/demo/reports/mutation/mutation.html
INFO BunTestRunner Mutant runs on this worker: 3 (killed 2, survived 1, timeout 0, error 0); full-suite fallbacks: 0
INFO BunTestRunner Mutant runs on this worker: 4 (killed 4, survived 0, timeout 0, error 0); full-suite fallbacks: 0
```

- Each Stryker **worker** process logs one `Mutant runs on this worker` line at the end, so you
  see as many of them as Stryker has workers.
- Each worker process also logs one `Bun test runner started` line (bun version and path, test
  files, sanitized bunfig), but at `debug`, so it only shows with `--logLevel debug`. These are
  one per worker process, not one per dry run: the dry run itself happens once, on one worker.
- **`Initial test run succeeded`** means the [dry run](#terms) passed: your whole suite ran once,
  unmutated, and the runner recorded which tests reach which mutants.
- **Killed** mutants made a test fail: good. A **Survived** mutant is a change to your code that no
  test noticed; here, no test checks `isPositive(0)`. Add or strengthen a test to kill it.
- The **mutation score** is the share of mutants your tests detected. The HTML report, at
  `reports/mutation/mutation.html`, shows every mutant in your source.
- **Full-suite fallbacks** count mutants that had covering tests but had to run the whole suite
  instead (see [Terms](#terms)); a few are normal.

If something goes wrong instead, see [Troubleshooting](#troubleshooting).

### Optional: skip mutants that do not compile

Stryker's TypeScript checker type-checks each mutant first and marks the ones that do not compile
as CompileError instead of running your tests on them. It needs a `tsconfig.json` and `typescript`
6 or earlier (see the note under [Install](#1-install)):

```bash
bun add -D @stryker-mutator/typescript-checker
```

Then turn it on with `checkers: ['typescript']`. Stryker loads `@stryker-mutator/*` plugins by
itself, so `appendPlugins` stays as it is. To keep the checker from re-checking your tests too, wrap
the config in [`withTestFilesExcludedFromTypeCheck`](#keep-tests-out-of-the-typescript-checker):

```javascript
// @ts-check
import { withTestFilesExcludedFromTypeCheck } from '@hughescr/stryker-bun-runner';

export default await withTestFilesExcludedFromTypeCheck({
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  checkers: ['typescript'],
});
```

## Upgrading from 1.4

Most projects need no config change, but these differ from 1.4:

- **`bun.timeout` now bounds only the dry run** (plus the 30 s drain-handshake allowance). Mutant
  runs use Stryker's per-mutant timeout: `timeoutFactor` × the dry-run time of the tests that
  mutant runs (the whole suite for a static mutant) + `timeoutMS` + the dry run's overhead, less a
  small margin ([Timeouts](#timeouts)). If you raised `bun.timeout` so slow mutant runs would not
  time out, raise `timeoutMS` or `timeoutFactor` instead. `bun.timeout` can now be generous: the
  runner warns above 80% use, and only a hung dry run takes that long to fail.
- **Mutant runs never randomize.** Covering files run cheapest first (by dry-run time), tests in
  source order. The dry run still follows your bunfig `randomize` and `seed`.
- **Some verdicts change, toward correctness** ([How results are scored](#how-results-are-scored)).
  A hang that a fast test catches is Killed. An infinite loop stops at Stryker's hit limit and is
  Timeout, reason `Hit limit reached`. A bun crash or failed start with no failing test is Error
  (left out of the score), not Killed. A mutant that stops a test file loading is Killed (1.4
  usually scored it Error). Incremental mode keeps the old verdict of mutants it reuses; run once
  with `--force` to re-score.
- **The dry run is stricter.** Bun's summary, the inspector's events and the coverage records must
  agree exactly (1.4 tolerated small shortfalls), and missing per-test coverage with
  `coverageAnalysis: 'perTest'` is an Error. See [the dry run fails](#the-dry-run-fails).
- **Configuration.** Some `bun.bunArgs` flags are now rejected, `--retry` and `--rerun-each`
  among them ([bun.bunArgs](#bunbunargs)). `retry` and `rerunEach` in your bunfig are dropped with
  a warning. `bun.testFiles` entries are exact paths, not substring filters, so a bare name no
  longer matches copies under `dist/` ([Choosing the test files](#choosing-the-test-files)).
  `--config`/`-c` in `bun.bunArgs` names the bunfig the runner reads, and everything outside
  `[test]` in it is kept (1.4 kept only `[install]`): [Your bunfig.toml](#your-bunfigtoml).
- **Install.** A peer dependency on `typescript` below 7 (see the callout under
  [Install](#1-install)); dependencies are no longer bundled and install normally. Startup now
  requires Bun 1.3.7 or later and stops at once otherwise.
- **Test ids are unchanged**, so a 1.4 incremental report stays reusable. The one exception is a
  test retried in the dry run (a per-test `{ retry }` option, or `retry` in your bunfig): it had one
  id per attempt (`name [0]`, `name [1]`, ...) and now has the single id `name`.

## Terms

- **Mutant**: one small change Stryker makes to your source, such as `>` to `>=`. Each mutant is
  tested on its own and ends up **Killed** (a test failed), **Survived** (no test failed),
  **Timeout**, **NoCoverage** (no test reaches it), **CompileError** (with a checker) or **Error**
  (Stryker shows RuntimeError; left out of the score).
- **Dry run**: Stryker's first run of your whole suite, without mutants. It must pass. The runner
  uses it to record which tests reach each mutant.
- **Covering tests**: the tests that reached a mutant in the dry run. A mutant run normally runs
  only these.
- **Static mutant**: a mutant in code that runs only while a module loads (module-level constants,
  top-level setup), so no single test covers it, and every test has to run for it.
- **Full-suite fallback**: a mutant that had covering tests but ran the whole suite instead, because
  the list of test names was too long for the command line or matched no test.
- **killedBy**: the tests Stryker records as having killed a mutant. Incremental mode uses it to
  decide what to re-run.
- **Bail**: stopping a mutant run at the first failing test, which is enough to kill the mutant.
- **Hit limit**: Stryker's cap on how many times a mutant may execute in a mutant run (100 times
  its dry-run count). Exceeding it means an infinite loop, scored Timeout.
- **Sandbox**: the copy of your project Stryker makes under `.stryker-tmp/` and mutates.
- **Worker**: one of the processes Stryker runs mutants in; Stryker's `concurrency` option sets how
  many.
- **bunfig**: Bun's configuration file, `bunfig.toml`.
- **Preload**: a script bun runs before your tests (`[test].preload` in the bunfig). The runner adds
  its own coverage preload, which switches mutants on and records coverage.
- **Inspector**: Bun's debugging protocol. The runner uses its test events to see each test start
  and finish.
- **Drain handshake**: at the end of the dry run, the test process waits until the runner confirms
  it has received every test event, so none are lost on a busy machine.

## Requirements and compatibility

| Component | Supported | Notes |
|---|---|---|
| Bun | 1.3.7 or later | Tested with 1.3.7, 1.3.14 and 1.4.2. Older versions lack the inspector test events the runner needs ([oven-sh/bun#25986](https://github.com/oven-sh/bun/pull/25986)). |
| `@stryker-mutator/core` | 9.x or 10.x | Peer dependency. Stryker's `testFiles` option needs 9.6 or later. |
| Node.js | 20 or later with Stryker 9; 22 or later with Stryker 10 | Stryker runs on Node; only the test processes run on Bun. |
| `typescript` | 6 or earlier, when your project has a `tsconfig.json` | Peer dependency (`<7`): bun warns and npm refuses to install next to TypeScript 7, and a project without TypeScript gets TypeScript 6. Stryker reads `tsconfig.json` with it, with or without a checker, and TypeScript 7's package cannot (see [Install](#1-install)). TypeScript 7 can only be added next to it, for the [native checker](#typescript-7s-native-checker-experimental). |
| `@stryker-mutator/typescript-checker` (optional) | the same version as `@stryker-mutator/core` | |
| Operating system | Linux, macOS | |

At startup the runner runs `<bunPath> --version` and stops with a clear error if Bun cannot be run
or is older than 1.3.7. To upgrade Bun, run `bun upgrade`.

## Configuration

Runner options go under `bun` in your Stryker config. Stryker validates them: an unknown key under
`bun`, a wrong type, or an out-of-range value stops the run with a configuration error.

| Option | Type | Default | Description |
|---|---|---|---|
| `bun.bunPath` | `string` | `'bun'` | Bun executable to run. |
| `bun.timeout` | `number` (ms, >= 0) | `10000` | Wall-clock limit for the **dry run's** `bun test` process, which gets 30 s more for the [drain handshake](#terms). Set it comfortably above your full suite's run time; the runner warns when a dry run uses more than 80% of it. Mutant runs follow Stryker's per-mutant timeout instead (see [Timeouts](#timeouts)). Not the same as Bun's per-test `[test].timeout`. |
| `bun.inspectorTimeout` | `number` (ms, >= 0) | `5000` | Bound on each step of connecting to Bun's [inspector](#terms) in the dry run: waiting for bun to print its inspector address, connecting, and each request. Raise it if bun is slow to start. |
| `bun.env` | `object` of strings | none | Extra environment variables for every `bun test` process (and for the startup `bun --version` check). |
| `bun.bunArgs` | `string[]` | none | Extra `bun test` flags. Some are rejected, removed or handled specially; see [bun.bunArgs](#bunbunargs). |
| `bun.testFiles` | `string[]` (non-empty) | none | The test files or directories to run, instead of auto-discovery. See [Choosing the test files](#choosing-the-test-files). |
| `bun.smol` | `boolean` | `false` | Pass Bun's `--smol` to every process: a smaller JavaScriptCore heap at some cost to speed. |
| `bun.maxChildRss` | `number` (bytes, >= 0) | none | Soft memory ceiling per `bun test` process. One that exceeds it is killed and that run scored Timeout. |
| `bun.rssCheckIntervalMs` | `number` (ms, >= 0) | `1000` | How often to check `maxChildRss`. |
| `bun.maxSpawnDepth` | integer (>= 1) | `1` | How deeply `bun test` processes may nest before the runner refuses to start another. Raise it only if your own tests run this runner; see [the troubleshooting entry](#the-dry-run-fails). |

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

The runner owns parts of the `bun test` command line (one test at a time, the per-mutant test
name pattern, the config file, the inspector, bail and the file list). So:

- **Rejected at startup with an error** (rather than silently producing wrong scores):
  `--concurrent`, `--max-concurrency`, `--parallel` and `--test-worker` (break per-test coverage);
  `--shard` and `--changed` (run only part of the suite); `-t`/`--test-name-pattern` (the runner
  builds its own per mutant); `-u`/`--update-snapshots` (snapshot tests could never fail);
  `--pass-with-no-tests` (a selection that matched nothing would be scored Survived); `--watch`
  (never exits); `--coverage`, `--coverage-reporter` and `--coverage-dir` (turn Bun's own coverage
  back on); `--cwd` (moves bun out of the [sandbox](#terms)); `--inspect`, `--inspect-wait` and
  `--inspect-brk` (collide with the runner's inspector); `--retry` and `--rerun-each` (re-run tests,
  which only costs time and repeats test names, so the killing test cannot be identified).
- **Removed**: [bail](#terms) flags (`--bail`, `--bail=<N>`, `--bail <N>`). Mutant runs bail on the
  first failing test unless you set Stryker's `disableBail`; the dry run never bails.
- **Dry run only**: `--randomize` and `--seed` (`--seed=<N>` or `--seed <N>`). Mutant runs drop
  them, so a result never depends on a random order.
- **Used as your bunfig**: `--config=<path>`, `--config <path>` or `-c <path>` is taken out of the
  command line and names the bunfig the runner reads instead of `bunfig.toml` (see
  [Your bunfig.toml](#your-bunfigtoml)). The path is resolved against the project directory (in
  Stryker's sandbox, so check that `ignorePatterns` does not leave the file out), and the file must
  exist. A `--config` or `-c` with no path is rejected.
- **Fine**: anything else, for example `--only` (only `.only` tests then count as the suite, and
  the dry run fails if none is marked), `--isolate`, `--dots` or a `--reporter`.

### Choosing the test files

The runner passes `bun test` an explicit list of test files, from the first of these that is set:

1. **Stryker's `testFiles` option**. Mutant runs stay within that selection too. If
   `bun.testFiles` is also set and differs, the runner warns and uses Stryker's.
2. **`bun.testFiles`.** Entries are exact paths, relative to the project directory: a file, or a
   directory to run every test file below it. A bare name fragment is not a filter. Avoid absolute
   paths: under Stryker they point at your original files rather than the sandbox copy, so the
   mutants are never seen (the runner warns about this).
3. **Auto-discovery**, following `bun test`'s own rules: files named `*.test.*`, `*_test.*`,
   `*.spec.*` or `*_spec.*` with a JavaScript or TypeScript extension, skipping `node_modules` and
   dot-directories, starting at `[test].root` from your bunfig when it is set.

Like `bun test`, discovery searches `dist` and `build`, so compiled copies of your tests run too;
the runner warns once when it finds any. Details, including the command-line length limit:
[Choosing the test files](docs/internals.md#choosing-the-test-files).

### Your bunfig.toml

`bun test --config` replaces your bunfig rather than adding to it, so the runner hands bun a
sanitized copy of yours. Everything outside `[test]` is kept. In `[test]`, `preload`, `root`,
`pathIgnorePatterns`, `timeout`, `smol`, `randomize` and `seed` are kept; `coverage` and
`onlyFailures` are forced off; `retry` and `rerunEach` are dropped with a warning; anything else is
dropped. Mutant runs never randomize the test order. Your `[test].preload` files run before the
runner's own [preload](#terms). Details:
[the sanitized config](docs/internals.md#your-bunfigtoml-the-sanitized-config).

## How it works

1. **Startup.** Each Stryker worker checks Bun's version, validates `bun.bunArgs`, writes its
   coverage preload and sanitized bunfig to a private temporary directory, and finds the test files.
2. **Dry run.** One `bun test` run of the whole suite, one test at a time (`--max-concurrency=1`,
   with `test.concurrent` tests run in turn too), so every mutant reached can be credited to the
   test that reached it. The runner follows each test through Bun's inspector while the preload
   records which mutants each test reached, and how often. Bun's summary, the inspector's events and
   the coverage records must agree exactly, or the dry run fails
   ([the completeness gate](docs/internals.md#the-completeness-gate)).
3. **Mutant runs.** A fresh `bun test` process per mutant, with the mutant switched on. It runs only
   the covering tests (`--test-name-pattern`), only in their files, cheapest file first, and bails at
   the first failure unless `disableBail` is set. The hit limit stops infinite loops early.

More: [Mutant runs](docs/internals.md#mutant-runs), [the dry run in detail](docs/internals.md#the-dry-run-in-detail).

### How results are scored

- **Killed** when a test fails, or when a test file fails to load because of the mutant (bun reports
  a failure count but no failing test).
- **Survived** when every selected test passes.
- **Timeout** when the hit limit is exceeded, the time limit is reached, or `bun.maxChildRss` is
  exceeded.
- **Error** when the run proves nothing either way: the process crashed with no failing test that
  matches a known test, could not be started, exited with an error but no failing test and no failure
  count, or a full-suite fallback ran out of the time Stryker sized for the covering tests.

The full table and the reasoning: [How results are scored](docs/internals.md#how-results-are-scored).

### Timeouts

Stryker sizes a timeout for every mutant run from the dry-run time of the tests it will run, plus
`timeoutMS`. The runner kills the `bun test` process a little before that, at Stryker's timeout
minus the larger of 750 ms and 5% (never more than a quarter of the timeout), and reports the
Timeout itself; if Stryker's own timer fired first, it would restart the whole worker. `bun.timeout`
only bounds the dry run. To give mutant runs more time, raise Stryker's `timeoutMS` or
`timeoutFactor`. Details: [Timeouts](docs/internals.md#timeouts).

## Speeding up runs

**What to try first, in order:** keep incremental mode on for local runs; right-size `concurrency`;
if you use the TypeScript checker, wrap your config in `withTestFilesExcludedFromTypeCheck`; then
`ignoreStatic`, if you accept what it skips; then TypeScript 7's native checker, if type checking is
still the slow part.

- **Incremental mode.** With Stryker's `incremental: true`, a run reuses the previous results
  (`reports/stryker-incremental.json` by default) and only re-tests mutants whose code or covering
  tests changed. The runner keeps test ids stable across runs, so results stay reusable. Run with
  `--force` only when the cached results look wrong.
- **`concurrency`.** Stryker runs this many workers, each with one `bun test` process at a time; with
  a checker, Stryker splits it between checker and test-runner processes. More is faster until CPU or
  memory runs out: peak memory is roughly `concurrency` × the memory one run of your suite needs. On a
  memory-constrained machine, lower it first, then consider `bun.smol` and `bun.maxChildRss`
  ([memory](docs/internals.md#memory)).
- **Bail** is on by default: mutant runs stop at the first failing test. Stryker's
  `disableBail: true` runs every covering test instead, so killedBy lists every test that kills the
  mutant, at a cost in time.

### `ignoreStatic`: faster, but skips module-level code

Each [static mutant](#terms) runs your whole suite in a fresh process, so a project with many
module-level constants or much top-level setup can spend a large part of its time on them.
Stryker's `ignoreStatic: true` skips them. They are then never tested and not counted in your score,
so a bug a mutant there would have revealed goes unnoticed. Leave it off if module-level behaviour
matters to you; turn it on if run time matters more.

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
that tsconfig includes your tests, a mutant in a widely imported module re-checks much of your test
suite too. `withTestFilesExcludedFromTypeCheck`, used in the
[example above](#optional-skip-mutants-that-do-not-compile), points the checker at the code under
test only.

Each time Stryker loads the config, the helper reads your tsconfig with your project's TypeScript
(honouring `extends`, `files`, `include` and `exclude`) and writes `tsconfig.stryker-checker.json`
next to it. That file extends yours and lists everything your tsconfig covers except:

- test files, found the way this runner finds them (Bun's naming rules under `[test].root`, plus
  `bun.testFiles` and Stryker's `testFiles`);
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
time, survives instead of counting as a CompileError.

### TypeScript 7's native checker (experimental)

`@stryker-mutator/typescript-checker` 10 can type-check mutants with TypeScript 7's native compiler
instead of its default mode, which uses your `typescript` package (TypeScript 6 or earlier). The
native compiler is much faster. Upstream marks this mode experimental: it uses TypeScript 7's
unstable API, does not support project references, and checks mutants one at a time.

**Is it worth it?** Try it when type checking is the slow part of your run (compare a run's time
with and without `checkers`) and your tsconfig has no project references. Otherwise stay with the
default mode.

To opt in, install TypeScript 7 under the name the checker loads it by, next to your existing
`typescript` 6 or earlier, and set the option:

```bash
bun add -D --exact @typescript/native@npm:typescript@7.0.2
```

```javascript
// @ts-check
import { withTestFilesExcludedFromTypeCheck } from '@hughescr/stryker-bun-runner';

export default await withTestFilesExcludedFromTypeCheck({
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  checkers: ['typescript'],
  typescriptChecker: { experimentalNativePreview: true },
});
```

- The checker imports `@typescript/native/unstable/sync`. Its error message suggests a `typescript7`
  alias, but it never looks for one, so use the `@typescript/native` name above.
- Pin TypeScript 7.0.2 exactly. TypeScript 7.1 renames the `unstable/sync` entry point to `sync`,
  which checker 10.0.0 cannot load.
- Keep `typescript` 6 or earlier: Stryker and the checker still need it, and so does
  `withTestFilesExcludedFromTypeCheck`. The alias installs a second `tsc` that takes over
  `node_modules/.bin/tsc`, so call TypeScript 6 by its path (`node node_modules/typescript/bin/tsc`)
  where that matters.

#### Do you need the checker patch?

Only if your tsconfig turns on `noUnusedLocals` or `noUnusedParameters`, or sets
`allowUnreachableCode: false`. The checker's default mode switches those checks off for mutants,
since a mutant that leaves a variable unused is not broken. Checker 10.0.0's native mode fails to,
whenever `tsconfigFile` is a relative path (the default, and what
`withTestFilesExcludedFromTypeCheck` sets). **Symptom:** the native checker reports more
CompileErrors than the default mode, with reasons such as
`error TS6133: 'message' is declared but its value is never read`, and those mutants are never
tested.

The fix is a one-line patch. With Bun:

1. Pin the checker, since the patch is for that exact version:
   `bun add -D --exact @stryker-mutator/typescript-checker@10.0.0`.
2. Save this as `patches/@stryker-mutator%2Ftypescript-checker@10.0.0.patch` (the `%2F` is part of
   the file name):

   ```diff
   diff --git a/dist/src/ts-native/native-typescript-compiler.js b/dist/src/ts-native/native-typescript-compiler.js
   --- a/dist/src/ts-native/native-typescript-compiler.js
   +++ b/dist/src/ts-native/native-typescript-compiler.js
   @@ -43,7 +43,7 @@ export class NativeTypescriptCompiler {
            this.log.debug('Started the native TypeScript compiler on project "%s"', this.tsconfigFile);
            return this.checkSnapshot();
        }
   -    async #adjustTSConfigFile(fileName = this.options.tsconfigFile) {
   +    async #adjustTSConfigFile(fileName = this.tsconfigFile) {
            const parsedConfig = ts.parseConfigFileTextToJson(toPosixFileName(fileName), await fs.promises.readFile(fileName, 'utf-8'));
            if (parsedConfig.error) {
                return; // let the ts compiler deal with this error
   ```

3. Add it to `package.json` and run `bun install`:

   ```json
   "patchedDependencies": {
     "@stryker-mutator/typescript-checker@10.0.0": "patches/@stryker-mutator%2Ftypescript-checker@10.0.0.patch"
   }
   ```

`patchedDependencies` is a Bun feature. With npm, make the same one-line change in
`node_modules/@stryker-mutator/typescript-checker/dist/src/ts-native/native-typescript-compiler.js`
and record it with [patch-package](https://github.com/ds300/patch-package)
(`npx patch-package @stryker-mutator/typescript-checker`, plus a `"postinstall": "patch-package"`
script).

## Troubleshooting

Run Stryker with `logLevel: 'debug'` (or `--logLevel debug`) for the full detail behind any of
these. A warning that repeats for many mutants is logged in full once per worker, then at debug,
with a summary at the end: `<kind>: <N> mutants affected (first: <ids>); see debug log for details`.
Every log message: [Log output](docs/internals.md#log-output).

### The run stops before the dry run

| Message | Cause | Fix |
|---|---|---|
| `TypeError: ts.parseConfigFileTextToJson is not a function` (from Stryker) | TypeScript 7 is installed as `typescript`. | `bun remove typescript && bun add -D typescript@^6` (see [Install](#1-install)). |
| `Cannot find TestRunner plugin "bun"` (from Stryker) | The plugin was not loaded. | Add `appendPlugins: ['@hughescr/stryker-bun-runner']`. |
| `Config option "bun" must NOT have additional properties` (from Stryker) | A misspelt or unknown option under `bun`. Stryker does not say which. | Compare each key under `bun` with the [options table](#configuration). |
| `stryker-bun-runner: could not run "<bunPath>" (<reason>). Install bun >= 1.3.7 or set bun.bunPath in your Stryker config.` | Bun is not installed, not on `PATH`, or `bun.bunPath` is wrong. | Install Bun or set `bun.bunPath`. `bun.env` can set `PATH`. |
| `stryker-bun-runner: bun <version> at "<bunPath>" is too old; version 1.3.7 or newer is required.` | Bun before 1.3.7 lacks the inspector events the runner needs. | `bun upgrade`. |
| `stryker-bun-runner: bun.bunArgs contains "<flag>", which <reason>. Remove it.` (or `contains unsupported flags`) | A flag that would corrupt the scores. | Remove it; see [bun.bunArgs](#bunbunargs). |
| `has no usable path: write --config=<path>, --config <path> or -c <path>` | A `--config`/`-c` with no file name. | Give the path. |
| `Failed to read bunfig.toml at <path>` or `Failed to read bunfig (named by --config in bun.bunArgs) at <path>` | The bunfig does not parse, or the file named by `--config` is not in the sandbox. | Fix the file, or the path and `ignorePatterns`. |
| `stryker-bun-runner: refusing to use temporary directory <dir>: <problem>.` | The run's temporary directory, or a directory above it, could be changed by another user. | Delete the directory if it is a stale run directory you trust, or set `TMPDIR` to a directory only you and root control. See [Temporary files](docs/internals.md#temporary-files). |
| `[Stryker] withTestFilesExcludedFromTypeCheck: not applied: <reason>` (warning) | The helper fell back to your own tsconfig. | Act on the reason; the run continues with the full type check. |

### The dry run fails

| Message | Cause | Fix |
|---|---|---|
| Stryker lists failing tests | Your suite fails under Stryker, which runs one test at a time. A test that exceeds Bun's `[test].timeout` counts as failed. Each failure message includes the stack from Bun's inspector when Bun reports one. | Run `bun test --max-concurrency=1`. If it fails there too, you have an order-dependent or concurrency-dependent test; fix it. |
| `Timeout waiting for inspector URL after <N>ms (raise bun.inspectorTimeout if bun is slow to start)` | Bun did not start in time, or exited first; the message ends with bun's last stderr. | Read that stderr (a preload that fails to resolve, say); raise `bun.inspectorTimeout` on a slow machine. |
| `Failed to connect to Bun inspector: <error>` | Connecting to the inspector did not succeed within `bun.inspectorTimeout`, or bun exited while the runner was connecting; the message ends with bun's last stderr. | If that stderr says why bun exited, fix that; otherwise raise `bun.inspectorTimeout` on a slow or loaded machine, and re-run. |
| `Failed to start sync server: <error>` | The runner could not open its local socket on `127.0.0.1`. | Re-run; check that loopback networking is available. |
| `the dry run's sync connection to the runner` ... `before the runner signalled that it is ready to observe the tests` | The test process lost its connection to the runner before the tests started. | Usually follows another error above it; fix that one. |
| `Dry run timed out: bun.timeout is <N>ms` (and Stryker reports a timeout) | The dry run outgrew `bun.timeout` plus the 30 s drain handshake allowance. | Raise `bun.timeout` above your full suite's run time. |
| `Bun test process failed with exit code <N>` or `Bun test process terminated by signal <SIGNAL>` | Bun exited abnormally with no failing test (a missing module, a crash). The message includes stderr. | Fix what the stderr shows. |
| `stryker-bun-runner: dry run data-completeness check failed — <problems>` | Usually something in your suite: a test or hook that calls `process.exit`, or a test file that fails to load (an unresolvable import, say); the problems listed name it. Otherwise test events were lost on a heavily loaded machine. | Fix the cause in your suite; otherwise re-run, and report it if it recurs. See [the completeness gate](docs/internals.md#the-completeness-gate). |
| `stryker-bun-runner: the dry run produced no mutant coverage data` | The coverage preload never ran, could not write, or the process exited before its final `afterAll` (a test calls `process.exit`). An error with `coverageAnalysis: 'perTest'`, a warning with `'all'`. | Fix the cause the message names, or set `coverageAnalysis` to `'all'` or `'off'` to run without per-test coverage. |
| `refusing to spawn` ... `at nesting depth` | Your tests themselves run this runner (they run `stryker run` on a fixture, or create a `BunTestRunner`), so `bun test` processes nest. | Give the inner runner `maxSpawnDepth: 2`: in the Stryker config your test runs (`bun: { maxSpawnDepth: 2 }`), or in the options your test passes. Setting it in your own `stryker.conf.mjs` has no effect. |

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
| `Bun exited with code <N> and its console output reported <N> failed test(s), but no failing test could be identified` | Usually an unhandled error between tests (a rejected promise nobody awaited). | Look for unawaited async work, especially in the file that ran last. |
| `mutant coverage was recorded between tests, after '<test>' completed` | Async work from that test kept running after it ended, or a `beforeAll` ran between tests. | `await` the work in the test. Harmless if it is a `beforeAll`. |
| `Failed to write dryRun registry file` | Other workers cannot read the dry run's test names. | Check the temporary directory; mutants still run, with less precise test selection. |

Inspector diagnostics such as `Inspector data looks abnormal` need no action unless the dry run
also fails; see [Inspector diagnostics](docs/internals.md#inspector-diagnostics).

### Warnings and results during mutant runs

| Message or symptom | Cause | Fix |
|---|---|---|
| `Mutant <id>: bun test terminated by <SIGNAL>` ... `scoring as Error rather than Killed` | The process crashed (SIGSEGV, an out-of-memory kill) without a failing test. | A few can be a real crash in your suite; many mean memory pressure: lower `concurrency`, set `bun.maxChildRss`. |
| `Mutant <id>: could not start bun test: <error>` | Bun could not be started. | Check `bun.bunPath`, `PATH` and system limits. |
| `Mutant <id>: bun test exited with code <N> but reported no failing test and no fail/error count` | Bun failed before running tests (a missing preload, an unreadable bunfig). | Read the output in the warning. |
| `Mutant <id>: inconclusive timeout, scoring as Error rather than Timeout` | A full-suite fallback did not finish within the time Stryker sized for the covering tests. | Raise Stryker's `timeoutMS` or `timeoutFactor`. |
| `Mutant <id>: --test-name-pattern matched 0 tests` | The mutant changed a test's name (often an interpolated `it.each` title); the runner retries with the full suite. | Usually nothing; spot-check that the mutant changes a title. |
| `no exact-name registry available` or `missing from exact-name registry` | A worker could not match test ids to bun's exact names; tests whose titles contain ` > ` may have been skipped in that run. | Check for an earlier registry warning; re-run. |
| `could not be resolved to dry-run test ids` or `no killing test identifiable — emitting empty killedBy` | A killed mutant whose killing test is unknown; it re-runs on every incremental run. | Usually a test whose output imitates bun's; harmless otherwise. |
| `bun test child exceeded maxChildRss` | A run went over `bun.maxChildRss`; scored Timeout. | Expected for runaway mutants; raise the limit if many hit it. |
| Many mutants Timeout | Stryker's timeout is tight for your suite, or many mutants loop forever. Infinite loops stopped by the hit limit carry the reason `Hit limit reached (count/limit)`: open the mutant in the HTML report, or read `statusReason` in Stryker's JSON report. | For the others, raise `timeoutMS` or `timeoutFactor`. |
| Every mutant runs the whole suite | No per-test coverage: `coverageAnalysis` is not `'perTest'`, or coverage was missing. | Use `'perTest'` and check the dry-run warnings. |
| The score changed after upgrading this plugin | Scoring has changed over time (for example, a crash without a matching failing test is now Error, and a test file that a mutant stops from loading is Killed). | Expected. See [Upgrading from 1.4](#upgrading-from-14), [How results are scored](#how-results-are-scored), and the [commit history](https://github.com/hughescr/stryker-bun-runner/commits/main) for what changed. |

## Limitations

- **One test at a time.** Tests run sequentially, `test.concurrent` included, so per-test coverage
  is exact. Mutation runs are slower than a parallel `bun test`.
- **`mock.module()` of a mutated file** has no effect when the module was already imported, because
  the dry run imports every mutated file before the tests run. Use dependency injection or spy on
  methods instead. [Details](docs/internals.md#test-names-and-coverage-attribution).
- **Cross-file order dependence.** Mutant runs order files by cost, not as in the dry run, so a
  global change one test file leaves behind (an unrestored `mock.module()`) can change results.
- **No randomized order in mutant runs**, and `retry`/`rerunEach` are not supported.
- **Static mutants** each run the whole suite in a fresh process. See
  [`ignoreStatic`](#ignorestatic-faster-but-skips-module-level-code).
- **`bun.maxChildRss` is a polled, soft limit**, not a kernel-enforced one.
- **The dry run's fixed bounds** (the 30 s drain handshake ceiling, the 4 s silence limit) have no
  options.

## Advanced topics

[docs/internals.md](docs/internals.md) covers how the runner works in detail:

- [Mutant runs](docs/internals.md#mutant-runs): test selection, cheapest-first ordering, fallbacks
- [How results are scored](docs/internals.md#how-results-are-scored) and
  [the hit limit](docs/internals.md#infinite-loops-the-hit-limit)
- [The dry run in detail](docs/internals.md#the-dry-run-in-detail): the start and drain handshakes,
  the completeness gate, coverage checks
- [Log output](docs/internals.md#log-output): start and end summaries, repeated warnings
- [Temporary files](docs/internals.md#temporary-files): the private per-run directory
- [Child processes](docs/internals.md#child-processes): process groups, orphan prevention,
  recursion containment
- [Memory](docs/internals.md#memory) and
  [`maxTestRunnerReuse`](docs/internals.md#maxtestrunnerreuse-compatibility)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
