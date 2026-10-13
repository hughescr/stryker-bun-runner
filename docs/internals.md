# How stryker-bun-runner works

This is the detailed companion to the [README](../README.md). You do not need it to use the
runner. Read it when you want to know exactly why a mutant got the result it did, what a
diagnostic means, or how the runner keeps its processes and files safe.

- [The shape of a run](#the-shape-of-a-run)
- [Choosing the test files](#choosing-the-test-files)
- [Mutant runs](#mutant-runs)
- [How results are scored](#how-results-are-scored)
- [Timeouts](#timeouts)
- [Infinite loops: the hit limit](#infinite-loops-the-hit-limit)
- [Your bunfig.toml: the sanitized config](#your-bunfigtoml-the-sanitized-config)
- [The dry run in detail](#the-dry-run-in-detail)
- [Log output](#log-output)
- [Temporary files](#temporary-files)
- [Child processes](#child-processes)
- [Memory](#memory)
- [`maxTestRunnerReuse` compatibility](#maxtestrunnerreuse-compatibility)
- [Test names and coverage attribution](#test-names-and-coverage-attribution)

## The shape of a run

Stryker starts several worker processes, and each creates one `BunTestRunner`. Every
`dryRun` and every `mutantRun` spawns a brand-new `bun test` process and waits for it to exit;
a `bun test` child is never reused across runs. The plugin talks to the child in three ways:

- **Bun's inspector protocol** (a WebSocket on `127.0.0.1`, enabled with
  `--inspect=127.0.0.1:0`: bun binds a port the OS picks and prints its URL, which the runner
  reads from bun's stderr). Its `TestReporter` events tell the runner which tests exist,
  when each starts and ends, and how it ended. Bun added those events in 1.3.7
  ([oven-sh/bun#25986](https://github.com/oven-sh/bun/pull/25986)); the runner itself requires
  Bun 1.4.0 or later, the oldest release its test suite is run against.
- **A coverage preload** (`--preload`), a script the runner generates. It activates the mutant
  under test, records which mutants each test executed (dry run only), arms Stryker's hit
  limit, and guards against the child outliving its parent.
- **A sync socket** (dry run only), a WebSocket server the runner opens on `127.0.0.1`, on a port
  the OS picks. The child is given the port and a random token in its environment, and dials
  `/sync/<token>`; the server refuses any other path, so a child cannot be released by another
  run's sync server that the OS has since given the same port. It is used for
  the start and end handshakes described in [The dry run in detail](#the-dry-run-in-detail).

Every child runs with `--max-concurrency=1`, and the preload replaces `describe.concurrent`,
`test.concurrent` and `it.concurrent` with their sequential forms. Per-test coverage needs to
know which test is running when a mutant executes, and concurrent tests would interleave.

## Choosing the test files

The files the runner hands `bun test` come from the first of these that applies:

1. **Stryker's own `testFiles` option** (Stryker 9.6 and later, and 10). Stryker passes the
   matching files to the dry run, and the runner runs exactly those. Every later "run all tests"
   run (a mutant with no coverage, a static mutant, a pattern that matched nothing) runs those
   same files, and a targeted run is narrowed to the covering tests' files among them, so tests
   outside your selection never run. An empty list counts as not set. The selection is shared
   with the other workers through the dry-run registry.
2. **`bun.testFiles`**, used as given.
3. **Auto-discovery**, described below.

If both Stryker's `testFiles` and `bun.testFiles` are set and select different files, the runner
warns once and uses Stryker's. Stryker's debug log names the source the dry run used
(`Dry run test files: <N> from <source>`).

### Auto-discovery

Discovery follows `bun test`'s own rules (measured on Bun 1.4.2), so it picks up exactly what a
plain `bun test` would, and hands bun an explicit, sorted list so the order is stable:

- File names ending in `.test.`, `_test.`, `.spec.` or `_spec.` followed by `js`, `jsx`, `ts`,
  `tsx`, `mjs`, `cjs`, `mts` or `cts` (case-insensitive).
- `node_modules` and dot-directories (`.git`, `.stryker-tmp`, ...) are skipped. Other
  directories, `dist` and `build` included, are searched.
- `[test].root` from your bunfig is respected: the search starts there (resolved against the
  project directory). Bun ignores `root` for files passed on the command line, which is why the
  runner applies it itself. `[test].pathIgnorePatterns` is applied by bun even to listed files,
  so it keeps working.
- A symlinked directory or file is followed unless its real path is inside `node_modules`,
  `.stryker-tmp` or `.git`.

Because `dist` and `build` are searched, a project whose TypeScript build emits compiled tests
(for example `dist/**/*.test.js`) gets those copies run too: slower, and a stale compiled test can
fail the dry run. The runner keeps parity with `bun test` and warns once when auto-discovery finds
a test file below a `dist` or `build` directory. To leave them out, set `[test].root` (for
example `root = "./tests"`), add the directory to `[test].pathIgnorePatterns` (for example
`pathIgnorePatterns = ["dist/**"]`), or list your tests in `bun.testFiles`.

If discovery finds nothing, the runner warns and passes no file list, so bun discovers the tests
itself.

### Files are passed as exact paths

`bun test` takes an argument that starts with `/`, `./` or `../` as a path (that file, or every
test file below that directory, run in the order given) and any other argument as a substring
filter, run in bun's own directory-scan order. The runner therefore passes every test file as an
absolute path. For `bun.testFiles` this means: files and directories work, a bare name fragment
is not a filter (bun fails with "had no matches"), and a relative path does not also match a
copy elsewhere, such as under `dist/`.

### The command-line budget

A full-suite run on a large project lists every test file, and the operating system limits the
command line plus the environment (macOS: 1 MiB). The file arguments get a budget of 128 KiB
(131,072 bytes). Past it, the runner passes the shorter `./`-relative paths, which bun also
treats as paths and runs in order (logged once at debug). If even those do not fit:

- auto-discovered files are not listed at all, so bun finds and runs every test file itself, in
  its own order (logged once at info). A targeted run keeps its `--test-name-pattern`, so only the
  covering tests run;
- files you chose with `bun.testFiles` or Stryker's `testFiles` are still passed, with a warning
  that spawning bun may fail with `E2BIG`. List directories instead of individual files.

## Mutant runs

For each mutant, Stryker tells the runner which tests covered it in the dry run. The runner then:

1. **Selects the covering tests** with a `--test-name-pattern` built from their exact bun names
   (from the dry-run registry), and passes bun only the files those tests live in. A pattern over
   100,000 UTF-8 bytes would risk the operating system's argument limits, so the runner runs the
   full suite instead.
2. **Orders the files: cheapest first, and a static mutant's likeliest killers before that.** The
   dry run records how long each test file took (the sum of its tests' durations as bun reports
   them; time spent loading the file or in `beforeAll` hooks is not counted) and shares it through
   the registry. Every mutant run hands bun its files in ascending order of that time: the
   covering files for a targeted run, every file for a full-suite run. With bail, a fast unit test
   usually kills the mutant before a slow integration file even loads. Files with the same time
   keep their alphabetical order; files with no recorded time go last.

   A planned full-suite run (a static mutant, a mutant with no coverage, or a run scoped to
   Stryker's `testFiles`) that bails then moves the files likeliest to kill its mutant to the
   front. Most files of a full suite never call into the mutated module, and under cheapest first
   a killed static mutant typically ran a third of the suite before the file that killed it. The
   ranks, in this order (files that rank the same stay cheapest first):
   - **The mutant's own coverage**: the files whose tests executed this mutant in the dry run. The
     dry run records which mutants each test file's tests executed, from the raw per-test coverage,
     so a static mutant's per-test hits count even though the coverage handed to Stryker drops
     them. The registry holds it as a table of test files plus, per mutant, the indices of its
     files.
   - **The source file's coverage**: then the files whose tests executed more of the mutated source
     file's other mutants, usually the module's own unit tests. The runner reads a source file's
     mutant ids from its instrumented copy in the sandbox, once per worker.
   - **Name**: then the test file named after the source file (`src/foo.ts`, `foo.test.ts`).

   Everything else keeps cheapest first: targeted runs (their files all executed the mutant, and
   on the benchmark fixture fewer than 3% of killed targeted mutants needed a second file), the
   full-suite fallbacks below (Stryker sized their deadline for the covering tests only, so moving
   a slower file ahead of the killer could turn a kill into an inconclusive Error), and runs with
   `disableBail` (every file runs whatever the order).

   **What the order can and cannot change.** The runner assumes an order-independent suite: each
   test file passes or fails under a mutant whatever ran before it in the same process. (A suite
   that leaks state between files, such as a `mock.module()` that is never restored, is a bug in
   the suite; see below.) Under that assumption:
   - *A mutant that every file survives stays Survived.* Only a failure (bail), a hang (the
     deadline) or the hit limit stops a run early. If no file fails, every file runs in any order,
     the same tests pass, and the run takes the same total time against the same deadline. A
     reorder never runs fewer files when nothing fails.
   - *A detected mutant stays detected, as Killed or Timeout.* When some file fails, hangs or trips
     the hit limit, every order stops at the first such file it reaches, and which one that is can
     change the verdict between Killed and Timeout:
     - one file fails a test and another hangs or loops: whichever runs first decides;
     - files that pass but run slowly: the deadline is for the whole run, so reaching the killer
       later can let the deadline fire first (Timeout), and earlier the reverse;
     - the hit counter is cumulative over the run: passing files that execute the mutant add to
       it, so a different set of them before the killer can trip the limit sooner or later;
     - bun's per-test timeout (`[test].timeout`) against the runner's deadline: an awaited hang
       is a failing test (Killed) if bun's timeout fires first and a Timeout if the deadline does,
       so when the hanging test starts matters.
   - *The exception: a mutant that crashes bun or exits the process.* If the mutant makes one file
     crash bun (a signal) or call `process.exit()`, and another file kills it, the order decides
     which ends the run. A crash, or an exit (with any code) with no failing test, is Error; never
     Survived. Any order has this exposure, cheapest first included: it needs a
     mutant that drives the code under test into a crash or an exit, which a normal test never
     reaches.
3. **Turns randomized order off.** `[test].randomize` (and `[test].seed`, or `--randomize` and
   `--seed` in `bun.bunArgs`) shuffles both the file order and the test order within each file.
   The dry run keeps your setting, so order-dependent tests still show up there. Mutant runs turn
   it off, so a mutant's verdict never depends on a random order: they use a copy of the
   sanitized bunfig with `randomize = false` and no `seed` (bun has no flag that turns randomize
   off), and `--randomize`/`--seed` are removed from their `bun.bunArgs`. The runner says so once
   at debug.
4. **Bails on the first failing test** unless Stryker's `disableBail` is set. Dry runs never bail.
   A bail flag in `bun.bunArgs` (`--bail`, `--bail=<N>`, `--bail <N>`) is removed: bail is
   decided by `disableBail` alone.
5. **Hides passing tests.** The mutant-run copy of the sanitized bunfig also sets
   `onlyFailures = true`, so bun prints no line for a passing, skipped or `todo` test. A mutant run
   is scored only from what still prints: the failing tests with their file headers, bun's summary
   counts, the `Ran N tests` and `Bailed out` lines, the zero-match error, `# Unhandled error
   between tests` blocks, and whatever the tests and the coverage preload print themselves (bun
   prints a file's header before them too). On a 165-file suite that cuts a full run's stderr from
   126 KB to 115 bytes and makes its `bun test` about 36 ms faster (bun 1.4.2). The dry run prints
   every test.
6. **Runs the child** with the mutant active, under the time limit described in
   [Timeouts](#timeouts) and Stryker's hit limit.

Because mutant runs order files by kill likelihood and cost rather than in the dry run's order,
and two mutants' runs may order the same files differently, a suite whose test files depend on
each other's order may behave differently in mutant runs. The usual cause is a
`mock.module()` (or another global change) in one file that leaks into the files bun runs after
it in the same process. Fix such leaks (restore the mock in `afterAll`, or avoid module mocks in
files that share a process) rather than relying on file order. With bail, `killedBy` names the
first failing test, so which test it names depends on the order too.

**Zero-match retry.** A `--test-name-pattern` can match no test at all, usually because the mutant
changed a value interpolated into an `it.each` title. Bun then exits with an error. The runner
retries once with the full suite rather than scoring a false kill. If the retry also matches
nothing, or there was no pattern to retry, the mutant is scored Error. A partial miss (some
alternatives match, others do not) exits 0 with no message from bun; the `no exact-name registry
available` and `missing from exact-name registry` warnings are the only sign that one was possible.

**Full-suite fallbacks.** A mutant that had covering tests but ran the whole suite (pattern too
long, or the zero-match retry) is a full-suite fallback. The end-of-run summary counts them.

**Stryker's `testFiles` option.** With it set, Stryker gives static and no-coverage mutants a
list of test file paths (inside the sandbox) instead of test ids, and sizes their timeout for
those files. The runner recognises that shape (no entry is a known test id, and every entry is
an existing test file), runs exactly those files without a `--test-name-pattern`, and scores a
run stopped at the deadline as a normal Timeout.

## How results are scored

| What happened in the mutant run | Result |
|---|---|
| One or more tests failed and could be matched to dry-run tests | **Killed**, `killedBy` lists them |
| A test file failed to load: bun printed `# Unhandled error between tests` and a non-zero fail or error count (` 1 fail`, ` 1 error`, `Bailed out after 1 failure`), but no failing test | **Killed**, empty `killedBy` |
| Tests failed but none could be matched to a dry-run test | **Killed**, empty `killedBy` (warned) |
| Every selected test passed: exit 0 and bun printed its summary | **Survived** |
| Exit 0 with no summary (a test, hook or module called `process.exit(0)`), after a failing test that matches a dry-run test was reported (possible without bail) | **Killed**, `killedBy` lists the failing tests |
| Exit 0 with no summary and no failing test that matches a dry-run test | **Error**, reason `bun exited 0 before running every selected test: ...` |
| The active mutant exceeded Stryker's hit limit | **Timeout**, reason `Hit limit reached (count/limit)` |
| The runner killed the child at its time limit, or for exceeding `bun.maxChildRss` | **Timeout** |
| A full-suite fallback was killed at the limit Stryker sized for the covering tests only | **Error** (`inconclusive timeout`) |
| The child died from a signal (SIGSEGV, an out-of-memory SIGKILL, ...) and no failing test could be matched to a dry-run test | **Error** |
| The child could not be started (for example `spawn bun ENOENT`) | **Error** |
| Non-zero exit with no failing test and no fail or error count (a missing preload, an unreadable bunfig) | **Error** |
| `--test-name-pattern` matched 0 tests, after the full-suite retry or with nothing to retry | **Error** |

Stryker shows Error as RuntimeError and leaves it out of the mutation score. Each Error is logged
at warn (see [Log output](#log-output)).

**Coloured output.** `FORCE_COLOR` set where Stryker runs reaches every `bun test` child, and bun
then colours its output even when piped, printing `✗ name` for `(fail) name` with colour codes
around both. The runner removes colour codes from each line before reading it, so failing tests,
file headers and the summary read the same with or without colour, and so do `killedBy`, the
reason below, and every result above.

**The reason given for a kill.** A Killed mutant's reason (`statusReason` in Stryker's reports, shown
for the mutant in the HTML report) is the report bun printed for each failing test: the code frame,
the error, the expected/received diff and the stack. Bun prints that report *before* the test's
`(fail)` line, so the runner takes the lines between the previous file header, test line or failing
test and the `(fail)` line, starting at the code frame (or, without one, at the first `error:` or
`…Error:` heading) so that whatever a test printed on stderr before failing is left out. A note bun
prints right *after* the `(fail)` line is added to it: `^ this test timed out after 5000ms.`, and the
note for a `.failing` test that passed. When the lines before such a note hold no code frame and no
error heading (a timed-out test after other tests' output), the note alone is the reason. Each
test's report is cut at 4,000 characters, before its notes are added, so a note is never cut; the reports of
several failing tests (a run without bail) are joined with a blank line. A Killed run with no
failing-test report, such as a test file that failed to load, gives the first 1,000 characters of
bun's stderr instead.

**Why load failures are Killed.** A mutant can stop a test file from loading: a source module
throws at import (a mutated module-level constant or config object, say), a source file no longer
parses, or a `describe` body throws. Bun reports that only in its summary. Stryker only mutates
source files, and the dry run, which must pass, loaded every one of those files without error,
so the load failure came from the mutant. Stryker's jest and vitest runners score a test file
that fails to load the same way. The residual risk is a test file that only loads after some
other file has run: a targeted run passes bun only the covering tests' files, so such a file fails
here and not in the dry run. That is a test-isolation defect, as it would be under jest.

**Why crashes are Error.** A signal death or a failed spawn is not evidence that a test caught the
mutant, so it scores Killed only when a failing test was reported and matched to a known test.

**Why an early exit 0 is Error, not Survived.** Bun prints its summary (` N pass` through
`Ran N tests across M files`) only after the last file has run. It does so on every run that gets
that far, with `onlyFailures`, a `-t` pattern, `--dots`, junit and the AI-agent reporter alike, and
the dry run already fails when the summary is missing (see
[The completeness gate](#the-completeness-gate)). When a test, a hook or a module at load calls
`process.exit(0)`, bun 1.4.2 exits 0 and prints nothing more, not even the count of the tests that
already passed. So exit 0 without a summary means the selected tests after that point never ran:
the mutant changed what the suite does, and the run is not Survived. With no failing test it is
scored as the other early terminations are (a non-zero exit with no failing test, a signal death),
Error, since no test is known to have failed; a failing test reported before the exit makes it
Killed, but only when it matches a dry-run test (as for a signal death, a failing-test line that a
test printed itself is no evidence).
The runner checks for the summary, not its count: the count legitimately falls short of the
selected tests (a `-t` alternative that matches nothing, skipped, pending and `.only`-filtered
tests), while a missing summary is never part of a complete run.

## Timeouts

Stryker gives every mutant run its own timeout: `timeoutFactor` × the dry-run time of the tests
it plans to run for that mutant + `timeoutMS` + the dry run's overhead. For an ordinary mutant
those are its covering tests; for a static mutant, the whole suite. Stryker enforces that timeout
itself, and when it fires it restarts the whole worker process, which costs about a second.

The runner therefore kills a mutant run's `bun test` child slightly earlier and reports the
Timeout itself: at Stryker's timeout minus the larger of 750 ms and 5%, with the margin never more
than 25% of the timeout, so a very small `timeoutMS` still leaves the run three quarters of its
budget. The 750 ms covers the runner's 500 ms SIGTERM-to-SIGKILL grace period. The budget starts
when `mutantRun` is called, and a zero-match retry gets only what is left of it, because Stryker's
timer covers both runs.

`bun.timeout` (default 10,000 ms) bounds the dry run. The dry-run child is killed at
`bun.timeout` + 30 s, the extra 30 s being the drain handshake's ceiling. The runner warns when a
completed dry run used more than 80% of `bun.timeout`. Mutant runs use `bun.timeout` only when
Stryker supplies no usable timeout. `bun.timeout` is not Bun's per-test `[test].timeout`, which
is independent: a test that exceeds `[test].timeout` fails (in the dry run, Stryker then stops on
the failed test).

One case cannot be scored reliably. When the runner falls back to the full suite for a mutant
that has covering tests, Stryker's timeout was sized for those covering tests, not the full
suite. A full suite that is merely slower than that budget looks the same as a mutant that
hangs, and the runner cannot extend Stryker's timer. Such a run is scored Error, not Timeout, so
it does not inflate the score, and is logged at warn as `inconclusive timeout`. If you see it
often, raise Stryker's `timeoutMS` or `timeoutFactor`.

## Infinite loops: the hit limit

Most mutants that hang loop forever (`i++` becomes `i--`, a loop body becomes `{}`). The runner
supports Stryker's infinite-loop protection, so such a mutant is usually stopped within
milliseconds instead of running until the timeout.

- **Real hit counts.** The dry run records how many times each mutant executed, per test and
  outside tests, and reports those counts to Stryker. Stryker sums them per mutant and gives each
  mutant run a hit limit of 100 × that sum. When the runner moves a mutant's coverage (for example,
  a mutant that also runs at module load is reported as static), its hits move with it, so the sum
  does not change.
- **Enforcement.** For a mutant run, the coverage preload sets `__stryker__.hitCount = 0` and
  `__stryker__.hitLimit` in the child. Stryker's instrumented code counts every execution of the
  active mutant and throws `Stryker: Hit count limit reached (N)` once the count exceeds the limit,
  which breaks the loop.
- **Scoring.** The preload writes a `__STRYKER_HIT_LIMIT_REACHED__ <token> <count>` line to the
  child's stderr the moment the limit is exceeded; it cannot wait for the end of the run, because
  `--bail` exits without running `afterAll` hooks. `<token>` is a random 128-bit value the runner
  generates for each child and passes in `__STRYKER_HIT_LIMIT_TOKEN__`; the preload removes that
  variable from `process.env` before any test code runs, and the runner ignores a line without the
  matching token, so a test that prints a line of the same shape cannot turn a surviving mutant
  into a Timeout. The run is scored Timeout with the reason `Hit limit reached (count/limit)`, as
  Stryker's jest, vitest, mocha and tap runners do, whether the error failed a test, a test caught
  it, or the run was killed anyway.

A loop that is merely hot is not affected: a mutant has to run 100 times more often than in the
whole dry run before it is stopped. A mutant that loops forever without passing through its own
mutant switch on each iteration still runs until the timeout, as does any run where Stryker
supplies no hit limit (for example with `coverageAnalysis: 'off'`).

In a small project with 7 such mutants, a full Stryker run took 4 s instead of 18 s with identical
results. A single `i++` to `i--` mutant took about 0.7 s instead of about 4.7 s with Stryker's
default `timeoutMS`.

## Your bunfig.toml: the sanitized config

At startup the runner reads your project's `bunfig.toml` (if present), or the file named by
`--config`/`-c` in `bun.bunArgs` (which must then exist), and writes a sanitized copy that it
passes to every `bun test` child with `--config`. `--config` replaces your bunfig rather than
layering on top of it, so:

- **Everything outside `[test]` is copied unchanged**: `[install]`, `[loader]`, `define`, `jsx*`,
  `[macros]`, `[run]`, `smol`, `logLevel`, `telemetry`, a top-level `preload`, and any key this
  plugin has never heard of. (Bun 1.4.2 does not run a top-level `preload` for `bun test`, only
  `[test].preload`; use `[test].preload` to register a Bun plugin for your tests.)
- **`[test]` is rebuilt from an allowlist**: `preload`, `root`, `pathIgnorePatterns`, `timeout`,
  `smol`, `randomize` and `seed` are forwarded; any other `[test]` key is dropped and logged at
  debug with the reason. If you need another `[test]` key forwarded, please open an issue.
- **Forced off**: `coverage = false` and `onlyFailures = false`. A `coverageThreshold` miss makes
  bun exit 1 even when no test fails, which would be mistaken for a mutant kill, and the dry run
  reads every test's result. Mutant runs set `onlyFailures = true` themselves (see below).
- **Dropped with a warning**: `retry` and `rerunEach`. Bun then runs with no retry and no rerun.
  They re-run tests, which multiplies the cost of every mutant run and repeats test names, so a
  `killedBy` test cannot be resolved to one test; neither can improve a mutation score. A per-test
  `{ retry: N }` in test code cannot be controlled by the runner and still applies.
- **A copy for mutant runs**: next to the sanitized file, with `.mutant-runs.toml` in place of
  `.toml`, the same except `onlyFailures = true` and, when `randomize` or `seed` turns
  randomization on, `randomize = false` and no `seed` (see [Mutant runs](#mutant-runs)).
  Randomization applies to the dry run only. A copy is needed because the sanitized file's
  `onlyFailures = false` wins over a `--only-failures` flag, and bun has no flag that turns
  randomize off.
- **Paths**: relative `preload` (top-level and `[test]`) and `[test].root` paths are made absolute,
  anchored at the project (sandbox) directory. Bun resolves relative bunfig paths against its
  working directory, not the bunfig's location, and the sanitized file lives in the temp directory.

Your `[test].preload` files run first, then the runner's coverage preload.

## The dry run in detail

### The start handshake

The coverage preload starts no test until the runner sends `ready` over the sync socket, and the
runner sends it only once its inspector is connected, `TestReporter.enable` has been answered, and
its drain handler is registered, so every test event from then on is observed. The preload waits
for `ready` with no deadline of its own, however slow the machine; the runner's side is bounded
instead. Waiting for bun's inspector URL, connecting the inspector, and `TestReporter.enable` are
each bounded by `bun.inspectorTimeout`. When one of them fails, the dry run fails at once and the
child is stopped: killed, or, when the runner still wants its output for the error message, told
to exit by closing the sync socket. If the sync socket fails or closes before `ready`, the preload
exits without running a test and the dry run fails with a message saying so. The inspector-URL
wait is event-driven: it ends the moment bun prints the URL, the child exits, or
`bun.inspectorTimeout` passes.

### The drain handshake

When the tests are done, the child does not exit straight away. Its final `afterAll` writes the
coverage file, then sends `drain-request` on the sync socket and waits for `drained`. The runner
answers only after a `TestReporter.enable` round trip on the same, ordered inspector connection
the test events arrive on succeeds, which proves it has received and processed every event the
child sent. Without this, a runner that fell behind on a busy machine would lose whatever it had
not processed when the child exited. A `drain-request` that arrives before the runner's drain
handler is registered is queued and answered once the handler is in place.

The runner's wait is progress-based: it keeps waiting while the inspector connection is still
receiving frames of any kind, and gives up only after 4 s of complete silence, or at an absolute
ceiling of 30 s. Either way it then sends `drained` at once, so the child is released rather than
left to time out. The child's own fallback (40 s, above the runner's ceiling) only matters when
the sync channel itself is dead. After the child exits, the runner gives the inspector socket up to
1 s to finish closing before it reads the collected data. These bounds are fixed; there are no
options for them.

Mutant runs are not held open this way: they run small, filtered subsets, and the completeness
gate does not apply to them.

### The completeness gate

A dry run produces three records of the same run: bun's console summary, the inspector's
`TestReporter` events, and the coverage preload's per-test keys (one each time a test starts).
Before reporting the dry run Complete, the runner compares them **exactly**, with no absolute or
percentage slack, because a single lost event is enough to credit coverage to the wrong test or
drop it, and Stryker would then score those mutants wrongly without saying so. Any unexplained
difference fails the dry run with `stryker-bun-runner: dry run data-completeness check failed — `
followed by every problem found, joined by `; `. The test registry is not persisted, so other
workers cannot load a corrupted one. The gate only runs when no test failed; a dry run with
failing tests is reported as such, and Stryker stops on it.

| Problem in the message | What was lost | Likely cause |
|---|---|---|
| `bun's summary counts <N> <passing, skipped or todo> test(s), but the Bun inspector reported <M>` | test events: some tests bun ran never reached the runner, or two were merged | inspector events lost between bun and the runner, or bun reused a test id |
| `<N> test(s) started but never reported a result` | `TestReporter.end` events | the same |
| `<N> test(s) reported a pass or fail result without a TestReporter.start event` | `TestReporter.start` events, so those tests' coverage cannot be paired with them | the same |
| `the coverage preload recorded <N> per-test coverage key(s), one per test run (retries included), but the Bun inspector reported <M> test start(s)` | the pairing of coverage with tests | a lost start event, or a coverage key recorded by something other than the preload |
| `<N> of <M> per-test coverage key(s) matched no test the inspector reported` | that coverage | the same, or a whole test file missing from the inspector stream |
| `coverage was recorded under <N> test id(s) that this dry run does not report as tests` | coverage Stryker would ignore | a naming disagreement inside the runner: please report it |
| `<N> TestReporter.found event(s) reused a test id already seen` | a test merged into another under one id | Bun's `TestReporter` id collision |
| `<N> test(s) or describe block(s) name a parent describe block whose TestReporter.found event never arrived` | the describe path of those tests' names, which mutant runs need to select them | a lost `TestReporter.found` event |
| `bun's console summary reported <N> failing test(s), but none of them could be attributed to an individual test` | every failure in the run | a test file that fails to load, such as an unresolvable import (the message includes the end of stderr) |
| `bun printed no test summary (no ' N pass' or ' N fail' lines): the test process most likely exited before it finished` | every test after the point where the process left, and their coverage; when this applies it is the only problem listed | a test or hook called `process.exit`, or the process crashed |
| `<N> test(s) ended with a status this runner does not recognise` | those tests' results | a Bun release whose inspector protocol reports a status this runner does not know: please report it |

When the inspector socket also closed before the runner expected it, the message adds that as
context; on its own that is routine and never fails a dry run. If a cause is in your suite, fix
it there; otherwise re-run, since a loss caused by load on the machine does not recur. If it does
recur, please open an issue with the message, your Bun version and a debug log
(`logLevel: 'debug'`).

Each comparison accounts exactly for what makes the records differ on healthy runs, as observed
with Bun 1.3.7, 1.3.14 and 1.4.2:

- skipped and todo tests (`test.skip`, `skipIf`, `if(false)`, `describe.skip`, `test.todo`) get an
  end event but are never started and record no coverage key, and bun counts them on their own
  summary lines, so counts are compared per status;
- a todo test that `bun test --todo` runs is started and records a key;
- a retried test (`{ retry: N }`) is started, and records a key, once per attempt but is counted
  once, so keys are compared with starts and statuses with distinct tests (its attempts' coverage
  is merged into its one result);
- tests that `.only` filters out are reported as found but never started or counted;
- `test.each` and `describe.each` rows, duplicate titles, `test.failing`, `test.concurrent`, tests
  defined in a shared helper module, `--randomize`, `--isolate`, `--dots`, `--only-failures`,
  `--reporter=junit` and `FORCE_COLOR` (whose colour codes are stripped before the summary is read)
  all complete normally.

The runner reads the counts only from bun's own summary block (the lines from ` N pass` to
`Ran N tests across N files`), so a test that logs a line that looks like a summary line, such as
` 3 skip` or `Ran 9 tests`, cannot change them. A test that exceeds its timeout ends with the
inspector status `timeout`, which bun counts as a failure, and the dry run reports it as a failed
test. Coverage recorded while no test is running (module load, `beforeAll`, or between tests) goes
to Stryker's static coverage, which runs every test for that mutant, so it is never lost.

### Coverage checks

Without coverage data from the dry run, Stryker runs the full test suite for every mutant, which
can turn minutes into hours, and it does not say why. So the runner checks what it collected:

- **No coverage data** (the file the preload writes at the end of every dry run was missing,
  unreadable or empty): with `coverageAnalysis: 'perTest'` this fails the dry run; with `'all'` it
  is a warning; with `'off'` nothing is checked. Likely causes: the coverage preload never ran
  (something in `[test].preload` or `bun.bunArgs` replaces or bypasses it), the temporary
  directory is not writable, or the child exited before its final `afterAll` (a test calls
  `process.exit`). A dry run with failing tests skips this check.
- **Coverage that covers no mutant**: every mutant would be NoCoverage, so the runner warns,
  naming your `mutate` globs.
- **The preload's own `[Stryker Coverage] ...` diagnostics** (for example a failed coverage write)
  are surfaced at warn, since bun's stderr is otherwise not shown for a passing dry run.

### Coverage bleed

During the dry run the preload notices mutant coverage recorded in the gap between one test's
`afterEach` and the next test's `beforeEach` in the same file, while no test is running, and the
runner warns: `mutant coverage was recorded between tests, after '<testName>' completed`. The
likely cause is a fire-and-forget promise chain (or other async work) started by that test and
still running after it ended. A same-file `beforeAll` or fixture running in that gap looks the
same and triggers it too, so check for one before assuming a leak. The warning never changes a
result; the fix, when it is a real leak, is to `await` the work before the test ends. At most 25
are logged, then `...and <N> more coverage-bleed warning(s) suppressed`.

### Inspector diagnostics

A healthy dry run is quiet about the handshakes at warn. The detail is at debug
(`Drain-request received`, `Drain handler settled via ...`, `Post-drain inspector snapshot`,
`Post-drain inspector close/collision diagnostics`): how the drain settled (`ack`, `silence`,
`ceiling` or `send-rejected`), the event counts seen during the wait, any gaps in bun's test ids,
the WebSocket close code, reason and timing, and raw versus unique `TestReporter.found` counts.

At warn, the dry run logs one `Inspector data looks abnormal after the dry run:` line, only when
the drain did not settle via `ack` (or never happened), gaps in the found ids remain, or a found id
was reused (the Bun `TestReporter` id-collision bug, in which two interleaved id sequences merge two
tests under one id; on an otherwise passing run the completeness gate also fails it). The
WebSocket close code is not a condition: bun closes the inspector socket with code 1006 (`wasClean`
false, reason `Connection ended`) a few milliseconds after the drain acknowledgment on every
healthy run. A close with reason `ERR_WEBSOCKET_TIMEOUT` mid-run, on a roughly 252-second cadence,
points at a separate Bun bug where `idleTimeout: 0` websockets are closed on a ping cycle.

`Inspector request unanswered after <N>ms even though other frames are still arriving` (warn)
fires when an inspector request goes unanswered for 2 seconds while other frames keep arriving: a
protocol-level stall, distinct from total silence.

## Log output

### Start and end summaries

Each Stryker worker logs a start line at `debug` and an end line at `info`, and nothing else at info for individual mutants:

- **Start**, at `debug` (shown with `--logLevel debug`), once per runner at the end of `init()`.
  It is not `info` because every worker process logs its own copy, which at high concurrency looks
  like many dry runs; the dry run itself happens once, on one worker:
  `Bun test runner started: bun <version> at <bunPath>; <N> test file(s) from <source>; sanitized bunfig <path>[; bail on|off]`.
  `<source>` is `auto-discovery` or `bun.testFiles`; Stryker's `testFiles` option only arrives with
  the dry run, which names its source in the debug log. When discovery finds no files the line says
  `no test files found by the runner, bun will discover them itself`. The `bail` part appears when
  Stryker passes `disableBail`: `bail off` if it is set, `bail on` if not.
- **End**, at `dispose()`, for a worker that ran at least one mutant:
  `Mutant runs on this worker: <N> (killed <K>, survived <S>, timeout <T>, error <E>); full-suite fallbacks: <F>`.

### Repeated warnings are aggregated

A per-mutant warning can repeat for thousands of mutants. Each kind is logged in full at warn the
first time it occurs in a worker, so the strings to grep for still appear. Later occurrences go to
debug with the same text, and at `dispose()` the runner adds one summary warn per kind that
affected more than one mutant:

```text
<kind>: <N> mutants affected (first: <id>, <id>, … up to 5 ids); see debug log for details
```

| Kind (as the summary names it) | First warn |
|---|---|
| `--test-name-pattern matched 0 tests (retried with the full suite)` | `Mutant <id>: --test-name-pattern matched 0 tests — ... retrying once with the full suite` |
| `--test-name-pattern matched 0 tests with no covering tests left to retry` | `Mutant <id>: --test-name-pattern matched 0 tests with no covering tests left to retry — not a kill` |
| `no exact-name registry available (lossy covering-test patterns)` | `Mutant <id>: no exact-name registry available — ...` |
| `testFilter ids missing from exact-name registry (lossy fallback)` | `Mutant <id>: <N> of <M> testFilter ids missing from exact-name registry ...` |
| `bun test terminated by a signal, scoring as Error rather than Killed` | `Mutant <id>: bun test terminated by <SIGNAL> ... — scoring as Error rather than Killed` |
| `could not start bun test, scoring as Error rather than Killed` | `Mutant <id>: could not start bun test: <error> — scoring as Error rather than Killed` |
| `bun test exited non-zero with no failing test and no fail/error count, scoring as Error rather than Killed` | `Mutant <id>: bun test exited with code <N> but reported no failing test and no fail/error count — scoring as Error rather than Killed` |
| `bun test exited 0 before printing its summary, scoring as Error rather than Survived` | `Mutant <id>: bun exited 0 before running every selected test: ... — scoring as Error rather than Survived` |
| `inconclusive timeout, scoring as Error rather than Timeout` | `Mutant <id>: inconclusive timeout, scoring as Error rather than Timeout` |
| `failed test names could not be resolved to dry-run test ids` | `Mutant <id>: <N> failed test name(s) could not be resolved to dry-run test ids ...` |
| `no killing test identifiable, emitting empty killedBy` | `Mutant <id>: no killing test identifiable — emitting empty killedBy` |
| `bun test child exceeded maxChildRss, reporting a timeout` | `bun test child exceeded maxChildRss (<N> bytes observed) during mutant run <id>` |
| `dryRun registry file has an unexpected version (skipped)`, `dryRun registry file is malformed (treated as absent)`, `failed to load the dryRun registry file` | a worker that never ran the dry run could not use the shared registry; it retries on every mutant |

The signal and no-evidence warnings include the first 600 (signal) or 500 (no evidence) characters
of bun's output, which in a mutant run lists no passing test (see [Mutant runs](#mutant-runs)). The
early-exit warning includes the last 500 characters of its output (stdout, then stderr), which show
where the exit happened.
Run Stryker with `logLevel: 'debug'` (or `--logLevel debug`) to see every occurrence.

## Temporary files

The runner's temporary files (the coverage preload script every `bun test` child executes, the
list of mutated modules beside it that the dry run imports before any test, the coverage data file, the sanitized bunfig and its mutant-run copy, and the dry-run test registry)
live in one directory per Stryker run, private to the user running Stryker:

```text
$TMPDIR/stryker-bun-runner-<uid>-<space>-<pid>-<hash>-<n>/
```

`$TMPDIR` is the OS temp directory (`os.tmpdir()`, usually `/tmp`), resolved to its real path.
`<pid>` is the Stryker main process's pid, and `<hash>` is derived from the Stryker sandbox
directory and that pid. `<space>` says which processes that pid can refer to: on Linux it is
derived from the boot id and the pid namespace, so containers that share a temp directory get
different values; elsewhere it is a constant. Every worker is a direct child of the main process, so every worker of one
run finds the same directory, including workers recycled by `maxTestRunnerReuse`, while separate
runs, also concurrent ones in the same project, get separate directories. The directory is created with
mode `0700` and its files with mode `0600`; a file is always created fresh (a stale file or a
symlink at its path is removed first, never written through), and the coverage file is opened with
`O_NOFOLLOW`.

The name is predictable (the pid shows in `ps`, and with `--inPlace` the sandbox directory is your
project), so another local user can create it first. The runner never uses a directory that is not
yours (a symlink, owned by another user, or accessible to group or others): such a directory is
skipped. `<n>` is the first of 16 numbered candidates (`-0` to `-15`) that is yours or that the
runner could create, and all workers of a run settle on the same one. Only if all 16 are unusable
does the run stop.

The runner also checks every directory above it, up to `/`, and **refuses to run** if any of them
would let another user rename the run directory away and put their own in its place: one owned by
someone other than you or root, one writable by group or others without the sticky bit that `/tmp`
has, or a symlink. Another user could otherwise swap the preload script and run their code as you.
This matters when `TMPDIR` points somewhere other than `/tmp`, such as a shared scratch area. The
error, `stryker-bun-runner: refusing to use temporary directory ...`, names the directory at fault.
Delete it if it is a stale run directory you trust, or set `TMPDIR` to a directory that only you and
root control.

### When the directory is removed

Each worker removes its own files on `dispose()`, but no worker removes the directory or its
`registry.json`, because none can tell whether it is the last one. Stryker restarts a worker (for
`maxTestRunnerReuse`, after a timeout, or after a crash) by disposing and killing it first and only
then forking its replacement, which loads the registry. With `concurrency: 1` no worker is alive in
between, so a "last one out" rule would delete the registry from under the next worker. Late workers
need it too: with checkers configured, Stryker starts more workers once checking is done.

The directory is needed for exactly as long as the Stryker main process lives: only that process
forks the run's workers. So the main process removes it: Stryker's plugin loader imports the plugin
there too, and the plugin removes the run's directory when that process exits.

- **At the end of a run,** the main process disposes every worker before it exits (each gets 2 s
  to dispose, then is killed), so no worker is left.
- **On a signal** (Ctrl-C, `SIGTERM`), Stryker disposes the sandbox and calls `process.exit`
  without disposing the workers, so the directory is removed while workers may still be running.
  Their run is over all the same: nothing will take their results, and a `bun test` child that is
  mid-run may fail for the missing files. A worker remembers its parent at `init()` and, once that
  has changed, never creates the directory again, so an orphaned worker cannot leave a new one
  behind under its new parent's pid.

A run killed outright (`SIGKILL`, or a crash of the main process) runs no exit code and leaves its
directory behind. A later Stryker run removes it when it exits: on exit, the plugin also removes
every run directory of yours whose main process no longer exists and that has not changed for an
hour. Several things protect what is still in use:

- **Concurrent runs** never remove each other's directories, because their main processes are
  alive.
- **The hour** protects a live run whose pid only looks dead to the process judging it (see the
  assumption below). A working run changes its directory far more often: every worker start
  writes files there, and each worker refreshes the directory's modification time at least every 10
  minutes while it runs mutants. The exiting process's own directories go at once.
- **The checks.** Nothing is removed unless it passes the same checks as a directory the runner
  uses (a real directory, not a symlink, owned by you, mode `0700`, named for your uid). Nothing at
  all is removed if a directory above `$TMPDIR` fails the checks above. These run before the
  owner's pid is looked at.
- **A reused pid.** If a dead run's pid has been reused by another process, its directory stays
  until that process is gone too.
- **A cap.** At most 1000 run directories are examined per exit, the exiting process's own first.

The guarantee is per user: another user's files are never touched. The removal itself works by
path (Node's recursive `rm`), so another process running as you could race it, as it could anything
else of yours.

The pids in names are judged under one assumption: **one `<space>`, one process table.** Separate
process tables that share a `<space>` and a `$TMPDIR` break it. An example is clones of one VM
snapshot, which keep the boot id and the initial pid namespace. There, a live run's pid can look
dead from the other side, and only the hour protects it.

Some directories are never judged, because their `<pid>` says nothing to the process that would
judge them:

- A directory with another `<space>`, on Linux. That covers one from another container sharing the
  temp directory, one from an earlier start of the same container (a restarted container gets a
  new pid namespace, and with it a new `<space>`), and one from before a reboot. Only the OS's temp
  cleaning, or a reboot that clears `$TMPDIR`, removes these.
- On Linux without a readable `/proc` the runner cannot tell its own `<space>`, and removes nothing.
  Its directories get a `<space>` of their own that matches no other.
- Directories left by versions of the runner that did not put the main process's pid in the name
  (`stryker-bun-runner-<uid>-<hash>-<n>`). Nothing records whose run those were. Delete them by hand
  once no Stryker run is going.

`stryker serve` keeps directories longer: one long-lived main process runs many runs, so their
directories are removed when the server exits.

## Child processes

### Kills reach the whole process tree

Every `bun test` child is spawned detached, so it leads its own process group, and every kill
path (the time limit, an abort, the `maxChildRss` ceiling) signals that whole group: SIGTERM, then
SIGKILL 500 ms later if the child is still alive. This matters when your suite itself spawns
processes: signalling only the direct child would leave its grandchildren running, reparented to
PID 1, and a suite that starts a server or a database would leak one on every timed-out mutant. If
the group signal cannot be delivered, the runner signals the direct child.

A process your suite starts that leaves the group (with `setsid`, say) is out of reach of these
signals, and if it inherited the child's stdout or stderr it keeps them open after the child exits.
The runner waits at most 2 s after the child exits for them to close, then takes the run's result
with the output read so far; a dry-run error then says its stderr tail may be cut short.

A detached child is not in the terminal's foreground process group, so it does not die on its own
when you press Ctrl-C. The runner therefore traps `SIGINT`, `SIGTERM` and `SIGHUP`, kills every
live child's group, and re-raises the signal so the default behaviour is preserved.

### Orphan prevention

- **`dispose()` kills any run still in flight.** If Stryker disposes a runner while its `dryRun`
  or `mutantRun` has not finished (tearing down a stuck worker, say), the child is killed the same
  way.
- **A lifeline pipe covers a parent killed outright.** If the Stryker worker is killed with
  SIGKILL, no cleanup code runs at all. So every child is spawned with an extra pipe on file
  descriptor 3 (named to it in `__STRYKER_LIFELINE_FD__`), whose other end only the worker holds.
  The kernel closes every descriptor of a process that exits, however it exits, so the child's
  preload reads end-of-file the moment the worker is gone, prints
  `[Stryker] Parent process is no longer running — terminating to avoid an orphaned bun test process`
  on stderr, and exits. This is an I/O event, not a timer, so it works whatever the suite does
  with timers: Bun moves a real interval that ticks while `jest.useFakeTimers()` is in effect into
  the fake-timer queue, where it never fires again on its own, so a polling check would be lost in
  any suite that uses fake timers. No native addon or `prctl(PR_SET_PDEATHSIG)` is involved, and
  the processes a suite spawns do not inherit the pipe.
- **How the pipe is read.** The preload reads the lifeline through Bun's own file stream,
  `Bun.file(fd).stream()`, not Node's `fs.createReadStream`. On Bun 1.4.2 a Node read stream on
  the pipe costs every `bun test` child about 18 ms of CPU before its first test. That is more than
  a small mutant run's own work, and it is paid on every run: a trivial test file took 29.3 ms with
  it and 11.6 ms with Bun's stream, against 11.3 ms with no lifeline at all. On the benchmark
  fixture, switching readers took a whole Stryker run from 28.7 s to 22.8 s.
  - Whether Stryker runs on Node or on Bun, descriptor 3 is one end of a socketpair.
  - Bun reads a close-on-exec duplicate of descriptor 3, made when the stream opens (Bun 1.4.2).
    Closing descriptor 3 itself is therefore harmless, and processes the suite spawns do not
    inherit the duplicate.
  - What would break the watch is something in the process closing the duplicate's number, such
    as a helper that closes every descriptor from 3 up, or a double close. The read then hangs and
    the parent goes unwatched. If the number is reused, the child can see another descriptor's
    end-of-file and exit as if orphaned, or swallow that descriptor's bytes. Either takes a bug in
    the suite; the runner never touches the descriptor after the spawn.
- **Fallback.** If the lifeline is unavailable, the child falls back to polling its own
  `process.ppid` once a second on an unref'd interval. Unavailable means the descriptor cannot be
  opened (`EBADF`, `EISDIR`), or a read fails before end-of-file. The operating system reparents an
  orphan as soon as its parent exits, so a changed `ppid` means the parent is gone. That covers
  every suite that does not use fake timers. The fallback is silent unless the environment
  variable `STRYKER_BUN_RUNNER_DEBUG` is set to anything other than empty, `0` or `false` (in the
  environment Stryker runs in, or in `bun.env`); the child then writes one line to its stderr
  giving the reason.

To check the lifeline on a given machine, run `bun scripts/verify-orphan-lifeline.ts` from a clone
of this repository (see [CONTRIBUTING.md](../CONTRIBUTING.md#checking-orphan-prevention-on-a-machine)).

### Recursion containment

Each child carries its spawn depth in `__STRYKER_BUN_RUNNER_DEPTH__`, and a run at or beyond
`bun.maxSpawnDepth` (default 1) fails with a non-zero exit code and
`stryker-bun-runner: refusing to spawn \`bun test\` at nesting depth <N> (maxSpawnDepth=<M>)` on
stderr instead of spawning. The failure this prevents is real and not survivable:

- The runner can spawn `bun test` from inside a `bun test` it spawned.
- If a nested run falls back to auto-discovery while its working directory is the project root, it
  picks up the project's entire suite, including the test that spawned it.
- That test spawns again, and so on, a new generation roughly every second. Each generation leads
  its own process group, so killing one does not stop the chain.

Under mutation testing this is reachable through ordinary mutants: anything that defeats a
`bun.testFiles` override puts a nested run back on auto-discovery. The depth ceiling turns that into
one loud failure. The default allows the runner's own children and nothing deeper, which is right
for every project whose tests do not themselves drive this runner. If yours do (a test runs
`stryker run` on a fixture project, or creates a `BunTestRunner`), raise it to `2` on the runner
making the nested call, since that is where the ceiling is enforced: in the Stryker config that test
runs (`bun: { maxSpawnDepth: 2 }`), or in the options the test passes. Setting it in your own
`stryker.conf.mjs` only configures the outer run, which never reaches the ceiling.

## Memory

### Memory model

Each run's `bun test` child exits when the run ends, so its memory is fully reclaimed; there is no
accumulation across mutants in the child. What that means for planning:

- **Peak memory is roughly `concurrency` × the footprint of one run of your suite.** A suite that
  loads heavy dependencies at module scope (ML models, native bindings such as `sqlite`, document
  extractors) pays that footprint once per run, and Stryker runs `concurrency` of them at once:
  12 workers × a 2-3 GB footprint is 24-36 GB at peak, not a leak.
- **A mutant that breaks cleanup code (`dispose()`, `close()`, `finally`) still leaks within its
  own run**, and mutation testing tries every such mutant. The extra memory is held only until that
  run's process exits. Sound `afterAll`/`afterEach` cleanup in your tests keeps a single run's peak
  down; no runner option can substitute for that.
- **On a memory-constrained machine**: lower `concurrency` first (the largest, most direct effect);
  set `bun.smol: true` to shrink each child's JavaScriptCore heap at some cost to speed; set
  `bun.maxChildRss` as a backstop against one run growing unexpectedly; and use Stryker's
  `maxTestRunnerReuse` to recycle the Stryker worker processes themselves (a different, much
  smaller source of growth).

### Memory containment

`bun.maxChildRss` is a soft, polled ceiling: every `bun.rssCheckIntervalMs` (default 1000 ms) the
runner reads the child's resident set size (`/proc/<pid>/status` on Linux, `ps -o rss=` on macOS),
and if it exceeds the threshold, kills the child's process group and reports that run as a Timeout.
One runaway mutant then times out instead of dragging the machine into swap.

Why not a hard, kernel-enforced ceiling?

- `RLIMIT_AS` (what `ulimit -v` sets) caps virtual address space, not RSS. JavaScript engines
  reserve large virtual ranges up front (JIT code, WASM, guard pages), so a limit tight enough to
  matter for RSS stops the engine from starting.
- `RLIMIT_RSS` has not been enforced on Linux since kernel 2.4.30.
- cgroup `memory.max` is the right mechanism for a hard ceiling, but needs delegated cgroup access
  that developer machines, most CI runners and containers do not guarantee, and macOS has no
  equivalent.

If you need a hard ceiling, run Stryker itself inside a container or cgroup with a memory limit;
that composes with this runner.

## `maxTestRunnerReuse` compatibility

Stryker's [`maxTestRunnerReuse`](https://stryker-mutator.io/docs/stryker-js/configuration/#maxtestrunnerreuse-number)
disposes the test runner and kills the worker process hosting it after a set number of runs, then
forks a new worker in its place. That is the right lever for growth in the
long-lived Stryker worker, as opposed to the per-run `bun test` children, which are already
isolated. The runner tolerates recycling:

- `dispose()` removes the worker's preload script, coverage file, sanitized bunfig and registry
  temp file, and kills any run still in flight.
- A fresh runner that never ran the dry run still resolves `killedBy` names and builds exact test
  name patterns: it loads the shared dry-run registry from the run's private temp directory (see
  [Temporary files](#temporary-files)). A recycled worker is still a child of the same Stryker main
  process, so it finds the same directory, and the directory stays until that process exits.

```javascript
// stryker.conf.mjs
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  concurrency: 8,              // lower this first on memory-constrained machines
  maxTestRunnerReuse: 100,     // recycle each Stryker worker after 100 runs
  bun: {
    smol: true,
    maxChildRss: 1_500_000_000, // about 1.5 GB per bun test child
  },
};
```

## Test names and coverage attribution

- **Test ids** are `<test file> > <describe path> > <test name>`, with the test file relative to
  the project. Tests are sorted by id, so Stryker's incremental mode sees the same ids on every run.
- **Duplicate titles** (two `it('same name')` calls in one `describe`, say) get a ` [N]` suffix.
  The suffix is assigned by source line, then by bun's discovery order, never by execution order,
  so it does not change with `--randomize` or `--seed`.
- **Eager imports.** In the dry run, the preload imports every file your `mutate` globs match
  before any test file runs, so module-level code runs outside any test and its mutants are
  recorded as static, the same on every run. As a consequence, a `mock.module()` of one of those
  mutated files that runs after it was imported (at the top of a test file, or in `beforeAll`) has
  no effect on the binding already resolved: the test sees the real module. Use dependency
  injection, a test-local wrapper, or `mock.fn()`/`spyOn` on the methods instead of replacing the
  whole module. `mock.module()` of modules outside `mutate` (`node:fs`, third-party packages,
  utilities you do not mutate) is unaffected.
- **Concurrent tests.** `describe.concurrent()`, `test.concurrent()` and `it.concurrent()` run
  sequentially under the runner, with no change to your tests; ordinary `bun test` runs still run
  them concurrently. With concurrency, coverage would be recorded for whichever test was running
  when a mutant executed, which is not reliably the test that caused it.
