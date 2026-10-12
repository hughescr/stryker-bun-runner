/**
 * Mutation-testing benchmark for this worktree's build of the runner.
 *
 *     bun run bench -- [--runs N] [--quick] [--fixture <dir>] [--no-build]
 *                      [--write-baseline] [--record "<label>"] [--json]
 *                      [--compare <git-ref-or-worktree-path> [--keep-ref]]
 *
 * Do not run this file directly: `bun run bench` takes the exclusive machine-wide
 * bench lock first (bench/lock.sh), and this script refuses to run without it.
 * See bench/README.md.
 */

/* eslint-disable no-console, n/no-process-exit, unicorn/no-process-exit -- a command-line script: its output is the point, and its exit code is the verdict */
/* eslint-disable n/no-sync -- the contamination sampler reads /proc synchronously so one sample is an atomic, millisecond-scale snapshot */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * Variables removed from the environment Stryker (and so every bun test worker) runs in. Agent sessions set
 * some of them, and bun then changes its output: with bun 1.4.2, AGENT, CLAUDECODE and REPL_ID switch `bun test`
 * to the quiet "AI agent" reporter that hides passing tests, and GITHUB_ACTIONS adds ::group:: annotations. A user
 * running Stryker by hand has none of them, so a benchmark taken with them set is not representative. The
 * rest are the other agent and CI markers bun's binary carries (CI_APP_ID, EAS_BUILD, TF_BUILD, ...) and the
 * usual agent and CI markers of other tools (found by probing: none of those changes bun test output, but they
 * are removed all the same). Removing a variable that was never set is a no-op.
 */
const STRIPPED_ENV: ReadonlySet<string> = new Set([
    // agents
    'AGENT', 'AI_AGENT', 'CLAUDECODE', 'REPL_ID', 'CURSOR_TRACE_ID', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_CI',
    'OPENCODE', 'OPENCODE_CLIENT', 'AUGMENT_AGENT',
    // CI
    'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID', 'TASK_ID', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITLAB_CI',
    'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'BUILDKITE', 'TEAMCITY_VERSION', 'APPVEYOR', 'TF_BUILD', 'EAS_BUILD',
    'CI_APP_ID', 'CI_BUILD_ID', 'CI_BUILD_NUMBER', 'CI_NAME', 'BUDDY_WORKSPACE_ID', 'HARNESS_BUILD_ID',
    'APPCENTER_BUILD_ID', 'CM_BUILD_ID', 'CF_BUILD_ID', 'RELEASE_BUILD_ID', 'PROW_JOB_ID', 'CODEBUILD_BUILD_ARN',
    'BITBUCKET_BUILD_NUMBER', 'DRONE', 'NETLIFY', 'VERCEL', 'NOW_BUILDER', 'SEMAPHORE',
]);
/** Everything the Claude Code sessions set (CLAUDECODE, CLAUDE_CODE_*, ...) and the agents' own prefixes. */
const STRIPPED_ENV_PREFIXES: readonly string[] = ['CLAUDE', 'CURSOR_', 'CODEX_', 'OPENCODE_', 'AUGMENT_', 'GEMINI_CLI'];

/** This process's environment minus the agent and CI markers, and the names that were removed (never the values). */
function cleanStrykerEnv(): { env: Record<string, string | undefined>, removed: string[] } {
    const env: Record<string, string | undefined> = {};
    const removed: string[] = [];
    for(const [name, value] of Object.entries(process.env)) {
        if(STRIPPED_ENV.has(name) || STRIPPED_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) {
            removed.push(name);
        } else {
            env[name] = value;
        }
    }
    return { env, removed: removed.toSorted((a, b) => a.localeCompare(b)) };
}

const strykerEnv = cleanStrykerEnv();

/** One line naming what was removed; the CLAUDE* family is summarised (the full list is in the summary JSON). */
function describeStrippedEnv(removed: readonly string[]): string {
    const claude = removed.filter(name => name.startsWith('CLAUDE'));
    const others = removed.filter(name => !name.startsWith('CLAUDE'));
    const shown = [...others, ...claude.length > 0 ? [`CLAUDE* (${String(claude.length)} variables, incl. ${claude.includes('CLAUDECODE') ? 'CLAUDECODE' : claude[0]})`] : []];
    return shown.length > 0 ? shown.join(', ') : 'none were set';
}

/** A run is CONTAMINATED if CPU used by processes outside the bench process tree exceeds this share of wall x CPUs. */
const CONTAMINATED_PCT = 2;

/** Mutation status by stable mutant key. */
type StatusMap = Record<string, string>;

/**
 * The gate: a mutant whose baseline status is in this group must still be in it in every run. Anything else
 * (Survived, NoCoverage, Ignored, or missing from the report) is a lost detection. Moves within the group
 * (Killed <-> Timeout ...) and Survived -> caught are informational swaps.
 */
const CAUGHT: ReadonlySet<string> = new Set(['Killed', 'Timeout', 'RuntimeError', 'CompileError']);
const STATUS_ABBREVIATION: Readonly<Record<string, string>> = {
    Killed:       'K',
    Timeout:      'T',
    Survived:     'S',
    NoCoverage:   'N',
    RuntimeError: 'R',
    CompileError: 'C',
    Ignored:      'I',
    Pending:      'P',
    '<absent>':   '-',
};
/** Distinct transitions listed in the `swaps:` line. */
const SHOWN_SWAP_KINDS = 8;
/** Resamples for the bootstrap interval of the median paired delta. */
const BOOTSTRAP_RESAMPLES = 10_000;

/** What the report says about one mutant; saved per run to make disagreements diagnosable. */
interface MutantDetail {
    readonly status:          string
    readonly id:              string
    readonly mutatorName:     string
    readonly file:            string
    readonly location:        string
    readonly statusReason?:   unknown
    readonly testsCompleted?: unknown
    readonly coveredBy?:      unknown
    readonly killedBy?:       unknown
}

/** One command's share of the CPU used by processes outside the bench process tree. */
interface ForeignCommand {
    readonly command:    string
    readonly cpuSeconds: number
    readonly processes:  number
}

/** What the monitor saw while one Stryker run executed (see ContaminationMonitor). */
interface Contamination {
    readonly contaminated:           boolean
    /** CPU used by processes outside the bench tree, minus the allowlist (claude) and kernel threads. */
    readonly foreignCpuSeconds:      number
    readonly foreignPct:             number
    readonly thresholdPct:           number
    readonly topForeign:             readonly ForeignCommand[]
    /** Allowlisted `claude` processes: reported, never hidden, not counted as foreign. */
    readonly claudeCpuSeconds:       number
    readonly kernelCpuSeconds:       number
    /** Bench process plus every descendant that was reaped (cutime/cstime), sampler included. */
    readonly treeCpuSeconds:         number
    /** user+nice+system from /proc/stat, all CPUs. */
    readonly systemBusyCpuSeconds:   number
    /** busy - tree - foreign - claude - kernel: short-lived processes the sampler missed, plus unattributable kernel time. */
    readonly unattributedCpuSeconds: number
    readonly stealPct:               number | undefined
    readonly iowaitPct:              number | undefined
    readonly stealPeakPct:           number | undefined
    readonly samples:                number
    readonly samplerMs:              number
}

/** A process left behind by a run: a descendant of the stryker run, or a `bun test` that is still alive. */
interface Orphan {
    readonly pid:     number
    readonly command: string
    readonly kind:    'run' | 'bun-test'
}

interface Leftovers {
    /** Orphans still alive after the grace period (the run's own are then SIGKILLed). */
    readonly orphans:       readonly Orphan[]
    /** Run descendants still alive the instant stryker exited. */
    readonly orphansAtExit: number
    readonly killed:        number
}

interface TmpSnapshot {
    readonly names: ReadonlySet<string>
    readonly bytes: number | undefined
}

