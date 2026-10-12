/**
 * Mutation-testing benchmark for this worktree's build of the runner.
 *
 *     bun run bench -- [--runs N] [--quick] [--fixture <dir>] [--no-build]
 *                      [--write-baseline] [--record "<label>"] [--json]
 *
 * Do not run this file directly: `bun run bench` takes the exclusive machine-wide
 * bench lock first (bench/lock.sh), and this script refuses to run without it.
 * See bench/README.md.
 */

/* eslint-disable no-console, n/no-process-exit, unicorn/no-process-exit -- a command-line script: its output is the point, and its exit code is the verdict */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const repoRoot = path.resolve(import.meta.dir, '..');
const benchDir = path.join(repoRoot, 'bench');
const outDir = path.join(benchDir, 'out');
const pluginPath = path.join(repoRoot, 'dist', 'index.js');
/** BENCH_STRYKER_BIN replaces the Stryker executable; it exists only so the harness can be smoke-tested with a fake. */
const strykerBin = process.env.BENCH_STRYKER_BIN ?? path.join(repoRoot, 'node_modules', '.bin', 'stryker');
const baselineStatusesPath = path.join(benchDir, 'baseline-statuses.json');
const baselineJsonPath = path.join(benchDir, 'baseline.json');
const baselineMdPath = path.join(benchDir, 'BASELINE.md');
const resultsMdPath = path.join(benchDir, 'RESULTS.md');

/** Exit codes: 1 = harness or Stryker failure, 2 = usage, 3 = statuses differ from the baseline or between runs. */
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_MISMATCH = 3;
/** Mismatch detail lines printed per report. */
const SHOWN_MISMATCHES = 20;
/** Start-of-run system-wide CPU busy percentage above which timings are flagged as unreliable. */
const BUSY_WARN_PCT = 25;

/** Mutation status by stable mutant key. */
type StatusMap = Record<string, string>;

interface RunResult {
    readonly index:         number
    readonly wallSeconds:   number
    readonly dryRunSeconds: number | undefined
    readonly tests:         number | undefined
    readonly mutants:       number
    readonly load1:         number
    readonly cpuBusyPct:    number | undefined
    readonly contention:    boolean
    readonly log:           string
    readonly statuses:      StatusMap
}

interface Mismatch {
    readonly key:      string
    readonly expected: string
    readonly actual:   string
    readonly run:      number
}

interface BaselineJson {
    readonly date:                 string
    readonly sha:                  string
    readonly runs:                 number
    readonly medianSeconds:        number
    readonly minSeconds:           number
    readonly maxSeconds:           number
    readonly runSeconds:           readonly number[]
    readonly dryRunMedianSeconds?: number
    readonly mutants:              number
}

interface Options {
    readonly runs:          number
    readonly fixture:       string
    readonly build:         boolean
    readonly writeBaseline: boolean
    readonly record:        string | undefined
    readonly json:          boolean
}

interface Stats {
    readonly median:       number
    readonly min:          number
    readonly max:          number
    readonly spreadPct:    number
    readonly dryRunMedian: number | undefined
}

interface Analysis {
    readonly stats:              Stats
    readonly counts:             Record<string, number>
    readonly runsAgree:          boolean
    readonly runMismatches:      readonly Mismatch[]
    readonly baselineMismatches: readonly Mismatch[]
    readonly mismatchedKeys:     number
    readonly statusDiff:         string
    readonly baseline:           BaselineJson | undefined
}

let jsonMode = false;

/** Human-readable output; goes to stderr under --json so stdout stays one JSON document. */
function say(line = ''): void {
    if(jsonMode) {
        console.error(line);
    } else {
        console.log(line);
    }
}

function die(message: string, code = EXIT_FAIL): never {
    console.error(`bench: ${message}`);
    process.exit(code);
}

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch{
        return false;
    }
}

