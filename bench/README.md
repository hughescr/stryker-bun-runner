# Performance benchmark

Measures how long Stryker takes to mutation-test a fixed, vendored open-source library
(`bench/fixture/`) using **this worktree's build** of the runner, and checks that the
result of every mutant is unchanged. It exists to iterate on runner performance: a change
that is faster but flips any mutant's status is a bug, not a win.

## Quick start

```sh
bun run bench -- --quick                      # 1 run, no statistics: smoke test
bun run bench                                 # 3 runs: the number to report
bun run bench -- --runs 5 --record "pool reuse"   # append a row to bench/RESULTS.md
bun run bench -- --no-build                   # reuse the existing dist/ (you just built it)
bun run bench -- --fixture /path/to/other     # a different fixture directory
bun run bench -- --json                       # one JSON document on stdout; text goes to stderr
```

`bun run bench` is `sh bench/lock.sh --exclusive -- bun bench/run.ts`. It works from any git
worktree: the repo root is found from the script's location, `bun run build` runs there
first (so `dist/` matches your source; skip with `--no-build`), and the fixture's
`stryker.conf.mjs` loads `<that worktree>/dist/index.js` through `BENCH_PLUGIN`.
Run it from the worktree whose code you want to measure.

Options: `--runs N` (default 3), `--quick` (= `--runs 1`), `--fixture <dir>`,
`--no-build`, `--write-baseline`, `--record "<label>"`, `--json`.

Use `--quick` while developing to see that the harness and your change work end to end; use
the 3-run default (or more) before you claim a speedup, since a single run says nothing about
noise. Each run takes about a second longer than Stryker itself: the harness samples CPU
usage for 1 s before starting it.

## The lock

Benchmark timings are only meaningful if nothing else is using the CPUs, and several agents
work in parallel worktrees on one machine. `bench/lock.sh` is a machine-wide
reader/writer lock (`flock` on `/tmp/stryker-bun-runner-bench.lock`, override with
`STRYKER_BENCH_LOCK`, which must be an absolute path):

| mode | used by | behaviour |
| --- | --- | --- |
| `--exclusive` | `bun run bench` | waits for every running check and benchmark; nothing else starts while it runs |
| `--shared` | `bun run checks` | many may run together; none while a benchmark runs; a benchmark waits for them to finish. Runs under `nice -n 19 ionice -c 3` |

```sh
sh bench/lock.sh --exclusive [--nowait] -- <cmd...>
sh bench/lock.sh --shared    [--nowait] -- <cmd...>
```

- Blocking by default. If it has to wait it prints `waiting for bench lock held by <pid mode cwd since cmd>` to stderr.
- `--nowait` exits **75** if the lock is held.
- The holder is recorded in `<lock>.holder` (exclusive) and `<lock>.holder.<pid>` (shared) while it runs.
- Once a benchmark is waiting, new shared acquirers queue behind it, so a stream of dev checks cannot starve it.
- The lock dies with its holder (the kernel releases it); stale holder files name dead pids and are ignored.
- `bench/run.ts` refuses to run unless it was started by `lock.sh --exclusive` (it checks the environment *and* the holder file), so `bun bench/run.ts` directly will not work.

**Rule of thumb:** wrap any CPU-heavy work that is not a benchmark but must not disturb one
(`bun test`, lint, typecheck, builds, real Stryker runs for debugging) in
`sh bench/lock.sh --shared -- ...`, or just use:

```sh
bun run checks     # bun test && bun run lint && bun run typecheck, under the shared lock, low priority
```

Ordinary dev checks may overlap each other freely; they only exclude benchmarks. Do not run a
benchmark inside a shared lock (it would deadlock against itself and `lock.sh` refuses the upgrade).

## Reading the output

Per run, while it executes:

```
RUN 2/3 wall=118.4s dryrun=6.1s tests=412 mutants=2210 load1=0.31 log=bench/out/20261012T182701-run2.log
```

Then one greppable summary line:

```
BENCH sha=3589d9f runs=3 median=118.4s min=117.9s max=121.0s spread=2.6% dryrun_median=6.1s mutants=2210 runs_agree=yes status_diff=OK
```