/** Growth of os.tmpdir() since the previous snapshot (previous run's end, or the start of the batch). */
interface TmpGrowth {
    readonly entries: number
    readonly bytes:   number | undefined
    readonly added:   readonly string[]
}

interface RunResult {
    readonly index:         number
    readonly wallSeconds:   number
    readonly dryRunSeconds: number | undefined
    readonly tests:         number | undefined
    readonly mutants:       number
    readonly load1:         number
    readonly cpuBusyPct:    number | undefined
    readonly contention:    boolean
    /** Compare mode only: which side this run measured. */
    readonly side?:         'ref' | 'cand'
    readonly contamination: Contamination
    readonly leftovers:     Leftovers
    readonly tmpGrowth:     TmpGrowth
    readonly log:           string
    readonly statuses:      StatusMap
    readonly details:       Record<string, MutantDetail>
}

/** A mutant whose status differs between runs: one entry per run, in run order. */
interface Disagreement {
    readonly key:  string
    readonly runs: readonly MutantDetail[]
}

/** One mutant whose status in one run differs from the baseline. `lost` is the gate failure. */
interface StatusChange {
    readonly key:      string
    readonly expected: string
    readonly actual:   string
    readonly run:      number
    readonly lost:     boolean
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
    readonly compare:       string | undefined
    readonly keepRef:       boolean
}

interface Stats {
    readonly median:       number
    readonly min:          number
    readonly max:          number
    readonly spreadPct:    number
    readonly dryRunMedian: number | undefined
}

interface Analysis {
    readonly stats:            Stats
    readonly counts:           Record<string, number>
    /** False if some mutant is caught in one run and not caught in another. */
    readonly runsAgree:        boolean
    readonly runDisagreements: readonly Disagreement[]
    /** Mutants whose status differs between runs but stays on one side of the caught line (informational). */
    readonly runSwapCount:     number
    /** Every difference from the baseline, in run order. */
    readonly changes:          readonly StatusChange[]
    readonly lost:             readonly StatusChange[]
    readonly swaps:            readonly StatusChange[]
    readonly lostKeys:         number
    readonly swapSummary:      string
    /** `OK`, `NO_BASELINE` or `<n> lost`: the gate. */
    readonly detectDiff:       string
    readonly baseline:         BaselineJson | undefined
}