async function readJson(file: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch{
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// -- options and preconditions ------------------------------------------------

function parseOptions(): Options {
    let parsed;
    try {
        parsed = parseArgs({
            args:    Bun.argv.slice(2),
            options: {
                runs:             { type: 'string' },
                quick:            { type: 'boolean', 'default': false },
                fixture:          { type: 'string' },
                'no-build':       { type: 'boolean', 'default': false },
                'write-baseline': { type: 'boolean', 'default': false },
                record:           { type: 'string' },
                json:             { type: 'boolean', 'default': false },
            },
            allowPositionals: false,
        });
    } catch (error) {
        return die(error instanceof Error ? error.message : String(error), EXIT_USAGE);
    }
    const { values } = parsed;
    const runs = values.quick ? 1 : Number(values.runs ?? 3);
    if(!Number.isInteger(runs) || runs < 1) {
        die(`--runs must be a positive integer (got ${String(values.runs)})`, EXIT_USAGE);
    }
    return {
        runs,
        fixture:       path.resolve(process.cwd(), values.fixture ?? path.join(benchDir, 'fixture')),
        build:         !values['no-build'],
        writeBaseline: values['write-baseline'],
        record:        values.record,
        json:          values.json,
    };
}

/** Refuse to run unless bench/lock.sh handed us the exclusive lock. */
async function assertExclusiveLock(): Promise<void> {
    const held = process.env.STRYKER_BENCH_LOCK_HELD;
    const lock = process.env.STRYKER_BENCH_LOCK;
    const pid = process.env.STRYKER_BENCH_LOCK_PID;
    if(held !== 'exclusive' || !lock || !pid) {
        die('refusing to run without the exclusive bench lock.\n'
          + '  Run it through `bun run bench -- <args>` (= sh bench/lock.sh --exclusive -- bun bench/run.ts <args>).', EXIT_USAGE);
    }
    // The env var alone could be inherited stale; the holder file must name a live exclusive lock.sh.
    const holder = await readFile(`${lock}.holder`, 'utf8').catch(() => '');
    if(holder.split(' ')[0] !== pid || !holder.includes(' exclusive ')) {
        die(`bench lock holder file ${lock}.holder does not show exclusive holder pid ${pid}; refusing to run.`, EXIT_USAGE);
    }
}

async function capture(command: string, args: readonly string[]): Promise<{ code: number | null, output: string }> {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    const collect = (chunk: Buffer): void => {
        chunks.push(chunk.toString());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const code = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
    });
    return { code, output: chunks.join('') };
}

/** Short sha, with `+dirty` if tracked files outside bench/ differ from HEAD. */
async function gitSha(): Promise<string> {
    const git = Bun.which('git');
    if(!git) {
        return 'unknown';
    }
    const head = await capture(git, ['rev-parse', '--short', 'HEAD']);
    const status = await capture(git, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':!bench']);
    const sha = head.code === 0 ? head.output.trim() : 'unknown';
    return status.code === 0 && status.output.trim().length > 0 ? `${sha}+dirty` : sha;
}

