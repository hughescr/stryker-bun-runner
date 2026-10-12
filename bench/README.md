# Performance benchmark

Measures how long Stryker takes to mutation-test a fixed, vendored open-source library
(`bench/fixture/`) using **this worktree's build** of the runner, and checks that the
no mutant has lost detection. It exists to iterate on runner performance: a change that is
faster but lets a mutant the baseline caught survive is a bug, not a win.

## Quick start

```sh
bun run bench -- --quick                      # 1 run, no statistics: smoke test
bun run bench                                 # 3 runs: the number to report
bun run bench -- --runs 5 --record "pool reuse"   # append a row to bench/RESULTS.md
bun run bench -- --no-build                   # reuse the existing dist/ (you just built it)
bun run bench -- --fixture /path/to/other     # a different fixture directory
bun run bench -- --json                       # one JSON document on stdout; text goes to stderr
bun run bench -- --compare HEAD~3 --runs 5    # interleaved A/B against another commit (see below)
```

`bun run bench` is `sh bench/lock.sh --exclusive -- bun bench/run.ts`. It works from any git
worktree: the repo root is found from the script's location, `bun run build` runs there
first (so `dist/` matches your source; skip with `--no-build`), and the fixture's
`stryker.conf.mjs` loads `<that worktree>/dist/index.js` through `BENCH_PLUGIN`.
Run it from the worktree whose code you want to measure.

Options: `--runs N` (default 3), `--quick` (= `--runs 1`), `--fixture <dir>`,
`--no-build`, `--write-baseline`, `--record "<label>"`, `--json`, `--compare <ref-or-path>`, `--keep-ref`.

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
RUN 2/3 wall=118.4s dryrun=6.1s tests=412 mutants=2210 load1=0.31 log=bench/out/20261012T182701-run2.log foreign=0.3s foreign_pct=0.1% claude=0.2s steal=0.1% iowait=0.0% orphans=0 tmp=+2/+1.3MB
```

(The trailing contamination fields are described under "Contamination monitor" below.)

Then one greppable summary line:

```
BENCH sha=3589d9f runs=3 median=118.4s min=117.9s max=121.0s spread=2.6% dryrun_median=6.1s mutants=2210 runs_agree=yes detect_diff=OK status_swaps=0 contaminated_runs=0 orphans=0 tmp_growth=+2/+3.9MB
```

- `sha` — `git rev-parse --short HEAD`, plus `+dirty` if tracked files outside `bench/` differ from HEAD.
- `median` / `min` / `max` — wall-clock seconds of the whole `stryker run` (spawn to exit, `performance.now()`), the headline number.
- `spread` — `(max - min) / median`. If it is more than a few percent the machine was noisy; re-run.
- `dryrun_median` — Stryker's initial test run, from its log line `Initial test run succeeded. Ran N tests in X (net A ms, overhead B ms)`; reported as `(A + B) / 1000` because the human-readable `X` is whole seconds.
- `mutants` — number of mutants in `reports/mutation/mutation.json`.
- `runs_agree` — `NO` if some mutant is caught (Killed, Timeout, RuntimeError, CompileError) in one run and not caught in another. Status changes that stay inside the caught group are not disagreements.
- `detect_diff` — **the gate**: `OK`, `NO_BASELINE`, or `<k> lost` (k distinct mutants that the baseline caught and some run did not; listed below the summary, first 20, complete in the JSON).
- `status_swaps` — informational: how many baseline-vs-run status differences are *not* lost detections (`Killed`→`Timeout`, `Survived`→`Killed`, ...). A `swaps (info):` line gives them by kind, e.g. `K→T:3,S→K:1` (K Killed, T Timeout, S Survived, N NoCoverage, R RuntimeError, C CompileError, - absent), and how many mutants changed status between runs without crossing the caught line.
- `contaminated_runs`, `orphans`, `tmp_growth` — how many runs were flagged CONTAMINATED, how many processes outlived a run, and the net change in `os.tmpdir()` over the batch (see below). A batch with `contaminated_runs` above 0 is not trustworthy; `--record` marks the row `n CONTAMINATED`.
- `load1` — 1-minute load average at the start of a run, for information. It lags (it is high right after another benchmark or the previous run on an idle machine), so the warning is decided by a live reading instead: the harness samples system-wide CPU busy % for 1 s before each run and prints `WARNING: machine not idle` (and `BENCH-WARNING` after the summary) if it is above 25 %. (Only if `/proc/stat` is unreadable does run 1 fall back to warning on load1 > 1.0.) **A warned benchmark is not trustworthy; find the other CPU user and re-run.**

### Contamination monitor

The lock only helps if everybody uses it, and a VM can lose CPU to its host. So the harness
also watches the machine **while each run executes** and reports what it saw. All of it is
Linux `/proc`; the sampler runs in the bench process (its CPU is counted in the bench tree,
not as foreign), wakes every 250 ms and costs about 3-5 ms per wake-up (`drift:` line:
`sampler cost`, typically well under 2% of one CPU).

Appended to every `RUN` line:

```
RUN 2/5 wall=27.8s ... log=bench/out/20261012T182701-run2.log foreign=0.3s foreign_pct=0.3% claude=0.2s steal=0.1% iowait=0.0% orphans=0 tmp=+2/+1.3MB
  foreign top 3: node child-process-proxy-worker.js 0.20s (2 proc), bun test 0.09s (3 proc)
