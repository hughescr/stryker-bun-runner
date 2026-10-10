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

At startup the runner executes `bun --version` and fails with a clear message if Bun can't be run or is older than 1.3.7, telling you to install Bun or set `bun.bunPath`.

**To install Bun 1.3.7 or later:**

```bash
bun upgrade
```

Or install a specific version:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.7"
```

### Other Requirements

- **@stryker-mutator/core** ^9.0.0 || ^10.0.0

Stryker itself runs on Node (only the test children run on Bun), so the host Node version must satisfy the Stryker major you pick: Stryker 9 needs Node >= 20, Stryker 10 needs Node >= 22.

## Installation

```bash
bun add -D @hughescr/stryker-bun-runner @stryker-mutator/core
```

## Configuration

Create a `stryker.conf.mjs` file:

```javascript
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/**/*.ts'],
  bun: {
    // bunPath defaults to 'bun' - only set if using a custom Bun installation
    inspectorTimeout: 5000,          // Inspector connection timeout in ms (default: 5000)
  },
};
```

`appendPlugins` is required because Stryker only auto-loads plugins named `@stryker-mutator/*`, and this package is published as `@hughescr/stryker-bun-runner`; without it, `testRunner: 'bun'` is never registered. (`appendPlugins` adds to Stryker's default `plugins` list rather than replacing it.)

## How It Works

The plugin uses Bun's Inspector Protocol (WebSocket) to:

1. **Discover tests** - Connects to Bun's test process via WebSocket
2. **Track execution** - Listens for TestReporter events to correlate test runs with coverage
3. **Sequential execution** - Uses `--max-concurrency=1` to ensure reliable coverage correlation (the coverage preload also forces `test.concurrent` tests to run sequentially)
4. **Build hierarchy** - Reconstructs test names from describe blocks for accurate reporting
5. **Targeted mutant runs** - Runs only the tests that covered each mutant (via `--test-name-pattern`); bails after the first failure unless Stryker's `disableBail` option is set (dry runs never bail, since the full suite must run for coverage). Any bail flag in `bun.bunArgs` is ignored — bail is decided solely by the runner.

**How crashes are scored.** A mutant run's `bun test` child can die from a signal (for example SIGSEGV, or SIGKILL from the operating system's out-of-memory killer) or fail to start at all (for example the `bun` executable is missing). Either outcome is scored **Killed** only when a failing test was reported and could be attributed to a known test. Otherwise the mutant is scored as an **Error** (Stryker shows it as a RuntimeError, which is excluded from the mutation score), and the message names the signal or the spawn error. The runner's own timeout and `bun.maxChildRss` kills are unaffected and are still scored as Timeout (see [Timeouts](#timeouts) for the one exception). Earlier versions counted such crashes as Killed, so upgrading can lower your mutation score; the crashes were never real evidence that a test caught the mutant. Each Error is logged at warn (see [Diagnostic warnings worth grepping for in CI](#diagnostic-warnings-worth-grepping-for-in-ci)).

**Mutants that break module loading are Killed.** A mutant can make a test file fail to load: a source module throws at import (for example a mutated module-level constant or config object), a source file no longer parses, or a `describe` body throws. Bun then prints an `# Unhandled error between tests` block with no `(fail)` line, and reports the failure only in its summary (` 1 fail`, ` 1 error`, or `Bailed out after 1 failure`). The runner scores such a run **Killed** with an empty `killedBy`, because no single test failed. Stryker's jest and vitest runners score a test file that fails to load the same way. This is not a false kill: Stryker only mutates source files, and the dry run, which must pass, loaded every one of these files without error, so the load failure came from the mutant. A run that exits non-zero with no failing test and no fail or error count at all (for example bun cannot find a preload) is scored **Error**, because nothing in it shows a test detecting the mutant. Earlier versions scored load failures as Error, so upgrading can raise your mutation score. They also scored a non-zero exit with no recognizable output as Killed, which can lower it.

Oversized covering-test patterns (over 100,000 UTF-8 bytes) fall back to running the full suite, to stay within OS argument-length limits. This approach provides reliable test-to-mutant correlation, even with multiple test files.

A second full-suite fallback happens at run time: a `--test-name-pattern` that matches zero tests triggers a one-shot full-suite retry (see [Diagnostic warnings worth grepping for in CI](#diagnostic-warnings-worth-grepping-for-in-ci)).

### Timeouts

Stryker gives every mutant run its own timeout: `timeoutFactor` × the dry-run time of the tests it plans to run for that mutant + `timeoutMS` + the dry run's overhead. For an ordinary mutant those are its covering tests; for a static mutant they are the whole suite. Stryker enforces that timeout itself, and when it fires it restarts the whole worker process, which costs about a second each time.

The runner therefore kills a mutant run's `bun test` child slightly earlier, at Stryker's timeout minus the larger of 750 ms and 5% (never more than a quarter of the timeout, so a very small `timeoutMS` still leaves the run most of its budget), and reports the Timeout itself. The 750 ms floor covers the runner's 500 ms SIGTERM-to-SIGKILL grace period. A zero-match retry gets only what is left of the same budget, because Stryker's timer covers both runs. `bun.timeout` governs only the dry run, and is the mutant-run limit only when Stryker supplies no timeout.

One case cannot be scored reliably. When the runner falls back to the full suite for a mutant that has covering tests (the pattern is too long, or matched zero tests), Stryker's timeout was sized for those covering tests, not the full suite. A full suite that is merely slower than that budget looks the same as a mutant that hangs, and the runner cannot extend Stryker's timer. Such a run is scored **Error**, not Timeout, so it does not inflate the score. It is logged at warn as `inconclusive timeout`. If you see it often, raise Stryker's `timeoutMS` or `timeoutFactor`.

Stryker's own `testFiles` option (Stryker 9.6+) is handled separately. With it set, Stryker gives static and no-coverage mutants a list of test **file paths** (inside the sandbox) instead of test ids, and sizes their timeout for those files. The runner recognises that shape (every entry is not a known test id and is an existing test file), runs exactly those files without a `--test-name-pattern`, and scores a run killed at the deadline as a normal **Timeout**, since the budget was sized for it. Note this is Stryker's `testFiles`, not the runner's `bun.testFiles`.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bun.bunPath` | `string` | `'bun'` | Path to the Bun executable |
| `bun.timeout` | `number` | `10000` | Wall-clock limit in milliseconds for the dry run's `bun test` child process, which is killed when it expires; the dry run gets an extra 30 s on top of this limit for the coverage drain handshake. Set it comfortably above your full test suite's run time; the runner warns when a dry run uses more than 80% of it. Mutant runs follow Stryker's per-mutant timeout instead (see [Timeouts](#timeouts)), and use `bun.timeout` only when Stryker supplies none. This is **not** Bun's per-test `[test].timeout` from `bunfig.toml`, which is independent. |
| `bun.inspectorTimeout` | `number` | `5000` | Timeout for Inspector WebSocket connection in milliseconds |
| `bun.env` | `object` | `undefined` | Additional environment variables to pass to bun test |
| `bun.bunArgs` | `string[]` | `undefined` | Additional bun test flags (e.g., `['--only']`). Bail flags (`--bail`, `--bail=<N>`, or a space-separated `--bail <N>`) are ignored here — bail is fully managed by the runner via Stryker's `disableBail` option (see [How It Works](#how-it-works)). Flags that fight the runner's own command line are **rejected at startup with an error** rather than silently producing wrong scores: `--concurrent` and `--max-concurrency` (break per-test coverage attribution), `--parallel`, `--shard` and `--changed` (run only part of the suite or split it across processes), `-t`/`--test-name-pattern` (the runner builds its own per mutant), `-u`/`--update-snapshots` (snapshot tests could never fail), `--pass-with-no-tests` (a zero-match selection would be scored as survived), `--watch`, `--coverage*`, `--cwd` and `--inspect*` (collide with the runner's sandbox and inspector). `--config=<path>` (also `--config <path>` and `-c <path>`) is accepted but works differently from plain bun: the runner always passes bun its own sanitized `--config`, so the flag is removed from the bun command line and your file is instead the source the runner sanitizes (see [How the sandboxed config works](#how-the-sandboxed-config-works)) and reads `[test].root` from. The path is resolved against the project directory (the Stryker sandbox), and the file must exist there; a `--config` or `-c` without a path is rejected. `--only` is fine: only the `.only` tests then count as the suite (and the dry run fails if none is marked `.only`). |
| `bun.testFiles` | `string[]` | `undefined` | Explicit list of test file paths (absolute or relative to cwd). When provided, skips auto-discovery (see [Test file discovery](#test-file-discovery)) and uses this list verbatim. Relative paths resolve against the bun subprocess's cwd. Useful for restricting mutation testing to a subset of test files. |
| `bun.smol` | `boolean` | `false` | Pass Bun's `--smol` flag to every child: a smaller JavaScriptCore heap at some cost to speed. Recommended on memory-constrained machines — see [Memory model](#memory-model). |
| `bun.maxChildRss` | `number` | `undefined` | Soft memory ceiling in bytes for each child's RSS. A child that exceeds it is killed and the run reported as a clean timeout for that mutant. See [Memory containment](#memory-containment). |
| `bun.rssCheckIntervalMs` | `number` | `1000` | Poll interval in milliseconds for the `maxChildRss` check. |
| `bun.maxSpawnDepth` | `number` | `1` | Maximum `bun test` spawn nesting depth before the runner refuses to spawn. Guards against runaway recursion — see [Recursion containment](#recursion-containment). Raise to `2` only if your own tests drive this runner. |

### Test file discovery

Unless `bun.testFiles` is set, the runner finds test files itself and hands bun an explicit, sorted list (this keeps the order stable across runs). Discovery follows `bun test`'s own rules, so it picks up exactly what a plain `bun test` would:

- File names ending in `.test.`, `_test.`, `.spec.` or `_spec.` followed by `js`, `jsx`, `ts`, `tsx`, `mjs`, `cjs`, `mts` or `cts` (case-insensitive).
- `node_modules` and dot-directories (`.git`, `.stryker-tmp`, …) are skipped; other directories such as `dist` and `build` are searched.
- `[test].root` from your `bunfig.toml` is respected: the search starts there (resolved against the project directory), so test files outside `root` are not run. Bun ignores `root` for files passed on the command line, which is why the runner applies it itself. `pathIgnorePatterns` is applied by bun even to explicitly listed files, so it keeps working.

Because `dist` and `build` are searched, a project whose TypeScript build emits compiled tests (for example `dist/**/*.test.js`) gets those copies run as well. That is slower, and a stale compiled test can fail the dry run. The runner keeps parity with `bun test` and logs a one-time warning when auto-discovery finds any test file below a `dist` or `build` directory. To leave them out, do one of:

- set `[test].root` in `bunfig.toml` to your source/test directory (e.g. `root = "./tests"`),
- add the build directory to `[test].pathIgnorePatterns` in `bunfig.toml` (e.g. `pathIgnorePatterns = ["dist/**"]`),
- or list the tests to run in `bun.testFiles`.

To run something else, set `bun.testFiles`.

### Example with all options

```javascript
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  bun: {
    bunPath: '/path/to/bun',   // Custom bun executable (defaults to 'bun')
    timeout: 30000,            // 30 second limit for the dry run's bun test process (not a per-test timeout)
    inspectorTimeout: 10000,   // 10 second connection timeout
    env: { DEBUG: 'true' },    // Extra environment variables
    bunArgs: ['--only'],       // Extra bun test flags (bail flags here are ignored — see Options table)
    smol: true,                // Smaller JSC heap, some speed cost — see Memory model
    maxChildRss: 1_500_000_000, // Kill+report-timeout a child using more than ~1.5GB RSS
    rssCheckIntervalMs: 1000,  // How often to poll RSS when maxChildRss is set
  },
};
```

### Speeding up runs: `ignoreStatic`

Static mutants are mutants in code that only runs while a file is being loaded (module-level code), so no single test covers them. Testing one means reloading the whole environment and running the entire test suite, for every such mutant. In one measured run, static mutants were 11% of all mutants but about 41% of the mutation time.

Stryker's core `ignoreStatic: true` option skips them:

```javascript
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  ignoreStatic: true,
};
```

The tradeoff is that those mutants are never tested, so they are left out of your mutation score. Leave it off if module-load behavior matters to you; turn it on if run time matters more.

## Running Stryker

```bash
bunx stryker run
```

## How the sandboxed config works

When the plugin initialises it reads your project's `bunfig.toml` (if present; or the file named by `--config=<path>` in `bun.bunArgs`, which must then exist) and writes a sanitized copy that is passed to every `bun test` invocation via `--config`. The sanitizer forwards only an explicit allowlist of `[test]` keys; everything else is stripped. The forwarded keys are: `preload`, `root`, `pathIgnorePatterns`, `timeout`, `smol`, `rerunEach`, `retry`, `randomize`, `seed`. The `[install]` table is copied verbatim. Two keys are always forced: `coverage = false` and `onlyFailures = false`. This prevents `coverageThreshold` misses (which cause Bun to exit 1 even when no test actually fails) from being mistaken for mutant kills. If you need additional `[test]` settings forwarded, add their key names to the `SAFE_TEST_KEYS` set in `src/utils/bunfig-sanitizer.ts`.

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

## Recursion containment

### Kills reach the whole process tree

On POSIX systems, every `bun test` child is spawned **detached**, so it leads its own process group, and every kill path (timeout, `AbortSignal`, the `maxChildRss` ceiling) signals that whole group rather than the single child. This matters whenever your test suite itself spawns processes: signalling only the direct child leaves its grandchildren alive and reparented to PID 1, where nothing will ever clean them up. A suite that starts a server, a database, or another `bun` process therefore leaks one of each on every timed-out mutant unless the group is signalled. Platforms without POSIX process-group signalling fall back to terminating the direct child and cannot guarantee descendant cleanup.

Spawning detached has a consequence worth stating plainly: a detached child is no longer in the terminal's foreground process group, so it does **not** die on its own when you Ctrl-C a run. The runner therefore traps `SIGINT`/`SIGTERM`/`SIGHUP`, kills every live child's group, and re-raises the signal so the default behaviour is preserved. Without that, interrupting a campaign would strand one full `bun test` process per worker.

### The runner refuses to nest indefinitely

Each child carries its spawn depth in `__STRYKER_BUN_RUNNER_DEPTH__`, and a run at or beyond `bun.maxSpawnDepth` fails with a non-zero exit code instead of spawning. The failure mode this prevents is worth spelling out, because it is not hypothetical and it is not survivable:

- The runner can spawn `bun test` from inside a `bun test` it spawned.
- If a nested run falls back to auto-discovery while its cwd is the project root, it picks up the project's **entire** suite — including the very test that spawned it.
- That test spawns again, and so on. A new generation appears roughly every second.
- Every generation leads its own process group, so killing any one of them does not stop the chain; the survivors keep replicating and are reparented to PID 1. (Group-per-generation is a consequence of the detached spawn above — which is why the depth ceiling, not the group kill, is what actually terminates this.)

Under mutation testing this is reachable through ordinary mutants — anything that defeats the `bun.testFiles` override puts a nested run back on auto-discovery. The depth ceiling turns that from an unbounded runaway into a single loud failure.

The default of `1` allows the runner's own `bun test` children and nothing deeper, which is correct for every project whose tests do not themselves drive this runner. If yours do, raise it to `2` — **on the runner instance making the nested call**, since that is where the ceiling is enforced. Setting it in `stryker.conf.mjs` only configures the outer run, which never reaches the ceiling. This plugin's own integration tests are the worked example: they pass `maxSpawnDepth: 2` in their `bun: { … }` literals, because under Stryker the suite is itself a depth-1 run and its own spawns land at depth 2.

A refused spawn is reported as a failure for that mutant, with the reason on stderr, rather than silently passing.

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

- **Timeouts and aborts escalate gracefully.** When a run's timeout fires (see [Timeouts](#timeouts)), or when the plugin internally aborts a run (e.g. dry-run inspector connection failure), the child receives SIGTERM first; if it hasn't exited after a short grace period, it's escalated to SIGKILL. The same escalation covers `bun.maxChildRss` kills.
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
  appendPlugins: ['@hughescr/stryker-bun-runner'],
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

The runner logs these mutant-run warnings worth grepping for. The first three flag when a
mutant run's `--test-name-pattern` couldn't be built or applied with full fidelity.
None of them indicate a wrong mutation-testing verdict by themselves, but they mark
where the runner fell back to less-precise behavior. The rest (listed after
them) flag a mutant scored as an Error instead of Killed or Timeout:

- **`--test-name-pattern matched 0 tests`** — the pattern for a mutant's covering
  tests matched nothing across the whole run (usually because a mutant changed a
  value interpolated into an `it.each` title). The runner retries once with the
  full suite rather than reporting a false kill, so the eventual verdict is still
  genuine — if the retry itself also matches zero tests (or the zero-match came
  because the mutant's covering-test list was empty, so there was no pattern to retry),
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

The two registry warns matter because Bun only errors when a pattern matches **zero** tests
across the whole run; a *partial* miss — some alternatives hit, others silently
don't — exits 0 with no error text at all. These two warns are the only signal
that a partial silent drop was possible for a given mutant run, so seeing either
of them in a clean run's logs is worth investigating before trusting the score.

The remaining warns mark mutants scored as an `Error` (see
[How It Works](#how-it-works)); the first three share the form
`Mutant <id>: <reason> — scoring as Error rather than Killed`:

- **`Mutant <id>: bun test terminated by <SIGNAL> ... — scoring as Error rather than Killed`**
  — the `bun test` child died from a signal (SIGSEGV, an OOM-killer SIGKILL, ...)
  and either no test had reported a failure, or the failing tests reported could not
  be attributed to a known test. The warn also prints the first 600 characters of
  the child's stdout and stderr.
- **`Mutant <id>: could not start bun test: <error> — scoring as Error rather than Killed`**
  — the child failed to spawn (for example `spawn bun ENOENT`), so no tests ran.
- **`Mutant <id>: bun test exited with code <N> but reported no failing test and no fail/error count — scoring as Error rather than Killed`**
  — bun exited non-zero without any test summary, for example because a preload
  could not be found or the bunfig could not be parsed. The warn includes the head
  of bun's output.

- **`Mutant <id>: inconclusive timeout, scoring as Error rather than Timeout`**
  — a full-suite fallback run was stopped at the limit Stryker sized for the
  mutant's covering tests only (see [Timeouts](#timeouts)).

A handful of these can be a genuine crash worth fixing in your suite; a flood of
the second or third kind means the `bun` executable, its environment, or its
configuration is broken. A flood of the last kind means Stryker's `timeoutMS` is
too small for your full suite.

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

### Coverage diagnostics (dry run only)

Without coverage data from the dry run, Stryker runs the full test suite for every
mutant, which can turn minutes into hours, and it does not say why. The runner checks
the coverage it collected before handing it to Stryker:

- **`stryker-bun-runner: the dry run produced no mutant coverage data — ...`** — the
  coverage file the preload writes at the end of every dry run was missing,
  unreadable, or empty. The message names the file and the likely causes: the
  coverage preload never ran (a `[test].preload` in `bunfig.toml` or a flag in
  `bun.bunArgs` that replaces or bypasses it), the temporary directory is not
  writable, or the `bun test` child exited before its final `afterAll` hook (for
  example a test calls `process.exit`). With `coverageAnalysis: 'perTest'` this
  **fails the dry run**, because you asked for per-test coverage and would otherwise
  silently get a much slower run. With `'all'` it is a warning, and with `'off'`
  nothing is logged. To run without per-test coverage on purpose, set
  `coverageAnalysis` to `'all'` or `'off'`. A dry run with failing tests skips this
  check, because Stryker stops on the failing tests anyway.
- **`The dry run's coverage data shows no mutant covered by any test ...`** —
  coverage was collected, but no test reached any mutant, so Stryker will report
  every mutant as NoCoverage. Check that your `mutate` globs match the source files
  your tests import, and that the tests import those files rather than a built
  copy such as `dist/`.