async function build(): Promise<void> {
    say('bench: building (bun run build) so dist/ matches the source...');
    const started = performance.now();
    const { code, output } = await capture(process.execPath, ['run', 'build']);
    if(code !== 0) {
        console.error(output);
        die(`bun run build failed (exit ${String(code)})`);
    }
    say(`bench: build ok in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

// -- machine load -------------------------------------------------------------

interface CpuTimes {
    readonly idle:  number
    readonly total: number
}

async function readCpuTimes(): Promise<CpuTimes | undefined> {
    const stat = await readFile('/proc/stat', 'utf8').catch(() => '');
    const fields = stat.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    if(fields.length < 5 || fields.some(value => Number.isNaN(value))) {
        return undefined;
    }
    // idle + iowait
    return { idle: fields[3] + fields[4], total: fields.reduce((sum, value) => sum + value, 0) };
}

/** System-wide CPU busy percentage over about one second, or undefined if /proc/stat is unavailable. */
async function sampleCpuBusyPct(): Promise<number | undefined> {
    const before = await readCpuTimes();
    await Bun.sleep(1000);
    const after = await readCpuTimes();
    if(!before || !after || after.total === before.total) {
        return undefined;
    }
    return 100 * (1 - (after.idle - before.idle) / (after.total - before.total));
}

// -- Stryker log and report parsing -------------------------------------------

const ANSI = /\u001B\[[0-9;]*[A-Z]/gi;

interface DryRunInfo {
    readonly seconds: number | undefined
    readonly tests:   number | undefined
}

/**
 * Stryker 10 (core/dist/src/process/3-dry-run-executor.js) logs
 *   "Initial test run succeeded. Ran %s tests in %s (net %s ms, overhead %s ms)."
 * where the second %s is a whole-second human string ("12 seconds", "1 minute and 5 seconds").
 * net + overhead is the gross dry-run time in ms, so use that for precision.
 */
function parseDryRun(log: string): DryRunInfo {
    const match = /Initial test run succeeded\. Ran (\d+) tests? in [^(]+\(net (\d+) ms, overhead (\d+) ms\)/.exec(log.replaceAll(ANSI, ''));
    if(!match) {
        return { seconds: undefined, tests: undefined };
    }
    return { seconds: (Number(match[2]) + Number(match[3])) / 1000, tests: Number(match[1]) };
}

interface MutantEntry {
    readonly id:          string
    readonly mutatorName: string
    readonly replacement: string | undefined
    readonly status:      string
    readonly line:        number
    readonly column:      number
    readonly endLine:     number
    readonly endColumn:   number
}

function parseMutant(file: string, raw: unknown): MutantEntry {
    const start = isRecord(raw) && isRecord(raw.location) ? raw.location.start : undefined;
    const end = isRecord(raw) && isRecord(raw.location) ? raw.location.end : undefined;
    if(!isRecord(raw) || !isRecord(start) || !isRecord(end)
      || typeof raw.status !== 'string' || typeof raw.mutatorName !== 'string'
      || typeof start.line !== 'number' || typeof start.column !== 'number'
      || typeof end.line !== 'number' || typeof end.column !== 'number') {
        throw new TypeError(`report: malformed mutant in ${file}: ${JSON.stringify(raw)}`);
    }
    return {
        id:          String(raw.id),
        mutatorName: raw.mutatorName,
        replacement: typeof raw.replacement === 'string' ? raw.replacement : undefined,
        status:      raw.status,
        line:        start.line,
        column:      start.column,
        endLine:     end.line,
        endColumn:   end.column,
    };
}

/**
 * Stable key of a mutant: `<file>:<line>:<col>-<endLine>:<endCol>:<mutatorName>:<sha256(replacement)[0..10]>`.
 * The end position matters: Stryker can emit two mutants with the same start, mutator and replacement
 * that differ only in extent (`a || b` vs `a`, both replaced by `false`).
 * Stryker's own incremental mode identifies a mutant by file, location, mutator and replacement
 * (core incremental-differ.js), because its sequential numeric ids shift whenever earlier source changes.
 * A report with no `replacement` falls back to `id=<id>`.
 */
function mutantKey(file: string, mutant: MutantEntry): string {
    const tail = mutant.replacement === undefined
        ? `id=${mutant.id}`
        : createHash('sha256').update(mutant.replacement).digest('hex').slice(0, 10);
    const span = `${String(mutant.line)}:${String(mutant.column)}-${String(mutant.endLine)}:${String(mutant.endColumn)}`;
    return `${file}:${span}:${mutant.mutatorName}:${tail}`;
}

/** Mutants identical in file, extent, mutator and replacement (should not happen) get `#2`, `#3`... in the order given. */
function uniqueKey(base: string, statuses: StatusMap): string {
    let key = base;
    let n = 2;
    while(key in statuses) {
        key = `${base}#${String(n)}`;
        n++;
    }
    return key;
}

async function buildStatusMap(reportPath: string): Promise<StatusMap> {
    const report = await readJson(reportPath);
    if(!isRecord(report) || !isRecord(report.files)) {
        throw new Error(`report ${reportPath} has no "files" object`);
    }
    const statuses: StatusMap = {};
    for(const [file, value] of Object.entries(report.files)) {
        if(!isRecord(value) || !Array.isArray(value.mutants)) {
            throw new TypeError(`report: no mutants array for ${file}`);
        }
        // The report lists mutants in completion order, which varies between runs; number any collisions in id order.
        const mutants = (value.mutants as unknown[]).map(raw => parseMutant(file, raw))
            .toSorted((a, b) => Number(a.id) - Number(b.id));
        for(const mutant of mutants) {
            statuses[uniqueKey(mutantKey(file, mutant), statuses)] = mutant.status;
        }
    }
    return statuses;
}

function sortedEntries(map: StatusMap): [string, string][] {
    return Object.entries(map).toSorted(([a], [b]) => a.localeCompare(b));
}

function countStatuses(statuses: StatusMap): Record<string, number> {
    const counts: Record<string, number> = {};
    for(const status of Object.values(statuses)) {
        counts[status] = (counts[status] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)));
}

function diffStatuses(expected: StatusMap, actual: StatusMap, run: number): Mismatch[] {
    const mismatches: Mismatch[] = [];
    for(const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const want = expected[key] ?? '<absent>';
        const got = actual[key] ?? '<absent>';
        if(want !== got) {
            mismatches.push({ key, expected: want, actual: got, run });
        }
    }
    return mismatches.toSorted((a, b) => a.key.localeCompare(b.key));
}

// -- running Stryker ----------------------------------------------------------

let activeChild: ReturnType<typeof spawn> | undefined;

/** Kill Stryker's whole process group (it was started detached) so an abort leaves no workers behind. */
function killActive(): void {
    const pid = activeChild?.pid;
    if(pid !== undefined) {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch{
            // already gone
        }
    }
}

for(const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        killActive();
        process.exit(128 + os.constants.signals[signal]);
    });
}