/** One side's wall times against the other's, run in alternation. */
interface Pairing {
    readonly pairs:       number
    /** cand - ref, seconds, per pair (negative: the candidate was faster). */
    readonly deltas:      readonly number[]
    readonly deltaMedian: number
    readonly deltaPct:    number
    readonly wins:        number
    readonly losses:      number
    /** Two-sided exact sign-test p-value (ties dropped). */
    readonly pValue:      number
    readonly ci95:        readonly [number, number]
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

/** Undoes what `--compare` set up (the temporary reference worktree). Synchronous: it also runs from die() and signal handlers. */
let pendingCleanup: (() => void) | undefined;

function runCleanup(): void {
    const cleanup = pendingCleanup;
    pendingCleanup = undefined;
    cleanup?.();
}

function die(message: string, code = EXIT_FAIL): never {
    console.error(`bench: ${message}`);
    runCleanup();
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
                compare:          { type: 'string' },
                'keep-ref':       { type: 'boolean', 'default': false },
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
    if(values.compare !== undefined && values['write-baseline']) {
        die('--write-baseline cannot be combined with --compare', EXIT_USAGE);
    }
    return {
        runs,
        fixture:       path.resolve(process.cwd(), values.fixture ?? path.join(benchDir, 'fixture')),
        build:         !values['no-build'],
        writeBaseline: values['write-baseline'],
        record:        values.record,
        json:          values.json,
        compare:       values.compare,
        keepRef:       values['keep-ref'],
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

async function capture(command: string, args: readonly string[], cwd = repoRoot): Promise<{ code: number | null, output: string }> {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function gitSha(cwd = repoRoot): Promise<string> {
    const git = Bun.which('git');
    if(!git) {
        return 'unknown';
    }
    const head = await capture(git, ['rev-parse', '--short', 'HEAD'], cwd);
    const status = await capture(git, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':!bench'], cwd);
    const sha = head.code === 0 ? head.output.trim() : 'unknown';
    return status.code === 0 && status.output.trim().length > 0 ? `${sha}+dirty` : sha;
}

async function build(dir = repoRoot, what = 'so dist/ matches the source'): Promise<void> {
    say(`bench: building (bun run build) ${what}...`);
    const started = performance.now();
    const { code, output } = await capture(process.execPath, ['run', 'build'], dir);
    if(code !== 0) {
        console.error(output);
        die(`bun run build failed in ${dir} (exit ${String(code)})`);
    }
    say(`bench: build ok in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

// -- machine load -------------------------------------------------------------

interface CpuTimes {
    readonly idle:  number
    readonly total: number
}

async function readCpuTimes(): Promise<CpuTimes | undefined> {
    const procStat = await readFile('/proc/stat', 'utf8').catch(() => '');
    const fields = procStat.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
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

// -- contamination monitor ----------------------------------------------------

/** USER_HZ, the unit of the CPU times in /proc/<pid>/stat: 100 on every mainstream Linux build. */
const CLK_TCK = 100;
/** How often the monitor walks /proc while Stryker runs. One walk is a few milliseconds. */
const SAMPLE_INTERVAL_MS = 250;
/** Smallest /proc/stat slice (all-CPU ticks) the peak steal is computed over: half a sample interval on 4 CPUs. */
const MIN_STEAL_SLICE_TICKS = 50;
/** `comm` names reported separately instead of counted as foreign (never hidden: the RUN line prints them). */
const ALLOWLIST_COMM: ReadonlySet<string> = new Set(['claude']);
/** PF_KTHREAD (bit 21 of the task flags): kernel threads such as kworker, which our own I/O makes busy. */
const PF_KTHREAD = 2 ** 21;
/** How long after stryker exits its descendants get to disappear before they count as orphans. */
const ORPHAN_GRACE_MS = 1500;
const ORPHAN_POLL_MS = 100;
const TOP_FOREIGN = 3;
const SHOWN_TMP_ENTRIES = 10;

interface ProcEntry {
    readonly pid:        number
    readonly ppid:       number
    readonly pgrp:       number
    readonly sid:        number
    readonly state:      string
    readonly comm:       string
    readonly kernel:     boolean
    /** utime + stime, in clock ticks, of the whole thread group. */
    readonly ticks:      number
    /** cutime + cstime: CPU of children this process has reaped. */
    readonly childTicks: number
    /** Start time in ticks since boot; with the pid it identifies a process even after pid reuse. */
    readonly start:      number
}

/** Parse /proc/<pid>/stat: `pid (comm) state ppid pgrp session tty tpgid flags ... utime stime cutime cstime ... starttime`. */
function parseProcStat(text: string): ProcEntry | undefined {
    const parenOpen = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if(parenOpen < 1 || close < parenOpen) {
        return undefined;
    }
    const rest = text.slice(close + 2).split(' ');
    const field = (index: number): number => Number(rest[index]);
    const entry = {
        pid:        Number(text.slice(0, parenOpen - 1)),
        ppid:       field(1),
        pgrp:       field(2),
        sid:        field(3),
        state:      rest[0],
        comm:       text.slice(parenOpen + 1, close),
        kernel:     Math.floor(field(6) / PF_KTHREAD) % 2 === 1,
        ticks:      field(11) + field(12),
        childTicks: field(13) + field(14),
        start:      field(19),
    };
    return Object.values(entry).some(value => typeof value === 'number' && Number.isNaN(value)) ? undefined : entry;
}

/** Every live process, from /proc/<pid>/stat (one small read each; processes that exit mid-walk are skipped). */
function readProcTable(): Map<number, ProcEntry> {
    const table = new Map<number, ProcEntry>();
    for(const name of readdirSync('/proc')) {
        if(!/^\d+$/.test(name)) {
            continue;
        }
        let text: string;
        try {
            text = readFileSync(`/proc/${name}/stat`, 'utf8');
        } catch{
            continue;
        }
        const entry = parseProcStat(text);
        if(entry) {
            table.set(entry.pid, entry);
        }
    }
    return table;
}

interface SystemCpu {
    /** user + nice + system, in ticks, all CPUs: the time processes (and kernel threads) are charged. irq/softirq are not charged to any process, so they are left out. */
    readonly busy:   number
    readonly iowait: number
    readonly steal:  number
    readonly total:  number
}

function readSystemCpu(): SystemCpu | undefined {
    let text: string;
    try {
        text = readFileSync('/proc/stat', 'utf8');
    } catch{
        return undefined;
    }
    const fields = text.split('\n', 1)[0].trim().split(/\s+/).slice(1, 9).map(Number);
    if(fields.length < 8 || fields.some(value => Number.isNaN(value))) {
        return undefined;
    }
    const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
    return { busy: user + nice + system, iowait, steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

/** A short label for aggregating CPU by command: `node child-process.js`, `bun test`, `claude`. */
function commandLabel(pid: number, comm: string): string {
    let raw = '';
    try {
        raw = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
    } catch{
        // exited since the stat read
    }
    const argv = raw.split('\0').filter(arg => arg.length > 0);
    if(argv.length === 0) {
        return comm;
    }
    const exe = path.basename(argv[0]);
    const sub = argv.slice(1).find(arg => !arg.startsWith('-'));
    if(sub === undefined) {
        return exe.slice(0, 48);
    }
    return `${exe} ${sub.includes('/') && !/\s/.test(sub) ? path.basename(sub) : sub}`.slice(0, 48);
}

function percent(part: number, whole: number): number | undefined {
    return whole > 0 ? 100 * part / whole : undefined;
}

function toSeconds(ticks: number): number {
    return ticks / CLK_TCK;
}

/**
 * Watches /proc while one Stryker run executes and accounts for CPU that is not ours.
 *
 * Every 250 ms it reads /proc/<pid>/stat for all processes. A process belongs to the bench tree if it descends
 * from this process (ppid walk), shares the detached stryker run's session or process group (so workers that
 * were reparented to init are still ours), or was classified as ours in an earlier sample (sticky). Everything
 * else is foreign: its CPU is the growth of utime+stime between samples, aggregated by command. `claude`
 * (ALLOWLIST_COMM) and kernel threads are tallied separately and do not count toward the CONTAMINATED flag.
 *
 * Limits: CPU of a process that starts and exits between two samples (or the last slice before it exits) is
 * invisible here; `unattributedCpuSeconds` (system busy time from /proc/stat minus everything attributed)
 * is the cross-check for that. The sampler runs in this process, so its own cost is in the bench tree, and
 * `samplerMs` reports how long it spent walking /proc.
 */
class ContaminationMonitor {
    private readonly treeKeys = new Set<string>();
    private readonly lastTicks = new Map<string, number>();
    private readonly kinds = new Map<string, { label: string, kind: 'foreign' | 'claude' | 'kernel' }>();
    private readonly byCommand = new Map<string, { ticks: number, pids: Set<number> }>();
    private foreignTicks = 0;
    private claudeTicks = 0;
    private kernelTicks = 0;
    private anchor:    number | undefined;
    private timer:     ReturnType<typeof setInterval> | undefined;
    private samples = 0;
    private samplerMs = 0;
    private baselined = false;
    private startCpu:  SystemCpu | undefined;
    private lastCpu:   SystemCpu | undefined;
    private stealPeak: number | undefined;
    private selfStart = 0;

    /** Take the baseline (everything alive now is not charged to the run) and start sampling. */
    start(): void {
        this.selfStart = this.selfTicks();
        this.startCpu = readSystemCpu();
        this.lastCpu = this.startCpu;
        this.sample();
        this.baselined = true;
        this.timer = setInterval(() => {
            this.sample();
        }, SAMPLE_INTERVAL_MS);
    }

    /** The detached stryker child: its session and process group identify its whole tree. */
    setAnchor(pid: number | undefined): void {
        this.anchor = pid;
    }

    private selfTicks(): number {
        try {
            const self = parseProcStat(readFileSync('/proc/self/stat', 'utf8'));
            return self ? self.ticks + self.childTicks : 0;
        } catch{
            return 0;
        }
    }

    private static keyOf(entry: ProcEntry): string {
        return `${String(entry.pid)}:${String(entry.start)}`;
    }

    private descendsFromBench(entry: ProcEntry, table: ReadonlyMap<number, ProcEntry>): boolean {
        let current: ProcEntry | undefined = entry;
        for(let depth = 0; current && depth < 64; depth++) {
            if(current.pid === process.pid) {
                return true;
            }
            current = table.get(current.ppid);
        }
        return false;
    }

    private inTree(entry: ProcEntry, table: ReadonlyMap<number, ProcEntry>): boolean {
        const key = ContaminationMonitor.keyOf(entry);
        if(this.treeKeys.has(key)) {
            return true;
        }
        const sharesAnchor = this.anchor !== undefined && (entry.sid === this.anchor || entry.pgrp === this.anchor);
        const ours = sharesAnchor || this.descendsFromBench(entry, table);
        if(ours) {
            this.treeKeys.add(key);
        }
        return ours;
    }

    private charge(entry: ProcEntry, key: string, delta: number): void {
        let known = this.kinds.get(key);
        if(!known) {
            if(entry.kernel) {
                known = { label: entry.comm, kind: 'kernel' };
            } else if(ALLOWLIST_COMM.has(entry.comm)) {
                known = { label: entry.comm, kind: 'claude' };
            } else {
                known = { label: commandLabel(entry.pid, entry.comm), kind: 'foreign' };
            }
            this.kinds.set(key, known);
        }
        if(known.kind === 'kernel') {
            this.kernelTicks += delta;
        } else if(known.kind === 'claude') {
            this.claudeTicks += delta;
        } else {
            this.foreignTicks += delta;
            const slot = this.byCommand.get(known.label) ?? { ticks: 0, pids: new Set<number>() };
            slot.ticks += delta;
            slot.pids.add(entry.pid);
            this.byCommand.set(known.label, slot);
        }
    }

    private sample(): void {
        const began = performance.now();
        const table = readProcTable();
        const live = new Set<string>();
        for(const entry of table.values()) {
            if(this.inTree(entry, table)) {
                continue;
            }
            const key = ContaminationMonitor.keyOf(entry);
            live.add(key);
            const previous = this.lastTicks.get(key);
            this.lastTicks.set(key, entry.ticks);
            // Unseen after the baseline: it started since the last sample, so all its CPU is the run's.
            const delta = entry.ticks - (previous ?? 0);
            if(this.baselined && delta > 0) {
                this.charge(entry, key, delta);
            }
        }
        for(const key of this.lastTicks.keys()) {
            if(!live.has(key)) {
                this.lastTicks.delete(key);
            }
        }
        const cpu = readSystemCpu();
        // Only judge slices of at least half an interval: a slice of a few ticks (the baseline and final samples) is all noise.
        if(cpu && this.lastCpu && cpu.total - this.lastCpu.total >= MIN_STEAL_SLICE_TICKS) {
            const peak = percent(cpu.steal - this.lastCpu.steal, cpu.total - this.lastCpu.total);
            if(peak !== undefined && peak > (this.stealPeak ?? 0)) {
                this.stealPeak = peak;
            }
            this.lastCpu = cpu;
        }
        this.samples++;
        this.samplerMs += performance.now() - began;
    }

    /** Stop the sampling timer (idempotent). */
    halt(): void {
        if(this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** Stop sampling and summarise. Call right after stryker exits. */
    stop(wallSeconds: number): Contamination {
        this.halt();
        this.sample();
        const end = readSystemCpu();
        const foreignCpuSeconds = toSeconds(this.foreignTicks);
        const claudeCpuSeconds = toSeconds(this.claudeTicks);
        const kernelCpuSeconds = toSeconds(this.kernelTicks);
        const treeCpuSeconds = toSeconds(this.selfTicks() - this.selfStart);
        const systemBusyCpuSeconds = this.startCpu && end ? toSeconds(end.busy - this.startCpu.busy) : Number.NaN;
        const capacity = wallSeconds * os.availableParallelism();
        const foreignPct = capacity > 0 ? 100 * foreignCpuSeconds / capacity : 0;
        const topForeign = [...this.byCommand.entries()]
            .toSorted(([, a], [, b]) => b.ticks - a.ticks)
            .slice(0, TOP_FOREIGN)
            .map(([command, slot]) => ({ command, cpuSeconds: toSeconds(slot.ticks), processes: slot.pids.size }));
        return {
            contaminated:           foreignPct > CONTAMINATED_PCT,
            foreignCpuSeconds,
            foreignPct,
            thresholdPct:           CONTAMINATED_PCT,
            topForeign,
            claudeCpuSeconds,
            kernelCpuSeconds,
            treeCpuSeconds,
            systemBusyCpuSeconds,
            unattributedCpuSeconds: systemBusyCpuSeconds - treeCpuSeconds - foreignCpuSeconds - claudeCpuSeconds - kernelCpuSeconds,
            stealPct:               this.startCpu && end ? percent(end.steal - this.startCpu.steal, end.total - this.startCpu.total) : undefined,
            iowaitPct:              this.startCpu && end ? percent(end.iowait - this.startCpu.iowait, end.total - this.startCpu.total) : undefined,
            stealPeakPct:           this.stealPeak,
            samples:                this.samples,
            samplerMs:              this.samplerMs,
        };
    }

    /**
     * Processes left over from the run: anything of the bench tree still alive (sticky set, session, process
     * group), and any `bun test` still alive that is not an ancestor of this process.
     */
    leftovers(): Orphan[] {
        const table = readProcTable();
        const ancestors = new Set<number>();
        for(let current = table.get(process.pid)?.ppid; current !== undefined && current > 0 && !ancestors.has(current); current = table.get(current)?.ppid) {
            ancestors.add(current);
        }
        const found: Orphan[] = [];
        for(const entry of table.values()) {
            if(entry.pid === process.pid || entry.state === 'Z' || entry.kernel) {
                continue;
            }
            if(this.inTree(entry, table)) {
                found.push({ pid: entry.pid, command: commandLabel(entry.pid, entry.comm), kind: 'run' });
            } else if(entry.comm === 'bun' && !ancestors.has(entry.pid)) {
                const command = commandLabel(entry.pid, entry.comm);
                if(command === 'bun test') {
                    found.push({ pid: entry.pid, command, kind: 'bun-test' });
                }
            }
        }
        return found;
    }
}

/**
 * After stryker exits: give its descendants a moment to go, report whatever survives, and SIGKILL the run's own
 * survivors so they cannot steal CPU from the next run. (`bun test` processes that are not ours are only reported.)
 */
async function reapLeftovers(monitor: ContaminationMonitor): Promise<Leftovers> {
    let orphans = monitor.leftovers();
    const orphansAtExit = orphans.filter(orphan => orphan.kind === 'run').length;
    const deadline = performance.now() + ORPHAN_GRACE_MS;
    while(orphans.some(orphan => orphan.kind === 'run') && performance.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling until the process table settles
        await Bun.sleep(ORPHAN_POLL_MS);
        orphans = monitor.leftovers();
    }
    let killed = 0;
    for(const orphan of orphans.filter(item => item.kind === 'run')) {
        try {
            process.kill(orphan.pid, 'SIGKILL');
            killed++;
        } catch{
            // gone already
        }
    }
    return { orphans, orphansAtExit, killed };
}

async function snapshotTmp(): Promise<TmpSnapshot> {
    const dir = os.tmpdir();
    const names = new Set(await readdir(dir).catch(() => [] as string[]));
    const du = Bun.which('du');
    let bytes: number | undefined;
    if(du) {
        // Exit code 1 just means some subdirectory was unreadable; the total is still printed.
        const { output } = await capture(du, ['-sb', '--one-file-system', dir]);
        const match = /^(\d+)\t/m.exec(output);
        bytes = match ? Number(match[1]) : undefined;
    }
    return { names, bytes };
}

function tmpGrowth(before: TmpSnapshot, after: TmpSnapshot): TmpGrowth {
    return {
        entries: after.names.size - before.names.size,
        bytes:   before.bytes === undefined || after.bytes === undefined ? undefined : after.bytes - before.bytes,
        added:   [...after.names].filter(name => !before.names.has(name)).toSorted((a, b) => a.localeCompare(b)).slice(0, SHOWN_TMP_ENTRIES),
    };
}

function formatBytes(bytes: number | undefined): string {
    if(bytes === undefined) {
        return 'n/a';
    }
    const sign = bytes < 0 ? '-' : '+';
    const size = Math.abs(bytes);
    if(size >= 2 ** 20) {
        return `${sign}${(size / 2 ** 20).toFixed(1)}MB`;
    }
    return `${sign}${(size / 2 ** 10).toFixed(0)}KB`;
}

const signedInt = (value: number): string => `${value >= 0 ? '+' : ''}${String(value)}`;
function pctText(value: number | undefined): string {
    return value === undefined ? 'n/a' : `${value.toFixed(1)}%`;
}

/** The fields appended to the RUN line. */
function contaminationFields(run: RunResult): string {
    const { contamination: c, leftovers, tmpGrowth: tmp } = run;
    return [
        `foreign=${c.foreignCpuSeconds.toFixed(1)}s`,
        `foreign_pct=${c.foreignPct.toFixed(1)}%`,
        `claude=${c.claudeCpuSeconds.toFixed(1)}s`,
        `steal=${pctText(c.stealPct)}`,
        `iowait=${pctText(c.iowaitPct)}`,
        `orphans=${String(leftovers.orphans.length)}`,
        `tmp=${signedInt(tmp.entries)}/${formatBytes(tmp.bytes)}`,
        ...c.contaminated ? ['CONTAMINATED'] : [],
    ].join(' ');
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
    readonly extras:      Pick<MutantDetail, 'coveredBy' | 'killedBy' | 'statusReason' | 'testsCompleted'>
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
        extras:      {
            statusReason:   raw.statusReason,
            testsCompleted: raw.testsCompleted,
            coveredBy:      raw.coveredBy,
            killedBy:       raw.killedBy,
        },
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
function uniqueKey(base: string, taken: Record<string, unknown>): string {
    let key = base;
    let n = 2;
    while(key in taken) {
        key = `${base}#${String(n)}`;
        n++;
    }
    return key;
}

async function buildMutantDetails(reportPath: string): Promise<Record<string, MutantDetail>> {
    const report = await readJson(reportPath);
    if(!isRecord(report) || !isRecord(report.files)) {
        throw new Error(`report ${reportPath} has no "files" object`);
    }
    const details: Record<string, MutantDetail> = {};
    for(const [file, value] of Object.entries(report.files)) {
        if(!isRecord(value) || !Array.isArray(value.mutants)) {
            throw new TypeError(`report: no mutants array for ${file}`);
        }
        // The report lists mutants in completion order, which varies between runs; number any collisions in id order.
        const mutants = (value.mutants as unknown[]).map(raw => parseMutant(file, raw))
            .toSorted((a, b) => Number(a.id) - Number(b.id));
        for(const mutant of mutants) {
            details[uniqueKey(mutantKey(file, mutant), details)] = {
                status:      mutant.status,
                id:          mutant.id,
                mutatorName: mutant.mutatorName,
                file,
                location:    `${String(mutant.line)}:${String(mutant.column)}-${String(mutant.endLine)}:${String(mutant.endColumn)}`,
                ...mutant.extras,
            };
        }
    }
    return details;
}

function statusesOf(details: Record<string, MutantDetail>): StatusMap {
    return Object.fromEntries(Object.entries(details).map(([key, detail]) => [key, detail.status]));
}

function absent(key: string): MutantDetail {
    return { status: '<absent>', id: '', mutatorName: '', file: key, location: '' };
}

const isCaught = (status: string): boolean => CAUGHT.has(status);

/**
 * Mutants caught in some runs and not in others (a key present in only some runs counts, as `<absent>`) are
 * disagreements. Mutants whose status differs between runs but stays on one side of the caught line are only counted.
 */
function findDisagreements(results: readonly RunResult[]): { disagreements: Disagreement[], swapped: number } {
    const keys = new Set(results.flatMap(run => Object.keys(run.details)));
    const found: Disagreement[] = [];
    let swapped = 0;
    for(const key of keys) {
        const runs = results.map(run => run.details[key] ?? absent(key));
        if(new Set(runs.map(detail => isCaught(detail.status))).size > 1) {
            found.push({ key, runs });
        } else if(new Set(runs.map(detail => detail.status)).size > 1) {
            swapped++;
        }
    }
    return { disagreements: found.toSorted((a, b) => a.key.localeCompare(b.key)), swapped };
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

function diffStatuses(expected: StatusMap, actual: StatusMap, run: number): StatusChange[] {
    const changes: StatusChange[] = [];
    for(const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const want = expected[key] ?? '<absent>';
        const got = actual[key] ?? '<absent>';
        if(want !== got) {
            changes.push({ key, expected: want, actual: got, run, lost: isCaught(want) && !isCaught(got) });
        }
    }
    return changes.toSorted((a, b) => a.key.localeCompare(b.key));
}

const abbreviate = (status: string): string => STATUS_ABBREVIATION[status] ?? status.slice(0, 1);

/** `K→T:3,S→K:1`: the informational swaps by kind, most frequent first. */
function summariseSwaps(swaps: readonly StatusChange[]): string {
    const kinds = new Map<string, number>();
    for(const swap of swaps) {
        const kind = `${abbreviate(swap.expected)}→${abbreviate(swap.actual)}`;
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const sorted = [...kinds.entries()].toSorted(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB));
    if(sorted.length === 0) {
        return 'none';
    }
    const shown = sorted.slice(0, SHOWN_SWAP_KINDS).map(([kind, count]) => `${kind}:${String(count)}`);
    return sorted.length > SHOWN_SWAP_KINDS ? `${shown.join(',')},…` : shown.join(',');
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
        runCleanup();
        process.exit(128 + os.constants.signals[signal]);
    });
}

async function runStryker(fixture: string, logPath: string, plugin: string, monitor: ContaminationMonitor): Promise<{ code: number | null, seconds: number, contamination: Contamination }> {
    const log = await open(logPath, 'a');
    try {
        monitor.start();
        const started = performance.now();
        const child = spawn(strykerBin, ['run'], {
            cwd:      fixture,
            stdio:    ['ignore', log.fd, log.fd],
            detached: true,
            env:      { ...strykerEnv.env, BENCH_PLUGIN: plugin },
        });
        activeChild = child;
        monitor.setAnchor(child.pid);
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        const seconds = (performance.now() - started) / 1000;
        return { code, seconds, contamination: monitor.stop(seconds) };
    } finally {
        monitor.halt();
        activeChild = undefined;
        await log.close();
    }
}

/** The RUN line, then the top foreign commands and any orphans. */
function printRun(result: RunResult, label: string): void {
    const { contamination, leftovers, wallSeconds, dryRunSeconds, tests, load1, contention, log } = result;
    say(`RUN ${label} wall=${wallSeconds.toFixed(1)}s dryrun=${dryRunSeconds?.toFixed(1) ?? 'n/a'}s tests=${String(tests ?? 'n/a')} mutants=${String(result.mutants)} load1=${load1.toFixed(2)}${contention ? ' LOAD-WARNING' : ''} log=${log} ${contaminationFields(result)}`);
    const { topForeign } = contamination;
    if(topForeign.length > 0) {
        const shown = topForeign.map(item => `${item.command} ${item.cpuSeconds.toFixed(2)}s (${String(item.processes)} proc)`);
        say(`  foreign top ${String(TOP_FOREIGN)}: ${shown.join(', ')}`);
    }
    for(const orphan of leftovers.orphans) {
        say(`  ORPHAN pid=${String(orphan.pid)} ${orphan.kind} ${orphan.command}${orphan.kind === 'run' ? ' (killed)' : ''}`);
    }
}

/** One Stryker run to measure: which plugin build, and how it is named in output and files. */
interface Step {
    /** 0-based position in the batch. */
    readonly sequence: number
    /** Run number (or pair number in compare mode), 1-based. */
    readonly number:   number
    /** `2/3` or `pair 2/3 ref`. */
    readonly label:    string
    /** File stem under bench/out/: `run2` or `pair2-ref`. */
    readonly stem:     string
    readonly plugin:   string
    readonly side?:    'ref' | 'cand'
}

async function benchOnce(options: Options, stamp: string, step: Step, batch: { tmp: TmpSnapshot }): Promise<RunResult> {
    const { label, sequence } = step;
    await Promise.all(['.stryker-tmp', 'reports'].map(dir => rm(path.join(options.fixture, dir), { recursive: true, force: true })));

    const load1 = os.loadavg()[0];
    const cpuBusyPct = await sampleCpuBusyPct();
    // The 1-minute load average lags: right after another benchmark (or this run's predecessor) it is high on an idle machine.
    // So the live CPU sample decides; the load average only decides when /proc/stat is unavailable, and only for run 1.
    const contention = cpuBusyPct === undefined ? sequence === 0 && load1 > 1 : cpuBusyPct > BUSY_WARN_PCT;
    const busy = cpuBusyPct === undefined ? 'n/a' : `${cpuBusyPct.toFixed(0)}%`;
    const warning = contention ? '  WARNING: machine not idle, timing is unreliable' : '';
    say(`bench: run ${label} starting (load1=${load1.toFixed(2)}, cpu_busy=${busy})${warning}`);

    const logPath = path.join(outDir, `${stamp}-${step.stem}.log`);
    const logRel = path.relative(repoRoot, logPath);
    const monitor = new ContaminationMonitor();
    const { code, seconds, contamination } = await runStryker(options.fixture, logPath, step.plugin, monitor);
    const leftovers = await reapLeftovers(monitor);
    const tmpAfter = await snapshotTmp();
    const growth = tmpGrowth(batch.tmp, tmpAfter);
    batch.tmp = tmpAfter;
    const log = await readFile(logPath, 'utf8');
    if(code !== 0) {
        console.error(log.split('\n').slice(-40).join('\n'));
        die(`stryker exited with ${String(code)} on run ${label}; full log: ${logRel}`);
    }
    const reportPath = path.join(options.fixture, 'reports', 'mutation', 'mutation.json');
    if(!await exists(reportPath)) {
        die(`run ${label}: stryker succeeded but wrote no ${reportPath}; log: ${logRel}`);
    }
    const details = await buildMutantDetails(reportPath);
    const statuses = statusesOf(details);
    const runPrefix = path.join(outDir, `${stamp}-${step.stem}`);
    await writeFile(`${runPrefix}-statuses.json`, `${JSON.stringify(Object.fromEntries(Object.entries(details).toSorted(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
    await copyFile(reportPath, `${runPrefix}-mutation.json`);
    const dry = parseDryRun(log);
    if(dry.seconds === undefined) {
        console.error(`bench: warning: no "Initial test run succeeded" line in ${logRel}`);
    }
    const result: RunResult = {
        index:         step.number,
        ...step.side === undefined ? {} : { side: step.side },
        wallSeconds:   seconds,
        dryRunSeconds: dry.seconds,
        tests:         dry.tests,
        mutants:       Object.keys(statuses).length,
        load1,
        cpuBusyPct,
        contention,
        contamination,
        leftovers,
        tmpGrowth:     growth,
        log:           logRel,
        statuses,
        details,
    };
    printRun(result, label);
    return result;
}

// -- analysis -----------------------------------------------------------------

function median(values: readonly number[]): number {
    const sorted = values.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface BatchHealth {
    readonly contaminatedRuns:   number
    readonly orphans:            number
    readonly tmpEntries:         number
    readonly tmpBytes:           number | undefined
    readonly stealMaxPct:        number | undefined
    readonly foreignMaxPct:      number
    /** Least-squares slope of wall time against run number, in seconds per run (the drift within the batch). */
    readonly trendSecondsPerRun: number
    readonly samplerPct:         number
}

function batchHealth(results: readonly RunResult[]): BatchHealth {
    const n = results.length;
    const meanIndex = (n - 1) / 2;
    const meanWall = results.reduce((sum, run) => sum + run.wallSeconds, 0) / n;
    const covariance = results.reduce((sum, run, i) => sum + (i - meanIndex) * (run.wallSeconds - meanWall), 0);
    const variance = results.reduce((sum, _run, i) => sum + (i - meanIndex) ** 2, 0);
    const bytes = results.map(run => run.tmpGrowth.bytes);
    const steals = results.map(run => run.contamination.stealPct).filter((value): value is number => value !== undefined);
    const wall = results.reduce((sum, run) => sum + run.wallSeconds, 0);
    return {
        contaminatedRuns:   results.filter(run => run.contamination.contaminated).length,
        orphans:            results.reduce((sum, run) => sum + run.leftovers.orphans.length, 0),
        tmpEntries:         results.reduce((sum, run) => sum + run.tmpGrowth.entries, 0),
        tmpBytes:           bytes.every((value): value is number => value !== undefined) ? bytes.reduce((sum, value) => sum + value, 0) : undefined,
        stealMaxPct:        steals.length > 0 ? Math.max(...steals) : undefined,
        foreignMaxPct:      Math.max(...results.map(run => run.contamination.foreignPct)),
        trendSecondsPerRun: variance > 0 ? covariance / variance : 0,
        samplerPct:         wall > 0 ? 100 * results.reduce((sum, run) => sum + run.contamination.samplerMs, 0) / 1000 / wall : 0,
    };
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
    const { disagreements, swapped } = findDisagreements(results);
    const baselineStatuses = await readJson(baselineStatusesPath) as StatusMap | undefined;
    const baseline = await readJson(baselineJsonPath) as BaselineJson | undefined;
    const changes = baselineStatuses
        ? results.flatMap(run => diffStatuses(baselineStatuses, run.statuses, run.index))
        : [];
    const lost = changes.filter(change => change.lost);
    const swaps = changes.filter(change => !change.lost);
    const lostKeys = new Set(lost.map(change => change.key)).size;
    let detectDiff = `${String(lostKeys)} lost`;
    if(!baselineStatuses) {
        detectDiff = 'NO_BASELINE';
    } else if(lostKeys === 0) {
        detectDiff = 'OK';
    }
    return {
        stats:            computeStats(results),
        counts:           countStatuses(first.statuses),
        runsAgree:        disagreements.length === 0,
        runDisagreements: disagreements,
        runSwapCount:     swapped,
        changes,
        lost,
        swaps,
        lostKeys,
        swapSummary:      summariseSwaps(swaps),
        detectDiff,
        baseline,
    };
}

/** The drift line and the contamination warnings that follow the BENCH summary line. */
function printHealth(health: BatchHealth): void {
    const slope = signed(health.trendSecondsPerRun, 2, 's/run');
    const foreignMax = `${health.foreignMaxPct.toFixed(1)}% (flag above ${String(CONTAMINATED_PCT)}%)`;
    say(`  drift: wall ${slope}; steal max ${pctText(health.stealMaxPct)}; foreign max ${foreignMax}; sampler cost ${health.samplerPct.toFixed(2)}% of one CPU`);
    if(health.contaminatedRuns > 0) {
        say(`BENCH-WARNING ${String(health.contaminatedRuns)} run(s) CONTAMINATED: processes outside the bench tree used more than ${String(CONTAMINATED_PCT)}% of wall x CPUs while Stryker ran; see the "foreign top" lines and re-run.`);
    }
    if(health.orphans > 0) {
        say(`BENCH-WARNING ${String(health.orphans)} process(es) outlived a run (orphans); the run's own were killed after the report. Find out what leaves them behind.`);
    }
}

/** Which mutants lost detection (the gate), disagree between runs, or merely swapped status (info). */
function printDetection(analysis: Analysis): void {
    if(analysis.swaps.length > 0 || analysis.runSwapCount > 0) {
        say(`  swaps (info): ${analysis.swapSummary} vs baseline (${String(analysis.swaps.length)} across runs); ${String(analysis.runSwapCount)} mutants changed status between runs without crossing the caught line`);
    }
    if(!analysis.runsAgree) {
        say(`\nRuns disagree on ${String(analysis.runDisagreements.length)} mutants: caught in some runs, not in others (up to ${String(SHOWN_MISMATCHES)} shown; per-run maps in bench/out/<stamp>-<run>-statuses.json):`);
        for(const d of analysis.runDisagreements.slice(0, SHOWN_MISMATCHES)) {
            const perRun = d.runs.map((detail, i) => `run${String(i + 1)}=${detail.status}(id ${detail.id || '-'})`).join(' ');
            say(`  ${d.key}\n    ${d.runs[0].mutatorName} at ${d.runs[0].file}:${d.runs[0].location}  ${perRun}`);
        }
    }
    if(analysis.lost.length > 0) {
        say(`\nLOST DETECTION vs baseline (${String(analysis.lost.length)} across runs, ${String(analysis.lostKeys)} distinct mutants; up to ${String(SHOWN_MISMATCHES)} shown):`);
        for(const m of analysis.lost.slice(0, SHOWN_MISMATCHES)) {
            say(`  run ${String(m.run)}: ${m.key}: baseline ${m.expected}, got ${m.actual}`);
        }
    }
}

function printReport(sha: string, results: readonly RunResult[], analysis: Analysis, health: BatchHealth): void {
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
        `detect_diff=${analysis.detectDiff}`,
        `status_swaps=${String(analysis.swaps.length)}`,
        `contaminated_runs=${String(health.contaminatedRuns)}`,
        `orphans=${String(health.orphans)}`,
        `tmp_growth=${signedInt(health.tmpEntries)}/${formatBytes(health.tmpBytes)}`,
    ].join(' '));
    printHealth(health);
    if(results.some(run => run.contention)) {
        say('BENCH-WARNING the machine was not idle at the start of at least one run; timings are unreliable (check for other CPU-heavy work).');
    }
    printDetection(analysis);
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

/** Append one row to RESULTS.md (created with its header on first use). */
async function appendRow(cells: readonly string[]): Promise<void> {
    if(!await exists(resultsMdPath)) {
        await writeFile(resultsMdPath, [
            '# Benchmark results',
            '',
            'One row per `bun run bench -- --record "<label>"`. Delta is the median wall time versus the median in `baseline.json`; a `--compare` row\'s delta is the paired median versus the reference build, and its sha cell reads `<candidate> vs <reference>`.',
            '',
            '| date | sha | label | runs | median | min–max | delta vs baseline | detect_diff |',
            '| --- | --- | --- | ---: | ---: | --- | --- | --- |',
            '',
        ].join('\n'));
    }
    const escaped = cells.map(cell => cell.replaceAll('|', String.raw`\|`).replaceAll('\n', ' '));
    await appendFile(resultsMdPath, `| ${escaped.join(' | ')} |\n`);
    say(`bench: recorded in ${path.relative(repoRoot, resultsMdPath)}`);
}

function detectCell(analysis: Analysis, contaminatedRuns: number): string {
    const parts = [analysis.detectDiff];
    if(analysis.swaps.length > 0) {
        parts.push(`swaps ${analysis.swapSummary}`);
    }
    if(!analysis.runsAgree) {
        parts.push('RUNS DISAGREE');
    }
    if(contaminatedRuns > 0) {
        parts.push(`${String(contaminatedRuns)} CONTAMINATED`);
    }
    return parts.join('; ');
}

async function appendResult(label: string, sha: string, runs: number, analysis: Analysis, contaminatedRuns: number): Promise<void> {
    const { stats, baseline } = analysis;
    const delta = baseline
        ? `${signed(100 * (stats.median - baseline.medianSeconds) / baseline.medianSeconds, 1, '%')} (${signed(stats.median - baseline.medianSeconds, 1, 's')})`
        : 'n/a';
    await appendRow([
        new Date().toISOString().slice(0, 16).replace('T', ' '),
        sha,
        label,
        String(runs),
        `${stats.median.toFixed(1)}s`,
        `${stats.min.toFixed(1)}–${stats.max.toFixed(1)}s`,
        delta,
        detectCell(analysis, contaminatedRuns),
    ]);
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

/** The gate and the informational swaps, as they go into a summary JSON. The per-mutant lists are complete. */
function detectionJson(analysis: Analysis): Record<string, unknown> {
    return {
        runsAgree:            analysis.runsAgree,
        detectDiff:           analysis.detectDiff,
        lostMutants:          analysis.lostKeys,
        statusSwaps:          analysis.swaps.length,
        swapSummary:          analysis.swapSummary,
        runSwapCount:         analysis.runSwapCount,
        lost:                 analysis.lost,
        swaps:                analysis.swaps,
        runDisagreements:     analysis.runDisagreements.slice(0, SHOWN_MISMATCHES),
        runDisagreementCount: analysis.runDisagreements.length,
    };
}

function stripMaps(results: readonly RunResult[]): Record<string, unknown>[] {
    return results.map(({ statuses: _statuses, details: _details, ...rest }) => rest);
}

async function writeSummary(options: Options, stamp: string, summary: Record<string, unknown>): Promise<void> {
    const full = { ...summary, strippedEnv: strykerEnv.removed };
    await writeFile(path.join(outDir, `${stamp}-summary.json`), `${JSON.stringify(full, null, 2)}\n`);
    if(options.json) {
        console.log(JSON.stringify(full));
    }
}

// -- --compare: interleaved reference vs candidate ------------------------------

interface RefBuild {
    readonly sha:    string
    readonly plugin: string
}

async function isDirectory(file: string): Promise<boolean> {
    const info = await stat(file).catch(() => undefined);
    return info?.isDirectory() ?? false;
}

/** Resolve a git ref and check it out as a detached worktree in bench/out/ref-<sha> (removed at exit unless kept). */
async function checkoutRef(git: string, spec: string, keep: boolean): Promise<{ sha: string, dir: string }> {
    const rev = await capture(git, ['rev-parse', '--verify', '--short', `${spec}^{commit}`]);
    if(rev.code !== 0) {
        return die(`--compare: ${spec} is neither a directory nor a git ref (${rev.output.trim()})`, EXIT_USAGE);
    }
    const sha = rev.output.trim();
    const dir = path.join(outDir, `ref-${sha}`);
    if(!await exists(dir)) {
        const added = await capture(git, ['worktree', 'add', '--detach', dir, sha]);
        if(added.code !== 0) {
            return die(`git worktree add ${dir} failed: ${added.output.trim()}`);
        }
    }
    if(!keep) {
        pendingCleanup = (): void => {
            Bun.spawnSync([git, 'worktree', 'remove', '--force', dir], { cwd: repoRoot });
            Bun.spawnSync([git, 'worktree', 'prune'], { cwd: repoRoot });
        };
    }
    return { sha, dir };
}

/**
 * Make the reference build: a directory given as `--compare` is used as is; a git ref gets a temporary
 * `git worktree add --detach` in bench/out/ref-<sha> (removed at exit unless --keep-ref). Each side is installed and
 * built once, in its own directory, so its dist/ resolves its own node_modules.
 */
async function prepareRef(options: Options): Promise<RefBuild> {
    const spec = options.compare ?? '';
    const git = Bun.which('git');
    if(!git) {
        return die('--compare needs git on PATH');
    }
    const asPath = path.resolve(process.cwd(), spec);
    let dir = asPath;
    let sha: string;
    if(await isDirectory(asPath)) {
        sha = await gitSha(asPath);
    } else {
        ({ sha, dir } = await checkoutRef(git, spec, options.keepRef));
    }
    if(!await exists(path.join(dir, 'node_modules'))) {
        say(`bench: bun install in reference ${sha} (${path.relative(repoRoot, dir)})...`);
        const installed = await capture(process.execPath, ['install'], dir);
        if(installed.code !== 0) {
            console.error(installed.output);
            return die(`bun install failed in ${dir}`);
        }
    }
    const plugin = path.join(dir, 'dist', 'index.js');
    if(options.build || !await exists(plugin)) {
        await build(dir, `the reference ${sha}`);
    }
    return { sha, plugin };
}

/** Two-sided exact sign test: probability, if wins and losses were equally likely, of a split at least this lopsided. Ties are dropped. */
function signTestP(wins: number, losses: number): number {
    const n = wins + losses;
    if(n === 0) {
        return 1;
    }
    let term = 1;
    let tail = 0;
    for(let i = 0; i <= Math.min(wins, losses); i++) {
        tail += term;
        term = term * (n - i) / (i + 1);
    }
    return Math.min(1, 2 * tail / 2 ** n);
}

/** 95% percentile-bootstrap interval of the median, with a fixed-seed LCG so the same data gives the same interval. */
function bootstrapMedianCi(values: readonly number[]): [number, number] {
    let state = 12_345;
    const next = (): number => {
        state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
        return state / 2 ** 32;
    };
    const medians: number[] = [];
    for(let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
        medians.push(median(values.map(() => values[Math.floor(next() * values.length)])));
    }
    medians.sort((a, b) => a - b);
    return [medians[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)], medians[Math.floor(0.975 * BOOTSTRAP_RESAMPLES)]];
}

function pairUp(ref: readonly RunResult[], cand: readonly RunResult[], refMedian: number): Pairing {
    const deltas = cand.map(run => run.wallSeconds - (ref.find(other => other.index === run.index)?.wallSeconds ?? Number.NaN));
    const wins = deltas.filter(delta => delta < 0).length;
    const losses = deltas.filter(delta => delta > 0).length;
    const deltaMedian = median(deltas);
    return {
        pairs:    deltas.length,
        deltas,
        deltaMedian,
        deltaPct: refMedian > 0 ? 100 * deltaMedian / refMedian : 0,
        wins,
        losses,
        pValue:   signTestP(wins, losses),
        ci95:     bootstrapMedianCi(deltas),
    };
}

function formatP(p: number): string {
    return p < 0.001 ? '<0.001' : p.toFixed(3);
}

function printComparison(refSha: string, candSha: string, results: readonly RunResult[], refStats: Stats, candStats: Stats, pairing: Pairing): void {
    say();
    for(const [i, delta] of pairing.deltas.entries()) {
        const pair = i + 1;
        const ref = results.find(run => run.index === pair && run.side === 'ref');
        const cand = results.find(run => run.index === pair && run.side === 'cand');
        const first = pair % 2 === 1 ? 'ref' : 'cand';
        const dirty = (ref?.contamination.contaminated ?? false) || (cand?.contamination.contaminated ?? false) ? ' CONTAMINATED' : '';
        say(`  pair ${String(pair)} (${first} first): ref=${ref?.wallSeconds.toFixed(1) ?? 'n/a'}s cand=${cand?.wallSeconds.toFixed(1) ?? 'n/a'}s delta=${signed(delta, 2, 's')}${dirty}`);
    }
    const describe = (name: string, stats: Stats): string => `  ${name}: median=${stats.median.toFixed(1)}s min=${stats.min.toFixed(1)}s max=${stats.max.toFixed(1)}s spread=${stats.spreadPct.toFixed(1)}%`;
    say(describe('ref ', refStats));
    say(describe('cand', candStats));
    const [low, high] = pairing.ci95;
    say(`  paired delta (cand - ref): median ${signed(pairing.deltaMedian, 2, 's')} (${signed(pairing.deltaPct, 1, '%')}), 95% bootstrap CI [${signed(low, 2, '')}, ${signed(high, 2, '')}]s, candidate faster in ${String(pairing.wins)}/${String(pairing.pairs)} pairs (slower in ${String(pairing.losses)}), sign-test p=${formatP(pairing.pValue)}`);
    say(`  ref=${refSha} cand=${candSha}; a small p with a delta beyond the CI of an A/A run means a real difference, a large p means noise`);
}

async function runCompare(options: Options, stamp: string, candSha: string): Promise<void> {
    const ref = await prepareRef(options);
    say(`bench: compare ref=${ref.sha} cand=${candSha} pairs=${String(options.runs)} fixture=${options.fixture} (ref plugin ${ref.plugin}, cand plugin ${pluginPath})`);
    const results: RunResult[] = [];
    const batch = { tmp: await snapshotTmp() };
    const total = options.runs * 2;
    for(let pair = 1; pair <= options.runs; pair++) {
        // The order alternates per pair (ref first, then cand first, ...), so a drift cannot favour one side.
        const order: readonly ('ref' | 'cand')[] = pair % 2 === 1 ? ['ref', 'cand'] : ['cand', 'ref'];
        for(const side of order) {
            const step: Step = {
                sequence: results.length,
                number:   pair,
                label:    `pair ${String(pair)}/${String(options.runs)} ${side}`,
                stem:     `pair${String(pair)}-${side}`,
                plugin:   side === 'ref' ? ref.plugin : pluginPath,
                side,
            };
            // eslint-disable-next-line no-await-in-loop -- benchmark runs must be strictly sequential
            results.push(await benchOnce(options, stamp, step, batch));
        }
    }
    runCleanup();
    if(results.length !== total) {
        die('internal error: missing runs');
    }

    const refRuns = results.filter(run => run.side === 'ref');
    const candRuns = results.filter(run => run.side === 'cand');
    const refAnalysis = await analyse(refRuns);
    const candAnalysis = await analyse(candRuns);
    const health = batchHealth(results);
    const pairing = pairUp(refRuns, candRuns, refAnalysis.stats.median);
    printComparison(ref.sha, candSha, results, refAnalysis.stats, candAnalysis.stats, pairing);
    const breakdown = Object.entries(candAnalysis.counts).map(([status, count]) => `${status}=${String(count)}`);
    say(`  statuses (cand): ${breakdown.join(' ')}`);
    printHealth(health);
    if(results.some(run => run.contention)) {
        say('BENCH-WARNING the machine was not idle at the start of at least one run; timings are unreliable (check for other CPU-heavy work).');
    }
    say(`  reference gate: detect_diff=${refAnalysis.detectDiff} status_swaps=${String(refAnalysis.swaps.length)} runs_agree=${refAnalysis.runsAgree ? 'yes' : 'NO'}`);
    printDetection(candAnalysis);
    const { stats: refStats } = refAnalysis;
    const { stats: candStats } = candAnalysis;
    say([
        `COMPARE ref=${ref.sha}`,
        `cand=${candSha}`,
        `pairs=${String(pairing.pairs)}`,
        `ref_median=${refStats.median.toFixed(1)}s`,
        `cand_median=${candStats.median.toFixed(1)}s`,
        `delta_median=${signed(pairing.deltaMedian, 2, 's')} (${signed(pairing.deltaPct, 1, '%')})`,
        `wins=${String(pairing.wins)}/${String(pairing.pairs)}`,
        `p=${formatP(pairing.pValue)}`,
        `detect_diff=${candAnalysis.detectDiff}`,
        `status_swaps=${String(candAnalysis.swaps.length)}`,
        `runs_agree=${candAnalysis.runsAgree ? 'yes' : 'NO'}`,
        `contaminated_runs=${String(health.contaminatedRuns)}`,
    ].join(' '));

    if(options.record !== undefined) {
        const note = `${options.record} (compare ref=${ref.sha})`;
        await appendRow([
            new Date().toISOString().slice(0, 16).replace('T', ' '),
            `${candSha} vs ${ref.sha}`,
            note,
            String(pairing.pairs),
            `${candStats.median.toFixed(1)}s`,
            `${candStats.min.toFixed(1)}–${candStats.max.toFixed(1)}s`,
            `${signed(pairing.deltaPct, 1, '%')} (${signed(pairing.deltaMedian, 2, 's')}) vs ref, wins ${String(pairing.wins)}/${String(pairing.pairs)}, p=${formatP(pairing.pValue)}`,
            detectCell(candAnalysis, health.contaminatedRuns),
        ]);
    }
    await writeSummary(options, stamp, {
        mode:             'compare',
        refSha:           ref.sha,
        candSha,
        pairs:            pairing.pairs,
        ref:              refStats,
        cand:             candStats,
        pairing,
        contaminatedRuns: health.contaminatedRuns,
        health,
        ...detectionJson(candAnalysis),
        refDetection:     detectionJson(refAnalysis),
        runDetails:       stripMaps(results),
    });
    if(candAnalysis.lostKeys > 0) {
        process.exit(EXIT_MISMATCH);
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
    say(`bench: removed from the Stryker environment (agent/CI markers that change bun's output): ${describeStrippedEnv(strykerEnv.removed)}`);

    if(options.compare !== undefined) {
        await runCompare(options, stamp, sha);
        return;
    }

    const results: RunResult[] = [];
    const batch = { tmp: await snapshotTmp() };
    for(let i = 0; i < options.runs; i++) {
        const step: Step = { sequence: i, number: i + 1, label: `${String(i + 1)}/${String(options.runs)}`, stem: `run${String(i + 1)}`, plugin: pluginPath };
        // eslint-disable-next-line no-await-in-loop -- benchmark runs must be strictly sequential
        results.push(await benchOnce(options, stamp, step, batch));
    }

    const analysis = await analyse(results);
    const health = batchHealth(results);
    printReport(sha, results, analysis, health);

    if(options.record !== undefined) {
        await appendResult(options.record, sha, results.length, analysis, health.contaminatedRuns);
    }
    if(options.writeBaseline) {
        if(analysis.runsAgree) {
            await writeBaseline(sha, results, analysis.stats);
        } else {
            console.error('bench: NOT writing baseline: the runs disagree with each other (a mutant is caught in some runs and not in others).');
        }
    }

    const { stats } = analysis;
    await writeSummary(options, stamp, {
        sha,
        runs:                results.length,
        medianSeconds:       stats.median,
        minSeconds:          stats.min,
        maxSeconds:          stats.max,
        spreadPct:           stats.spreadPct,
        dryRunMedianSeconds: stats.dryRunMedian ?? null,
        mutants:             results[0].mutants,
        statusCounts:        analysis.counts,
        ...detectionJson(analysis),
        contaminatedRuns:    health.contaminatedRuns,
        health,
        runDetails:          stripMaps(results),
    });
    if(analysis.lostKeys > 0) {
        process.exit(EXIT_MISMATCH);
    }
}

await main();