```

- `foreign` / `foreign_pct` — CPU-seconds used by processes that are **not** in the bench tree, and that as a
  share of `wall × CPUs`. Sampled from `/proc/<pid>/stat` (utime+stime growth between samples). A process is
  "ours" if it descends from the bench process (ppid walk), shares the detached stryker run's session or
  process group (so workers reparented to init still count as ours), or was seen as ours earlier. The run is
  flagged `CONTAMINATED` (and counted in `contaminated_runs`) if `foreign_pct` exceeds 2%. The `foreign top 3`
  line names the three commands (grouped like `node child-process.js`, `bun test`) that used the most.
- `claude` — CPU of `claude` processes (the allowlist). Reported, **not** counted as foreign, never hidden.
  Kernel threads (`kworker`, ...) are likewise tallied apart (`kernelCpuSeconds` in the JSON), since our own I/O
  keeps them busy.
- `steal` / `iowait` — share of all CPU time `/proc/stat` attributes to hypervisor steal and I/O wait between
  spawn and exit. JSON also has the peak steal over any 250 ms slice (`stealPeakPct`). Steal above about 1% means
  the host took CPU from the VM and the run is not comparable with a low-steal run.
- `orphans` — processes alive after stryker exited (checked up to 1.5 s later, to allow a graceful exit): any
  descendant of the run, and any `bun test` that is not an ancestor of the bench. The run's own are SIGKILLed
  right after the report so they cannot disturb the next run (`ORPHAN` lines name them); a foreign `bun test`
  is only reported. JSON `leftovers.orphansAtExit` counts the descendants still alive the instant stryker exited.
- `tmp` — change in `os.tmpdir()` since the previous run (since the start of the batch for run 1):
  top-level entry count and total bytes (`du -sb`, taken between runs, outside the timed window). Other users
  of `/tmp` show up here too; `tmpGrowth.added` in the JSON lists the new entry names.

Limits: a process that starts and exits between two samples is invisible to the per-command accounting.
The JSON therefore also carries `treeCpuSeconds` (the bench process plus every reaped descendant, from
`cutime`/`cstime`), `systemBusyCpuSeconds` (user+nice+system from `/proc/stat`) and `unattributedCpuSeconds`
(busy minus tree, foreign, claude and kernel). On an idle machine it is within about +-1 s (tick rounding); a
clearly positive value means short-lived foreign processes (or tree processes that died after being
reparented) used CPU the sampler did not see, so treat the run with suspicion even if `foreign_pct` is low.

The summary line gains `contaminated_runs=<k> orphans=<n> tmp_growth=<entries>/<bytes>`, followed by a
`drift:` line with the least-squares slope of wall time over the batch (seconds per run; a clearly positive
slope with no steal/foreign/orphan explanation points at something the runs themselves accumulate), the
maximum steal and foreign share, and the sampler cost. A `BENCH-WARNING` line is printed for contaminated
runs and for orphans. The summary JSON holds all of it per run (`runDetails[].contamination`, `.leftovers`,
`.tmpGrowth`) and for the batch (`contaminatedRuns`, `health`).

Exit codes: `0` ok; `1` Stryker or build failed (log tail printed, nothing recorded); `2` usage or missing lock; `3` the gate failed: a mutant the baseline caught was not caught in some run (`detect_diff` is `<k> lost`). Nothing else fails a run.

Everything for an invocation lands in `bench/out/` (gitignored), named by its start timestamp:

- `<stamp>-run<i>.log`: Stryker's full output for run *i* (`<stamp>-pair<k>-ref.log` / `-cand.log` under `--compare`; same for the files below).
- `<stamp>-run<i>-statuses.json`: that run's map from key to `{status, id, mutatorName, file, location, statusReason, coveredBy, killedBy, testsCompleted}`.
- `<stamp>-run<i>-mutation.json`: a copy of Stryker's `mutation.json` for the run (the fixture's `reports/` is wiped before every run).
- `<stamp>-summary.json`: the summary. `lost` is the complete list of gate failures and `swaps` the complete list of informational status changes, both as `{key, expected, actual, run, lost}` per mutant and run; `runDisagreements` (with `runDisagreementCount`) lists mutants caught in some runs and not in others, each with its per-run details; `runSwapCount` counts the other between-run changes.

When `runs_agree=NO`, the text output prints each disagreeing mutant as its key, mutator, location, and `run<i>=<status>(id <id>)` for every run; `diff` the `-statuses.json` files or read `statusReason` and `coveredBy` in them for the cause. Compare the per-worker `killed/survived/timeout` totals in the logs, too: a run whose totals differ had a real status change, not a key problem.

## The gate: no mutant may lose detection

A faster runner is only useful if it still catches what the baseline caught. After each
run the harness reads `reports/mutation/mutation.json`, builds a map

```
"<file>:<line>:<col>-<endLine>:<endCol>:<mutatorName>:<sha256(replacement)[0..10]>"  ->  Killed | Survived | NoCoverage | Timeout | ...
```

and compares it with `bench/baseline-statuses.json`. The key is full location (start and end) + mutator +
replacement, which is how Stryker's own incremental mode identifies a mutant; Stryker's
sequential mutant ids are not used because they shift whenever any earlier source changes.
(Two mutants identical in all four parts get `#2`, `#3`... in report order.)