async function runStryker(fixture: string, logPath: string): Promise<{ code: number | null, seconds: number }> {
    const log = await open(logPath, 'a');
    try {
        const started = performance.now();
        const child = spawn(strykerBin, ['run'], {
            cwd:      fixture,
            stdio:    ['ignore', log.fd, log.fd],
            detached: true,
            env:      { ...process.env, BENCH_PLUGIN: pluginPath },
        });
        activeChild = child;
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        return { code, seconds: (performance.now() - started) / 1000 };
    } finally {
        activeChild = undefined;
        await log.close();
    }
}

async function benchOnce(options: Options, stamp: string, index: number): Promise<RunResult> {
    const label = `${String(index + 1)}/${String(options.runs)}`;
    await Promise.all(['.stryker-tmp', 'reports'].map(dir => rm(path.join(options.fixture, dir), { recursive: true, force: true })));

    const load1 = os.loadavg()[0];
    const cpuBusyPct = await sampleCpuBusyPct();
    // Run 1's load average is clean evidence; later runs inherit the previous run's own load, so judge them by the live CPU sample.
    const contention = (index === 0 && load1 > 1) || (cpuBusyPct ?? 0) > BUSY_WARN_PCT;
    const busy = cpuBusyPct === undefined ? 'n/a' : `${cpuBusyPct.toFixed(0)}%`;
    const warning = contention ? '  WARNING: machine not idle, timing is unreliable' : '';
    say(`bench: run ${label} starting (load1=${load1.toFixed(2)}, cpu_busy=${busy})${warning}`);

    const logPath = path.join(outDir, `${stamp}-run${String(index + 1)}.log`);
    const logRel = path.relative(repoRoot, logPath);
    const { code, seconds } = await runStryker(options.fixture, logPath);
    const log = await readFile(logPath, 'utf8');
    if(code !== 0) {
        console.error(log.split('\n').slice(-40).join('\n'));
        die(`stryker exited with ${String(code)} on run ${label}; full log: ${logRel}`);
    }
    const reportPath = path.join(options.fixture, 'reports', 'mutation', 'mutation.json');
    if(!await exists(reportPath)) {
        die(`run ${label}: stryker succeeded but wrote no ${reportPath}; log: ${logRel}`);
    }
    const statuses = await buildStatusMap(reportPath);
    const dry = parseDryRun(log);
    if(dry.seconds === undefined) {
        console.error(`bench: warning: no "Initial test run succeeded" line in ${logRel}`);
    }
    const result: RunResult = {
        index:         index + 1,
        wallSeconds:   seconds,
        dryRunSeconds: dry.seconds,
        tests:         dry.tests,
        mutants:       Object.keys(statuses).length,
        load1,
        cpuBusyPct,
        contention,
        log:           logRel,
        statuses,
    };
    say(`RUN ${label} wall=${seconds.toFixed(1)}s dryrun=${dry.seconds?.toFixed(1) ?? 'n/a'}s tests=${String(dry.tests ?? 'n/a')} mutants=${String(result.mutants)} load1=${load1.toFixed(2)}${contention ? ' LOAD-WARNING' : ''} log=${logRel}`);
    return result;
}