- **`The coverage preload reported problems on the dry-run child's stderr`** — the
  preload's own `[Stryker Coverage] ...` diagnostics (for example a failed coverage
  write), which would otherwise be lost on a green dry run. When coverage is
  missing they are included in the message above instead.

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

  Before this check runs, the bun test child process (during `dryRun` only) holds
  itself open past its own natural exit and waits for the runner to prove — via an
  inspector-protocol round-trip over the same ordered connection the test events
  arrive on — that it has actually received and processed everything the child
  sent, before letting the child close its coverage socket and exit. This closes
  the specific race that used to cause this gate to fire under CPU-contended CI
  runners: previously, nothing synchronized "the runner has drained the inspector
  stream" with "the child process is allowed to exit," so a consumer that couldn't
  keep up with the event stream under contention would lose whatever hadn't been
  processed by the time the child exited.

  The runner's side of this wait is progress-based, not a fixed timer: it keeps
  extending as long as the inspector connection is still receiving frames of any
  kind, since continued arrivals are proof a backlog is actively draining, and
  only gives up once a period of true silence — no frames at all — has elapsed. A
  separate, much larger absolute ceiling also exists, but purely as hang
  prevention for a connection that never goes silent (or never acks) at all; it
  is not the normal way this wait ends. Either way, once the runner gives up (via
  silence or the ceiling), it still releases the child immediately rather than
  leaving it to time out on its own — the child-side timeout only governs the
  case where the sync channel itself is dead or unresponsive. Hitting any of
  these bounds still reverts to the original pre-handshake behavior (including
  this gate) exactly as before, so the handshake can only reduce how often this
  gate fires, never mask a real truncation from it.

  The gate's thresholds — `EXECUTION_SHORTFALL_ABS_FLOOR`, `EXECUTION_SHORTFALL_RATIO_THRESHOLD`,
  `ORPHANED_KEY_ABS_FLOOR`, the drain wait `INSPECTOR_DRAIN_TIMEOUT_MS`, and the drain-handshake
  bounds (`DRAIN_ACK_SILENCE_TIMEOUT_MS` and `DRAIN_ACK_ABSOLUTE_CEILING_MS`, both in
  `src/bun-test-runner.ts`) — are fixed module-level constants. The matching preload-side
  ceiling in `src/templates/coverage-preload.ts` is kept above the runner's absolute ceiling,
  so it remains the true outermost backstop even though it should now rarely if ever be the
  one that actually fires. There is currently no config option to override any of these; if
  the defaults produce false positives in your environment (e.g. a CI runner with very
  different contention characteristics than the ones this gate was tuned against), a config
  knob is a possible follow-up — please open an issue rather than patching the constants
  locally. Separately, the dry-run child process's own kill timeout is automatically extended
  by the drain ceiling on top of `bun.timeout`, so the drain handshake itself never gets cut
  short by that watchdog. That watchdog covers the child's whole lifetime rather than being
  phase-specific, though, so as a side effect a dry run whose tests themselves hang (rather
  than the drain handshake) is also only detected after `bun.timeout` plus the ceiling — a
  one-time cost on the single dry-run child, not the per-mutant hot loop. Mutant runs are
  unaffected by any of this; they follow Stryker's per-mutant timeout (see [Timeouts](#timeouts)).

  This handshake only covers the `dryRun` path (where coverage collection and the
  completeness gate apply) — individual mutant runs are not held open the same way,
  since they run small, `--test-name-pattern`-filtered subsets where the same
  backlog-under-contention risk is negligible and the completeness gate does not
  apply to them.

  A healthy dry run is quiet about this handshake at the default (WARN) log
  level. The detailed trace is logged at DEBUG: `Drain-request received`,
  `Drain handler settled via ...`, `Post-drain inspector snapshot`, and
  `Post-drain inspector close/collision diagnostics`, reporting the
  round-trip's outcome (`ack`, `silence`, `ceiling`, or `send-rejected`), the
  found/start/end event-count deltas observed during the wait, any found-id
  gaps, the WebSocket close code/reason/wasClean (plus how many ms after the
  last received frame the close arrived), and raw-vs-unique found-event
  counts. To see those lines, run Stryker with `logLevel: 'debug'` in your
  config (or `--logLevel debug` on the command line). A separate DEBUG-level
  line notes if the inspector socket closed while the run was still thought to
  be in progress (including the same close code/reason/wasClean detail) — this
  is logged at DEBUG rather than WARN because the child closing its own socket
  right after receiving `'drained'` routinely wins the race against the
  runner's own close-expectation on a clean run, so on its own it is not
  evidence of anything wrong (it is folded into the completeness gate's error
  message as corroborating context — now including the captured close
  code/reason — only if that gate has already fired for another reason).

  At WARN, the dry run emits a single line beginning
  `Inspector data looks abnormal after the dry run:`, and only when the
  inspector data may be incomplete or merged: the drain handshake did not
  settle via `ack` (it settled via `silence`, `ceiling`, or `send-rejected`, or
  the drain request never arrived), found-id gaps remain after the wait, or
  duplicate found-id events were seen (the id-collision bug described below).
  The WebSocket close code is deliberately not one of the conditions: Bun closes
  the inspector socket with code 1006 (`wasClean` false, reason
  `Connection ended`) a few milliseconds after the drain acknowledgment on
  every healthy run, because the child process exits right after it is
  released, so an unclean close after an `ack` is normal. The close detail
  stays in the DEBUG diagnostics. The line lists the specific problems found
  and points you at debug logging
  for the full diagnostics above. Together, the WARN line and the DEBUG detail
  are useful for telling apart two different failure shapes: residual loss
  caused by a runner-side bound being hit (a
  give-up outcome — `silence` or `ceiling`) versus loss happening inside Bun's
  own inspector agent (found-id gaps persisting even though the round-trip
  `ack` succeeded). One caveat: gap detection assumes Bun assigns
  test-discovery ids densely, which has been observed but is not a guaranteed
  contract — and even a dense (0-gap) id range does **not** prove
  losslessness: a confirmed Bun TestReporter id-collision bug (two interleaved
  `1..N` id sequences when `TestReporter.enable` lands mid-collection) keeps
  ids dense while silently merging two distinct tests under one shared id.
  That is exactly what the (DEBUG-level) close/collision diagnostics line's
  raw/unique/duplicate found counts exist to catch: a **nonzero duplicate
  count is direct in-the-wild evidence of that id-collision bug** (and is
  what puts the duplicate-event problem into the WARN line above), and the
  close code/reason/wasClean fields confirm or rule out a separate confirmed
  Bun bug where `idleTimeout: 0` websockets are force-closed on a ~252-second
  ping cycle (`ERR_WEBSOCKET_TIMEOUT`) — a close with that reason landing
  mid-run, right on that cadence, points at the ping-cycle bug, while the
  routine post-`ack` `1006` / `Connection ended` close a few milliseconds after
  the last frame rules it out.
  Finally, a WARN-level `Inspector request unanswered after ...` line fires if
  an inspector protocol request (e.g. `TestReporter.enable`) goes unanswered
  for more than 2 seconds while other frames are still arriving on the same
  connection — a protocol-level stall signature distinct from the
  total-silence give-up above.

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

- **Sequential execution required** - Tests run with `--max-concurrency=1` to ensure accurate coverage tracking, and the coverage preload also forces `test.concurrent` tests to run sequentially. This is slower than parallel execution but necessary for correct test-to-mutant correlation.

- **Inspector-stream drain handshake covers `dryRun` only** — the hold-open-until-drained
  handshake described under "Dry-run completeness gate" above only runs for the dry run
  (where a `SyncServer` and coverage collection are set up). Individual mutant runs are not
  held open the same way: they run small, filtered test subsets where the backlog-under-CPU-
  contention risk that motivated the handshake is negligible, and the completeness gate does
  not apply to mutant runs in the first place.

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