The **caught group** is `{Killed, Timeout, RuntimeError, CompileError}`. A mutant whose baseline status is in
it must be in it in every run; if it is `Survived`, `NoCoverage`, `Ignored` or missing from the report, that is a
**lost detection**, `detect_diff=<k> lost`, and the run exits 3. This is the only failing condition. Everything
else is information: swaps inside the caught group (`Killed`→`Timeout`), `Survived`/`NoCoverage`→caught (the
candidate kills more), and mutants that were not in the baseline. They are counted in `status_swaps`,
summarised by kind in the `swaps (info):` line, and listed exactly in the summary JSON. A `Timeout` that
only appears when the machine was busy is a swap, not a failure; but if a lost detection only happens when the
machine was busy, re-run on an idle machine before investigating.
If the *baseline* runs themselves disagree about caught-ness, the fixture is nondeterministic and cannot
serve as a regression oracle until fixed; `--write-baseline` refuses to write in that case.

## Comparing against another build

`--compare <git-ref-or-worktree-path>` measures a reference build and this checkout's build
**alternately** inside one exclusive lock hold, so machine drift (steal, noisy neighbours, thermal) hits
both sides alike:

```sh
bun run bench -- --compare HEAD~3 --runs 5           # a commit
bun run bench -- --compare main --runs 5 --record "pool reuse vs main"
bun run bench -- --compare ../other-worktree         # an existing directory, used as it is
```

- `--runs N` is the number of **pairs**. Each pair runs ref and candidate once; the order alternates (pair 1
  ref first, pair 2 candidate first, ...).
- A git ref gets a temporary `git worktree add --detach` in `bench/out/ref-<sha>` (gitignored), a
  `bun install` there and a `bun run build` of its own `dist/`; the worktree is removed afterwards unless
  `--keep-ref` (then the next compare of the same sha reuses it). A directory is built in place (`--no-build`
  reuses its `dist/` if present). The candidate is this checkout, built as usual.
- Both sides run **this checkout's** harness, fixture and Stryker, with `BENCH_PLUGIN` pointing at each side's
  `dist/index.js`, so a ref that predates the harness works. The ref only has to build.
- Output per pair: `pair 2 (cand first): ref=28.1s cand=27.6s delta=-0.50s`; per side: median, min, max,
  spread; the paired delta (cand - ref, negative is faster) with its median, a 95% bootstrap interval of that
  median, how many pairs the candidate won, and the exact two-sided sign-test p-value (ties dropped; with N
  pairs the smallest possible p is `2/2^N`, so N below 5 can never reach p < 0.05). Then the gate for the
  candidate against the baseline (the reference's gate is printed on its own line), the drift/contamination lines
  as for a normal batch (over both sides together), and one line:

```
COMPARE ref=33e8e18 cand=cbc4076 pairs=5 ref_median=28.4s cand_median=27.9s delta_median=-0.50s (-1.8%) wins=4/5 p=0.375 detect_diff=OK status_swaps=0 runs_agree=yes contaminated_runs=0
```

- Run an A/A first (`--compare HEAD`) when you want to know what noise looks like: the delta should be about 0
  and p large.
- Read a result as: the delta median says how much, `wins=k/N` and `p` say whether it is consistent, the CI says
  how far the true median delta could be. A `CONTAMINATED` pair is flagged in its line; re-run rather than argue
  with it.
- `--record` appends a row: sha cell `cand vs ref`, delta cell = paired median delta with wins and p.
  `--write-baseline` cannot be combined with `--compare`. Exit code 3 if the candidate lost a detection.

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

| date | sha | label | runs | median | min–max | delta vs baseline | detect_diff |
| --- | --- | --- | ---: | ---: | --- | --- | --- |

Delta is the median compared with the median in `baseline.json` (negative is faster).
Record only 3-run results taken with no `WARNING`s; rows with lost detections are recorded too,
so a dead end is visible. The last cell is the gate plus notes (`swaps K→T:3`, `RUNS DISAGREE`, `n CONTAMINATED`).
A `--compare` row records the candidate's median and range, reads `<candidate> vs <reference>` in the sha cell,
and puts the paired delta, wins and p in the delta cell. (Older RESULTS.md files may still show the former
`status_diff` header.)

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