// -- analysis -----------------------------------------------------------------

function median(values: readonly number[]): number {
    const sorted = values.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeStats(results: readonly RunResult[]): Stats {
    const wall = results.map(run => run.wallSeconds);
    const mid = median(wall);
    const min = Math.min(...wall);
    const max = Math.max(...wall);
    const dryTimes = results.map(run => run.dryRunSeconds).filter((value): value is number => value !== undefined);
    return {
        median:       mid,
        min,
        max,
        spreadPct:    mid > 0 ? (100 * (max - min)) / mid : 0,
        dryRunMedian: dryTimes.length > 0 ? median(dryTimes) : undefined,
    };
}

async function analyse(results: readonly RunResult[]): Promise<Analysis> {
    const [first] = results;
    const runMismatches = results.slice(1).flatMap(run => diffStatuses(first.statuses, run.statuses, run.index));
    const baselineStatuses = await readJson(baselineStatusesPath) as StatusMap | undefined;
    const baseline = await readJson(baselineJsonPath) as BaselineJson | undefined;
    const baselineMismatches = baselineStatuses
        ? results.flatMap(run => diffStatuses(baselineStatuses, run.statuses, run.index))
        : [];
    const mismatchedKeys = new Set(baselineMismatches.map(m => m.key)).size;
    let statusDiff = `${String(mismatchedKeys)} mismatches vs baseline`;
    if(!baselineStatuses) {
        statusDiff = 'NO_BASELINE';
    } else if(mismatchedKeys === 0) {
        statusDiff = 'OK';
    }
    return {
        stats:     computeStats(results),
        counts:    countStatuses(first.statuses),
        runsAgree: runMismatches.length === 0,
        runMismatches,
        baselineMismatches,
        mismatchedKeys,
        statusDiff,
        baseline,
    };
}

function printReport(sha: string, results: readonly RunResult[], analysis: Analysis): void {
    const { stats, counts, runsAgree } = analysis;
    say();
    for(const run of results) {
        const note = run.contention ? ' (contention)' : '';
        say(`  run ${String(run.index)}: wall=${run.wallSeconds.toFixed(1)}s dryrun=${run.dryRunSeconds?.toFixed(1) ?? 'n/a'}s load1=${run.load1.toFixed(2)}${note}`);
    }
    const breakdown = Object.entries(counts).map(([status, count]) => `${status}=${String(count)}`);
    say(`  statuses: ${breakdown.join(' ')}`);
    say([
        `BENCH sha=${sha}`,
        `runs=${String(results.length)}`,
        `median=${stats.median.toFixed(1)}s`,
        `min=${stats.min.toFixed(1)}s`,
        `max=${stats.max.toFixed(1)}s`,
        `spread=${stats.spreadPct.toFixed(1)}%`,
        `dryrun_median=${stats.dryRunMedian?.toFixed(1) ?? 'n/a'}s`,
        `mutants=${String(results[0].mutants)}`,
        `runs_agree=${runsAgree ? 'yes' : 'NO'}`,
        `status_diff=${analysis.statusDiff}`,
    ].join(' '));
    if(results.some(run => run.contention)) {
        say('BENCH-WARNING the machine was not idle at the start of at least one run; timings are unreliable (check for other CPU-heavy work).');
    }
    if(!runsAgree) {
        say(`\nRuns disagree with each other (${String(analysis.runMismatches.length)} differences vs run 1; up to ${String(SHOWN_MISMATCHES)} shown):`);
        for(const m of analysis.runMismatches.slice(0, SHOWN_MISMATCHES)) {
            say(`  ${m.key}: run 1 ${m.expected}, run ${String(m.run)} ${m.actual}`);
        }
    }
    if(analysis.baselineMismatches.length > 0) {
        say(`\nStatus mismatches vs baseline (${String(analysis.baselineMismatches.length)} across runs, ${String(analysis.mismatchedKeys)} distinct mutants; up to ${String(SHOWN_MISMATCHES)} shown):`);
        for(const m of analysis.baselineMismatches.slice(0, SHOWN_MISMATCHES)) {
            say(`  run ${String(m.run)}: ${m.key}: baseline ${m.expected}, got ${m.actual}`);
        }
    }
}

// -- baseline and results files -----------------------------------------------

function signed(value: number, digits: number, suffix: string): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`;
}

function describeBaselineMarkdown(sha: string, date: string, results: readonly RunResult[], stats: Stats): string {
    const [first] = results;
    const wall = results.map(run => run.wallSeconds);
    const cpuModel = os.cpus()[0]?.model ?? 'unknown';
    const machine = `${String(os.availableParallelism())} CPUs, ${cpuModel}, ${String(Math.round(os.totalmem() / 2 ** 30))} GiB RAM, ${os.type()} ${os.release()}`;
    const dry = stats.dryRunMedian === undefined ? 'n/a' : `${stats.dryRunMedian.toFixed(1)}s`;
    const perRun = wall.map(s => `${s.toFixed(1)}s`).join(', ');
    return [
        '# Benchmark baseline',
        '',
        'Written by `bun run bench -- --write-baseline`. Do not edit by hand; the per-mutant statuses in',
        '`baseline-statuses.json` are the invariant every later run is compared against.',
        '',
        `- Date: ${date}`,
        `- Commit: ${sha}`,
        `- Machine: ${machine}`,
        `- Bun: ${Bun.version}`,
        `- Runs: ${String(results.length)}`,
        `- Per-run wall time: ${perRun}`,
        `- Median: ${stats.median.toFixed(1)}s (min ${stats.min.toFixed(1)}s, max ${stats.max.toFixed(1)}s)`,
        `- Dry run (median): ${dry}`,
        `- Tests in dry run: ${String(first.tests ?? 'n/a')}`,
        `- Mutants: ${String(first.mutants)}`,
        '',
        '## Status breakdown',
        '',
        '| Status | Count |',
        '| --- | ---: |',
        ...Object.entries(countStatuses(first.statuses)).map(([status, count]) => `| ${status} | ${String(count)} |`),
        '',
    ].join('\n');
}

async function writeBaseline(sha: string, results: readonly RunResult[], stats: Stats): Promise<void> {
    const [first] = results;
    const date = new Date().toISOString();
    await writeFile(baselineStatusesPath, `${JSON.stringify(Object.fromEntries(sortedEntries(first.statuses)), null, 1)}\n`);
    const baseline: BaselineJson = {
        date,
        sha,
        runs:          results.length,
        medianSeconds: stats.median,
        minSeconds:    stats.min,
        maxSeconds:    stats.max,
        runSeconds:    results.map(run => run.wallSeconds),
        ...stats.dryRunMedian === undefined ? {} : { dryRunMedianSeconds: stats.dryRunMedian },
        mutants:       first.mutants,
    };
    await writeFile(baselineJsonPath, `${JSON.stringify(baseline, null, 2)}\n`);
    await writeFile(baselineMdPath, describeBaselineMarkdown(sha, date, results, stats));
    say(`bench: wrote ${[baselineStatusesPath, baselineJsonPath, baselineMdPath].map(file => path.relative(repoRoot, file)).join(', ')}`);
    if(sha.endsWith('+dirty')) {
        say('bench: warning: baseline written from a dirty tree');
    }
}

async function appendResult(label: string, sha: string, runs: number, analysis: Analysis): Promise<void> {
    if(!await exists(resultsMdPath)) {
        await writeFile(resultsMdPath, [
            '# Benchmark results',
            '',
            'One row per `bun run bench -- --record "<label>"`. Delta is the median wall time versus the median in `baseline.json`.',
            '',
            '| date | sha | label | runs | median | min–max | delta vs baseline | status_diff |',
            '| --- | --- | --- | ---: | ---: | --- | --- | --- |',
            '',
        ].join('\n'));
    }
    const { stats, baseline } = analysis;
    const delta = baseline
        ? `${signed(100 * (stats.median - baseline.medianSeconds) / baseline.medianSeconds, 1, '%')} (${signed(stats.median - baseline.medianSeconds, 1, 's')})`
        : 'n/a';
    const cells = [
        new Date().toISOString().slice(0, 16).replace('T', ' '),
        sha,
        label,
        String(runs),
        `${stats.median.toFixed(1)}s`,
        `${stats.min.toFixed(1)}–${stats.max.toFixed(1)}s`,
        delta,
        analysis.runsAgree ? analysis.statusDiff : `${analysis.statusDiff}; RUNS DISAGREE`,
    ].map(cell => cell.replaceAll('|', String.raw`\|`).replaceAll('\n', ' '));
    await appendFile(resultsMdPath, `| ${cells.join(' | ')} |\n`);
    say(`bench: recorded in ${path.relative(repoRoot, resultsMdPath)}`);
}

// -- main ---------------------------------------------------------------------

async function checkPreconditions(options: Options): Promise<void> {
    await assertExclusiveLock();
    if(!await exists(strykerBin)) {
        die(`${strykerBin} not found; run \`bun install\` in ${repoRoot}`);
    }
    if(!await exists(path.join(options.fixture, 'stryker.conf.mjs'))) {
        die(`fixture ${options.fixture} has no stryker.conf.mjs`, EXIT_USAGE);
    }
    if(options.build) {
        await build();
    } else if(!await exists(pluginPath)) {
        die('--no-build given but dist/index.js does not exist; run `bun run build`', EXIT_USAGE);
    }
}