- `sha` — `git rev-parse --short HEAD`, plus `+dirty` if tracked files outside `bench/` differ from HEAD.
- `median` / `min` / `max` — wall-clock seconds of the whole `stryker run` (spawn to exit, `performance.now()`), the headline number.
- `spread` — `(max - min) / median`. If it is more than a few percent the machine was noisy; re-run.
- `dryrun_median` — Stryker's initial test run, from its log line `Initial test run succeeded. Ran N tests in X (net A ms, overhead B ms)`; reported as `(A + B) / 1000` because the human-readable `X` is whole seconds.
- `mutants` — number of mutants in `reports/mutation/mutation.json`.
- `runs_agree` — `NO` if the runs' per-mutant statuses differ from each other.
- `status_diff` — `OK`, `NO_BASELINE`, or `<k> mismatches vs baseline`; mismatches are listed below the summary (first 20).
- `load1` — 1-minute load average at the start of a run. The harness also samples system-wide CPU busy % for 1 s and prints `WARNING: machine not idle` (and `BENCH-WARNING` after the summary) if run 1 starts with load1 > 1.0 or any run starts with CPU > 25 % busy. Later runs inherit the previous run's own load average, which is why only run 1 is judged by load1. **A warned benchmark is not trustworthy; find the other CPU user and re-run.**

Exit codes: `0` ok; `1` Stryker or build failed (log tail printed, nothing recorded); `2` usage or missing lock; `3` per-mutant statuses differ from the baseline or between runs.

Every run's full Stryker output is in `bench/out/<timestamp>-run<i>.log` and a machine-readable summary in `bench/out/<timestamp>-summary.json` (`bench/out/` is gitignored).

## The invariant: per-mutant statuses must match the baseline exactly

A faster runner is only useful if it kills and spares exactly the same mutants. After each
run the harness reads `reports/mutation/mutation.json`, builds a map

```
"<file>:<line>:<col>:<mutatorName>:<sha256(replacement)[0..10]>"  ->  Killed | Survived | NoCoverage | Timeout | ...
```

and compares it with `bench/baseline-statuses.json`. The key is location + mutator +
replacement, which is how Stryker's own incremental mode identifies a mutant; Stryker's
sequential mutant ids are not used because they shift whenever any earlier source changes.
(Two mutants identical in all four parts get `#2`, `#3`... in report order.)

Any mismatch (`status_diff` not `OK`) means your change altered behaviour: fix it before
claiming a speedup. A `Timeout` that flips to `Killed` (or the reverse) is still a mismatch;
if it only happens when the machine was busy, re-run on an idle machine before investigating.
If the *baseline* runs themselves disagree, the fixture is nondeterministic and cannot serve
as a regression oracle until fixed; `--write-baseline` refuses to write in that case.

## Baseline workflow

The baseline is produced once, from the unmodified runner on an idle machine, and committed:

```sh
bun run bench -- --runs 3 --write-baseline --record "baseline"
```

This writes (and overwrites) `bench/baseline-statuses.json` (the per-mutant oracle),
`bench/baseline.json` (machine-readable timings, used for the delta column in
`RESULTS.md`) and `bench/BASELINE.md` (date, sha, CPU/bun version, per-run times, median,
status breakdown). Only re-baseline deliberately: for example when the fixture changes, or
when a status change is intended and reviewed. Never re-baseline to make a mismatch go away.

## Recording results

`--record "<label>"` appends a row to `bench/RESULTS.md` (created on first use):

| date | sha | label | runs | median | min–max | delta vs baseline | status_diff |
| --- | --- | --- | ---: | ---: | --- | --- | --- |

Delta is the median compared with the median in `baseline.json` (negative is faster).
Record only 3-run results taken with no `WARNING`s; rows with mismatches are recorded too,
so a dead end is visible.

## Files

| file | purpose |
| --- | --- |
| `lock.sh` | machine-wide shared/exclusive lock wrapper |
| `run.ts` | the benchmark (strict TypeScript, linted and type-checked with the rest of the repo) |
| `tsconfig.json` | lets ESLint's project service resolve `run.ts` (type-checking runs via `scripts/tsconfig.json`) |
| `fixture/` | the vendored library being mutation-tested |
| `baseline-statuses.json`, `baseline.json`, `BASELINE.md` | the baseline (see above) |
| `RESULTS.md` | log of recorded runs |
| `out/` | per-run logs and summaries (gitignored) |

For testing the harness itself without running Stryker, `BENCH_STRYKER_BIN` replaces the
Stryker executable (it must behave like `stryker run`: log the dry-run line and write
`reports/mutation/mutation.json` in its cwd).
