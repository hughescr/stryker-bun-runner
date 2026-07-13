# stryker-bun-runner

Stryker test runner plugin for Bun with perTest coverage support.

[![npm version](https://img.shields.io/npm/v/@hughescr/stryker-bun-runner)](https://www.npmjs.com/package/@hughescr/stryker-bun-runner) [![LICENSE](https://img.shields.io/badge/LICENSE-Apache--2.0-blue)](LICENSE.md) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.7-f9f1e1?logo=bun)](https://bun.sh) [![Stryker](https://img.shields.io/badge/Stryker-Plugin-e74c3c?logo=stryker)](https://stryker-mutator.io) [![Mutation testing badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fhughescr%2Fstryker-bun-runner%2Fmain)](https://dashboard.stryker-mutator.io/reports/github.com/hughescr/stryker-bun-runner/main) [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

## Features

- **Per-test coverage analysis** - Accurately tracks which tests cover which mutants
- **Inspector Protocol integration** - Uses Bun's WebSocket Inspector API for reliable test discovery and tracking
- **Multi-file support** - Works correctly with multiple test files
- **Incremental mode compatible** - Runs only the tests affected by each mutant

## Requirements

### Bun Version

This plugin requires **Bun 1.3.7 or later** for full functionality. Bun 1.3.7 includes the TestReporter WebSocket events (from [PR #25986](https://github.com/oven-sh/bun/pull/25986)) that enable proper test-to-mutant correlation.

**Important:** Bun versions prior to 1.3.7 will NOT work with this plugin due to missing TestReporter events.

**To install Bun 1.3.7 or later:**

```bash
bun upgrade
```

Or install a specific version:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.7"
```

### Other Requirements

- **@stryker-mutator/core** ^9.0.0

## Installation

```bash
bun add -D @hughescr/stryker-bun-runner @stryker-mutator/core
```

## Configuration

Create a `stryker.conf.mjs` file:

```javascript
export default {
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/**/*.ts'],
  bun: {
    // bunPath defaults to 'bun' - only set if using a custom Bun installation
    inspectorTimeout: 5000,          // Inspector connection timeout in ms (default: 5000)
  },
};
```

## How It Works

The plugin uses Bun's Inspector Protocol (WebSocket) to:

1. **Discover tests** - Connects to Bun's test process via WebSocket
2. **Track execution** - Listens for TestReporter events to correlate test runs with coverage
3. **Sequential execution** - Uses `--concurrency=1` to ensure reliable coverage correlation
4. **Build hierarchy** - Reconstructs test names from describe blocks for accurate reporting
5. **Targeted mutant runs** - Runs only the tests that covered each mutant (via `--test-name-pattern`); bails after the first failure unless Stryker's `disableBail` option is set (dry runs never bail, since the full suite must run for coverage). Any bail flag in `bun.bunArgs` is ignored — bail is decided solely by the runner.

Oversized covering-test patterns (over 100,000 UTF-8 bytes) fall back to running the full suite, to stay within OS argument-length limits. This approach provides reliable test-to-mutant correlation, even with multiple test files.

A second full-suite fallback happens at run time: a `--test-name-pattern` that matches zero tests triggers a one-shot full-suite retry (see [Diagnostic warnings worth grepping for in CI](#diagnostic-warnings-worth-grepping-for-in-ci)).

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bun.bunPath` | `string` | `'bun'` | Path to the Bun executable |
| `bun.timeout` | `number` | `10000` | Timeout per test in milliseconds |
| `bun.inspectorTimeout` | `number` | `5000` | Timeout for Inspector WebSocket connection in milliseconds |
| `bun.env` | `object` | `undefined` | Additional environment variables to pass to bun test |
| `bun.bunArgs` | `string[]` | `undefined` | Additional bun test flags (e.g., `['--only']`). Bail flags (`--bail`, `--bail=<N>`, or a space-separated `--bail <N>`) are ignored here — bail is fully managed by the runner via Stryker's `disableBail` option (see [How It Works](#how-it-works)). |
| `bun.testFiles` | `string[]` | `undefined` | Explicit list of test file paths (absolute or relative to cwd). When provided, skips auto-discovery and uses this list verbatim. Relative paths resolve against the bun subprocess's cwd. Useful for restricting mutation testing to a subset of test files. |
| `bun.smol` | `boolean` | `false` | Pass Bun's `--smol` flag to every child: a smaller JavaScriptCore heap at some cost to speed. Recommended on memory-constrained machines — see [Memory model](#memory-model). |
| `bun.maxChildRss` | `number` | `undefined` | Soft memory ceiling in bytes for each child's RSS. A child that exceeds it is killed and the run reported as a clean timeout for that mutant. See [Memory containment](#memory-containment). |
| `bun.rssCheckIntervalMs` | `number` | `1000` | Poll interval in milliseconds for the `maxChildRss` check. |

### Example with all options

```javascript
bun: {
  bunPath: '/path/to/bun',   // Custom bun executable (defaults to 'bun')
  timeout: 30000,            // 30 second test timeout
  inspectorTimeout: 10000,   // 10 second connection timeout
  env: { DEBUG: 'true' },    // Extra environment variables
  bunArgs: ['--only'],       // Extra bun test flags (bail flags here are ignored — see Options table)
  smol: true,                // Smaller JSC heap, some speed cost — see Memory model
  maxChildRss: 1_500_000_000, // Kill+report-timeout a child using more than ~1.5GB RSS
  rssCheckIntervalMs: 1000,  // How often to poll RSS when maxChildRss is set
}
```

## Running Stryker

```bash
bunx stryker run
```

## How the sandboxed config works

When the plugin initialises it reads your project's `bunfig.toml` (if present) and writes a sanitized copy that is passed to every `bun test` invocation via `--config`. The sanitizer forwards only an explicit allowlist of `[test]` keys; everything else is stripped. The forwarded keys are: `preload`, `root`, `pathIgnorePatterns`, `timeout`, `smol`, `rerunEach`, `retry`, `randomize`, `seed`. The `[install]` table is copied verbatim. Two keys are always forced: `coverage = false` and `onlyFailures = false`. This prevents `coverageThreshold` misses (which cause Bun to exit 1 even when no test actually fails) from being mistaken for mutant kills. If you need additional `[test]` settings forwarded, add their key names to the `SAFE_TEST_KEYS` set in `src/utils/bunfig-sanitizer.ts`.

## Memory model

Every `dryRun` and `mutantRun` spawns a **brand-new `bun test` OS process** and waits for it to fully exit before returning a result — the plugin never reuses a `bun test` child across runs. This is deliberate: it's what makes per-run isolation and coverage correlation reliable, and it means a child process's memory is always fully reclaimed by the OS the moment that one run ends. There is no cross-mutant memory accumulation to "fix" in the spawned child — each mutant gets a clean process.

What this means for memory planning on a mutation-testing machine:

- **Peak memory ≈ `concurrency` × per-run suite footprint.** If your test suite loads heavyweight dependencies at module scope (real ML models, native bindings like `sqlite`/`onnxruntime`, PDF/DOCX extractors, etc. across many test files), each individual `bun test` run pays that footprint once — and Stryker runs `concurrency` of them in parallel. 12 concurrent workers × a 2–3GB suite footprint is 24–36GB of *simultaneous* peak usage, not a leak.
- **A mutant that breaks cleanup code (`dispose()`/`close()`/`finally`) still leaks *within* that one run.** Because mutation campaigns exhaustively try every "what if this cleanup were skipped" variant, they will execute every broken-`dispose()` mutant your suite has — and each one runs to completion inside its own process before exiting, so the extra native memory is held only for that run's duration, not across the whole campaign. Well-behaved `afterAll`/`afterEach` cleanup in the tests being mutated is what keeps a single run's peak down; no plugin option can substitute for that.
- **Recommended settings for memory-constrained machines:**
  - Lower `concurrency` in your `stryker.conf.mjs` first — it has the largest, most direct effect on peak memory (linear multiplier).
  - Set `bun.smol: true` to shrink each child's JSC heap ceiling at some speed cost.
  - Set `bun.maxChildRss` as a backstop against a single run growing unexpectedly large (see [Memory containment](#memory-containment)).
  - Use Stryker core's [`maxTestRunnerReuse`](#maxtestrunnerreuse-compatibility) to periodically recycle the *Stryker worker* process itself (see below) — this is orthogonal to the spawned `bun test` child and addresses a different, much smaller source of growth.

## Memory containment

Two independent knobs help bound the memory a single `bun test` child can use, on top of the isolation the [memory model](#memory-model) already provides:

- **`bun.smol`** passes Bun's own `--smol` flag, which reduces JavaScriptCore's heap growth at some cost to speed. Cheap to enable, no behavior change beyond memory/speed trade-off.
- **`bun.maxChildRss`** is a *soft, polled userspace* memory ceiling: the plugin periodically reads the child's actual resident set size (RSS) — via `/proc/<pid>/status` on Linux, `ps -o rss=` elsewhere — and if it exceeds the configured byte threshold, kills the child (SIGTERM, escalating to SIGKILL after a grace period) and reports that one run as a clean timeout. This converts "one runaway mutant slowly drags the machine into swap" into "one mutant times out," without corrupting the rest of the campaign.

**Why not a hard, kernel-enforced ceiling (`ulimit -v`, cgroups)?** We looked at this and decided against it:
- `RLIMIT_AS` (what `ulimit -v` sets) caps *virtual address space*, not RSS. Modern JS engines (Bun's JavaScriptCore, V8) reserve large virtual ranges up front — for JIT code, WASM, guard pages — regardless of how much is actually resident. A ceiling tight enough to matter for real RSS would make the engine fail to start, unrelated to any actual leak.
- `RLIMIT_RSS` has been a no-op on Linux since kernel 2.4.30 — the kernel accepts the limit but never enforces it.
- cgroup `memory.max` is the modern, correct mechanism for a true hard ceiling, but requires delegated cgroup access that isn't guaranteed on developer machines, most CI runners, or inside existing containers — wiring it up reliably cross-platform (it doesn't exist at all on macOS) was out of scope for what should be a portable, dependency-free plugin option.

`bun.maxChildRss` gets you the practical outcome (a runaway run fails cleanly instead of taking down the machine) without those platform landmines. If you need a true hard ceiling, run Stryker itself inside a container/cgroup with a memory limit at the orchestration layer — that composes fine with this plugin.

## Orphan prevention

Each spawned `bun test` child is protected against being left running forever if something goes wrong:

- **Timeouts and aborts escalate gracefully.** When the per-run `bun.timeout` fires, or when the plugin internally aborts a run (e.g. dry-run inspector connection failure), the child receives SIGTERM first; if it hasn't exited after a short grace period, it's escalated to SIGKILL. The same escalation covers `bun.maxChildRss` kills.
- **`dispose()` kills any run still in flight.** If Stryker disposes a `TestRunner` instance while its `dryRun`/`mutantRun` hasn't resolved yet (e.g. tearing down a stuck worker), the in-flight child is aborted using the same escalation path — it isn't left running after the plugin instance that spawned it goes away.
- **A parent-liveness watchdog guards against the parent being killed outright.** If the Stryker worker process itself is killed with SIGKILL, it gets no chance to run any cleanup code at all — `dispose()` never fires. To prevent an orphaned `bun test` process in that case, every child's preload script polls its own `process.ppid` against the value captured at startup. POSIX reparents an orphaned child to the nearest subreaper (commonly PID 1) as soon as its original parent exits, so a changed `ppid` reliably signals "my parent is gone" — no `prctl(PR_SET_PDEATHSIG)` or native addon required, and it works the same on Linux and macOS. On detecting this, the child logs a warning and exits.

## `maxTestRunnerReuse` compatibility

Stryker core's own [`maxTestRunnerReuse`](https://stryker-mutator.io/docs/stryker-js/configuration/#maxtestrunnerreuse-number) option periodically disposes and reconstructs the *TestRunner instance* (and, depending on core's process-pooling, the worker process hosting it) after a configured number of runs — this is the right lever for bounding growth in the long-lived Stryker worker itself, as opposed to the already-isolated, per-run `bun test` children this plugin spawns (see [Memory model](#memory-model)).

This plugin is designed to tolerate that recycling cleanly:

- `dispose()` cleans up its preload script, coverage file, sanitized bunfig, and registry temp file, and aborts any run still in flight (see [Orphan prevention](#orphan-prevention)).
- A fresh `BunTestRunner` instance that never ran its own `dryRun` (as happens after a recycle) still resolves `killedBy` names correctly: it lazily loads the shared, file-backed dry-run test registry written by whichever instance *did* run `dryRun`, exactly as it already does for any other multi-worker Stryker run. The registry lives in the OS temp directory, not the project directory, keyed to this Stryker run so it can't collide with another run's registry or a different project's — a recycled instance is still a child of the same Stryker main process, so it derives the same key and finds the same file.

```javascript
// stryker.conf.mjs
export default {
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/**/*.ts'],
  concurrency: 8,               // tune down first on memory-constrained machines
  maxTestRunnerReuse: 100,      // recycle each Stryker worker after 100 runs
  bun: {
    smol: true,
    maxChildRss: 1_500_000_000, // ~1.5GB soft ceiling per bun test child
  },
};
```

## Diagnostic warnings worth grepping for in CI

The runner logs three warnings that flag when a mutant run's `--test-name-pattern`
couldn't be built or applied with full fidelity. None of them indicate a wrong
mutation-testing verdict by themselves, but they're worth grepping your CI logs for
because they mark where the runner fell back to less-precise behavior:

- **`--test-name-pattern matched 0 tests`** — the pattern for a mutant's covering
  tests matched nothing across the whole run (usually because a mutant changed a
  value interpolated into an `it.each` title). The runner retries once with the
  full suite rather than reporting a false kill, so the eventual verdict is still
  genuine — if the retry itself also matches zero tests (or the zero-match came
  from a user-supplied `--test-name-pattern` in `bunArgs`, which is never retried),
  the mutant is classified as an infrastructure `Error`, never a kill. Every
  occurrence is worth spot-checking that it's explained by an interpolated-title
  change, not a real pattern gap.
- **`no exact-name registry available`** — this worker couldn't load the shared
  dry-run test-name registry, so every alternative in that mutant's pattern used
  the lossy `' > '`-collapsing reconstruction instead of Bun's exact matching
  names. Tests whose titles legitimately contain `" > "` may have been silently
  excluded from that run.
- **`missing from exact-name registry`** — the registry loaded, but one or more
  `testFilter` ids for this mutant weren't in it (falls back to the same lossy
  reconstruction for just those ids, listing up to 5 of the missing ids).

The last two matter because Bun only errors when a pattern matches **zero** tests
across the whole run; a *partial* miss — some alternatives hit, others silently
don't — exits 0 with no error text at all. These two warns are the only signal
that a partial silent drop was possible for a given mutant run, so seeing either
of them in a clean run's logs is worth investigating before trusting the score.

### Dry-run failure diagnostics (dry run only)

- **`Bun exited with code <N> and its console output reported <N> failed test(s), but no failing test could be identified...`**
  — the dry run's process-level signals (a non-zero exit code, or a `>0` failed
  count parsed from Bun's console recap) say a test failed, but neither the
  inspector's per-test data nor the parsed console output identifies which one
  — the "empty recap" incident fingerprint: Bun prints e.g. `1 tests failed:`
  with no `(fail)` line naming a test. The most likely cause is an unhandled
  error firing *between* tests (e.g. a rejected fire-and-forget promise) rather
  than inside any single test body, so nothing in bun's own per-test
  bookkeeping ever marked a test as failed. What to do: check the trailing
  stderr included in the warning for a stack, and look for fire-and-forget
  async work (unawaited promises, orphaned timers) anywhere in the suite —
  especially in the file that was running when the process exited. This
  warning is purely diagnostic and never alters the returned `DryRunResult`
  by itself; it's a separate, related change that failed tests' `failureMessage`
  in a *Complete* result now has the inspector's `error.stack` appended (when
  available) — Stryker core only prints name+failureMessage for initial-run
  failures, so that's the only channel this stack reaches the CI log through.

### Dry-run completeness gate (dry run only)

- **`stryker-bun-runner: dry run data-completeness check failed — ...`** — the dry
  run otherwise looked healthy (no failed tests) but the runner detected that Bun's
  inspector event stream may have been silently truncated mid-run: either the
  inspector's execution order fell materially short of what Bun's own console
  summary reported (`console reported <N> test(s) ... but the inspector's execution
  order contains only <M> non-skipped test(s)`), or a meaningful number of coverage
  keys couldn't be paired with any inspector test (`<N> of <M> coverage key(s) ...
  could not be paired with any inspector test (orphaned)`) — the signature of one or
  more whole test files being dropped from the stream, most often under CI runner
  resource contention. When both are present, or the socket also closed
  unexpectedly before the runner could finish reading it, the message names all of
  them. This is a genuine `DryRunStatus.Error`, not a warning: proceeding on
  truncated data would risk silently corrupted coverage attribution (mutants losing
  their true killers), so the runner reports the error and does **not** persist the
  test registry, rather than let other Stryker workers load a corrupted one. If you
  see this, it usually means the CI runner was under heavier contention than usual;
  retrying the run (with less concurrent load, or fewer parallel Stryker workers) is
  the first thing to try.

  The gate's thresholds — `EXECUTION_SHORTFALL_ABS_FLOOR`, `EXECUTION_SHORTFALL_RATIO_THRESHOLD`,
  `ORPHANED_KEY_ABS_FLOOR`, and the drain wait `INSPECTOR_DRAIN_TIMEOUT_MS` it depends on —
  are fixed module-level constants in `src/bun-test-runner.ts`. There is currently no config
  option to override them; if these defaults produce false positives in your environment
  (e.g. a CI runner with very different contention characteristics than the ones this gate
  was tuned against), a config knob is a possible follow-up — please open an issue rather
  than patching the constants locally.

### Coverage-bleed warning (dry run only)

- **`mutant coverage was recorded between tests, after '<testName>' completed`**
  — during the dry run's coverage collection, mutant coverage was recorded in the
  gap between one test's `afterEach` and the next test's `beforeEach`, i.e. while
  no test was active. The most likely cause is a fire-and-forget promise chain
  (or other async work) started by `<testName>` that kept running past that
  test's own completion; the warning names the coverage attribution for the
  listed mutant IDs as possibly wrong as a result.

  This is diagnostic only — it never changes a dry-run or mutant-run result, and
  the runner's normal "static wins" coverage attribution is unaffected. A known
  **benign** trigger this warning does not try to filter out: a same-file
  describe-level `beforeAll` (or other fixture setup) legitimately running in
  that same gap looks identical from this vantage point. If the named test has
  no fire-and-forget async work of its own, check for a `beforeAll`/fixture in
  the same file before assuming a real leak.

  The real fix, when it is a genuine leak, is in the test itself — `await` the
  fire-and-forget work (or otherwise ensure it settles) before the test ends,
  rather than in this runner. Warnings are capped at 25 individually, with a
  final `...and N more coverage-bleed warning(s) suppressed` line for the rest.

## Known Limitations

- **Sequential execution required** - Tests run with `--concurrency=1` to ensure accurate coverage tracking. This is slower than parallel execution but necessary for correct test-to-mutant correlation.

**Upgrade note: duplicate-name test suffixes**

The runner reconciles how it assigns the `' [N]'` disambiguating suffix to
duplicate-named tests (e.g. two `it('same name')` calls in one `describe`, or
`it.each` on older Bun versions) so that the test registry and mutant coverage
always agree on the same suffix for the same physical test, regardless of Bun's
per-run `--seed` execution-order shuffle. If your suite has duplicate test titles,
upgrading across this change can change which test a given `' [N]'` suffix refers
to, which invalidates
Stryker's incremental-cache correlation for mutants covered by those specific tests.
This is fail-safe, not silently wrong: affected mutants simply re-run once on your
next incremental `stryker mutate` and the cache self-heals from there — no action
needed on your part.

**Eager-import and `mock.module()` compatibility**

During `dryRun`, the plugin eager-imports every mutated source module at preload time in order to produce deterministic per-test coverage. Each mutated module is imported once, before any test file executes.

Because of this, any `mock.module()` call that runs after a module has already been imported has no effect on the already-resolved module binding. In practice, this means that if a test file calls `mock.module('./some-source-file')` at the top level (or inside a `beforeAll`), and that file is among the mutated modules, the test will see the real module rather than the mock.

Suggested workarounds: use dependency injection so the real module reference is replaceable at test time; wrap the mocked surface in a test-local helper that the test can control without replacing the module; or use `mock.fn()` on method instances rather than replacing the entire module with `mock.module()`.

This limitation applies only to mutated source files — the ones listed under `mutate:` in your Stryker config. Pre-import `mock.module()` of non-mutated modules (for example `node:fs`, third-party libraries, or utility files outside the mutation scope) is unaffected.

## Concurrent Tests

This plugin automatically patches `describe.concurrent()`, `test.concurrent()`, and `it.concurrent()` to run sequentially during mutation testing. Your tests will work without modification.

**Why?** Coverage tracking requires knowing which test exercised which code. With concurrent execution, the `beforeEach` hook assigns test IDs in the order tests *start*, but coverage is recorded in the order tests *complete*. These orders differ with concurrency, causing coverage to be attributed to the wrong tests.

**What this means:**
- ✅ Your `.concurrent()` tests work automatically with Stryker
- ✅ Normal test runs (without Stryker) still use concurrent execution
- ⏱️ Mutation testing runs are slower due to sequential execution

## License

Apache-2.0

## Contributing

Issues and pull requests welcome at [github.com/hughescr/stryker-bun-runner](https://github.com/hughescr/stryker-bun-runner)