async function main(): Promise<void> {
    const options = parseOptions();
    jsonMode = options.json;
    await checkPreconditions(options);

    const sha = await gitSha();
    const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').slice(0, 15);
    await mkdir(outDir, { recursive: true });
    say(`bench: sha=${sha} fixture=${options.fixture} runs=${String(options.runs)} plugin=${pluginPath}`);

    const results: RunResult[] = [];
    for(let i = 0; i < options.runs; i++) {
        // eslint-disable-next-line no-await-in-loop -- benchmark runs must be strictly sequential
        results.push(await benchOnce(options, stamp, i));
    }

    const analysis = await analyse(results);
    printReport(sha, results, analysis);

    if(options.record !== undefined) {
        await appendResult(options.record, sha, results.length, analysis);
    }
    if(options.writeBaseline) {
        if(analysis.runsAgree) {
            await writeBaseline(sha, results, analysis.stats);
        } else {
            console.error('bench: NOT writing baseline: the runs disagree with each other.');
        }
    }

    const { stats } = analysis;
    const summary = {
        sha,
        runs:                results.length,
        medianSeconds:       stats.median,
        minSeconds:          stats.min,
        maxSeconds:          stats.max,
        spreadPct:           stats.spreadPct,
        dryRunMedianSeconds: stats.dryRunMedian ?? null,
        mutants:             results[0].mutants,
        statusCounts:        analysis.counts,
        runsAgree:           analysis.runsAgree,
        statusDiff:          analysis.statusDiff,
        mismatches:          analysis.baselineMismatches.slice(0, SHOWN_MISMATCHES),
        runDetails:          results.map(({ statuses: _statuses, ...rest }) => rest),
    };
    await writeFile(path.join(outDir, `${stamp}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    if(options.json) {
        console.log(JSON.stringify(summary));
    }
    if(!analysis.runsAgree || analysis.mismatchedKeys > 0) {
        process.exit(EXIT_MISMATCH);
    }
}

await main();
