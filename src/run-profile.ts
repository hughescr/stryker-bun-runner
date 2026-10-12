/**
 * Opt-in timing profile of every dry and mutant run, for finding where the
 * wall-clock of a `stryker run` goes.
 *
 * Off unless {@link PROFILE_ENV} names an absolute file. Then each worker
 * appends one JSON line per run to it ({@link RunRecord}) and one summary line
 * when it is disposed ({@link WorkerSummary}); `bun bench/profile-summary.ts
 * <file>` turns the file into tables. With the variable unset no profile object
 * exists, so a run costs one nullish check per hook and nothing else: no clock
 * reads, no allocations, no I/O.
 *
 * A run is timed from the Node side as a chain of marks:
 *
 *     requested → spawnStart → spawned → firstStderr → [inspector] → firstFile
 *               → decisive → exit → close → returned
 *
 * and each gap between two consecutive marks that were recorded belongs to one
 * phase ({@link PHASES}), so a run's phases always add up to its total. A mark
 * that never happened (a child killed while loading prints no decisive line)
 * leaves its gap to the phase before it, which is where the time went.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '@stryker-mutator/api/logging';
import { HIT_LIMIT_SENTINEL } from './coverage/preload-logic.js';
import type { InspectorEventHandlers } from './inspector/inspector-client.js';
import { fileHeaderRe, RAN_LINE } from './parsers/console-parser.js';
import { PROFILE_ENV, stripAnsi } from './process-runner.js';

export { PROFILE_ENV } from './process-runner.js';

/** Version of the JSON line shapes below; bumped on any incompatible change. */
export const PROFILE_FORMAT_VERSION = 1;

/** The marks in one bun child's life, in the order they normally happen. */
export const SPAWN_MARKS = ['spawnStart', 'spawned', 'firstStderr', 'inspector', 'firstFile', 'decisive', 'exit', 'close'] as const;
export type SpawnMark = typeof SPAWN_MARKS[number];
type RunMark = 'requested' | SpawnMark | 'returned';

/**
 * The phases of a run, in order:
 *
 * - `prep`: the runner's work before it spawns (registry load, pattern, file list; the sync server in a dry run)
 * - `spawn`: building argv and env, and the spawn() call itself
 * - `startup`: bun's own start, up to its first byte on stderr (its `bun test` banner)
 * - `inspector`: dry run only: waiting for the inspector URL, connecting, and `TestReporter.enable`
 * - `load`: the preloads (ours and the user's) and loading the first test file
 * - `tests`: from the first test file's header (or first TestReporter event) to the decisive line
 * - `teardown`: from the decisive line (the failing test under bail, the hit-limit report, or bun's summary) to the child's exit
 * - `stdio`: from the child's exit to its stdout and stderr closing
 * - `finish`: the runner's work after that (parsing, scoring; the dry run's drain, coverage and checks)
 */
export const PHASES = ['prep', 'spawn', 'startup', 'inspector', 'load', 'tests', 'teardown', 'stdio', 'finish'] as const;
export type Phase = typeof PHASES[number];

/** The phase that runs from each mark to the next mark recorded. */
const PHASE_FROM: Record<Exclude<RunMark, 'returned'>, Phase> = {
    requested:   'prep',
    spawnStart:  'spawn',
    spawned:     'startup',
    firstStderr: 'load',
    inspector:   'load',
    firstFile:   'tests',
    decisive:    'teardown',
    exit:        'stdio',
    close:       'finish',
};

/** What ended a child's useful work, as read from its stderr. */
export type DecisiveKind = 'fail' | 'hitLimit' | 'summary';
export type RunKind = 'dry' | 'mutant';
/**
 * Which tests a run handed bun: `dry` (the dry run), `targeted` (the covering tests, by
 * pattern), `static` (the full suite: the mutant has no covering tests), `fallback` (the
 * full suite although it had covering tests: pattern too long, or the zero-match retry),
 * `files` (the files Stryker's own testFiles option gave, without a pattern).
 */
export type RunScope = 'dry' | 'targeted' | 'static' | 'fallback' | 'files';

/** The scope of a mutant-run spawn, from what {@link BunTestRunner.executeMutantRun} decided. */
export function mutantRunScope(fileScoped: boolean, testNamePattern: string | undefined, coveringTestCount: number): RunScope {
    if(fileScoped) {
        return 'files';
    }
    if(testNamePattern !== undefined) {
        return 'targeted';
    }
    return coveringTestCount > 0 ? 'fallback' : 'static';
}

/** Clock the profile reads; injectable so tests can drive it. */
export interface ProfileClock {
    /** Monotonic milliseconds. */
    now:    () => number
    /** Epoch milliseconds at which {@link now} read 0. */
    origin: number
}

const systemClock: ProfileClock = { now: () => performance.now(), origin: performance.timeOrigin };

/** One run's JSON line. Times are milliseconds; marks are relative to `requested`. */
export interface RunRecord {
    type:          'run'
    v:             number
    pid:           number
    kind:          RunKind
    /** The mutant's id; absent for the dry run. */
    mutant?:       string
    /** The status returned to Stryker: a MutantRunStatus for mutant runs, a DryRunStatus for the dry run. */
    status:        string
    scope?:        RunScope
    /** Test files handed to bun; absent when none were (bun found them itself). */
    files?:        number
    /** UTF-8 bytes of the --test-name-pattern; absent without one. */
    patternBytes?: number
    /** bun children spawned (2 for a zero-match retry, 0 when none could be). */
    spawns:        number
    /** Whether the last child ran with --bail. */
    bail?:         boolean
    /** What the last child's decisive line was; absent when it printed none (killed, crashed). */
    decisive?:     DecisiveKind
    /** Test-file headers the last child printed up to its decisive line (with bail: the file that killed, counted). */
    fileHeaders?:  number
    startEpochMs:  number
    totalMs:       number
    /** Each child's marks, relative to `requested`. */
    marks:         Partial<Record<SpawnMark, number>>[]
    phases:        Partial<Record<Phase, number>>
}

/** Count, sum, mean and nearest-rank p50/p95 of a set of values. */
export interface Stats {
    count: number
    sum:   number
    mean:  number
    p50:   number
    p95:   number
}

/** The aggregate of one group of runs (see {@link groupKeys}). */
export interface GroupStats {
    runs:         number
    totalMs:      Stats
    files?:       Stats
    fileHeaders?: Stats
    /** Per phase, over the runs that had it. */
    phases:       Partial<Record<Phase, Stats>>
    /** Each phase's share of the group's summed total. */
    phaseShare:   Partial<Record<Phase, number>>
}

/** A worker's summary line, written when the runner is disposed. */
export interface WorkerSummary {
    type:              'summary'
    v:                 number
    pid:               number
    runs:              number
    createdEpochMs:    number
    firstRunEpochMs:   number
    endEpochMs:        number
    /** From the first run's request to the summary. */
    wallMs:            number
    /** Sum of every run's total. */
    busyMs:            number
    dryRunMs:          number
    dryRunShareOfBusy: number
    dryRunShareOfWall: number
    groups:            Record<string, GroupStats>
}

/** Round to a microsecond, which keeps the lines short and loses nothing measurable. */
function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function share(part: number, whole: number): number {
    return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;
}

/**
 * The phases of one run, from its marks in canonical order (`requested` first,
 * `returned` last). Each gap goes to the phase that starts at its earlier mark
 * ({@link PHASE_FROM}), except that a gap ending at `inspector` is the
 * `inspector` phase. A mark earlier than the one kept before it is out of order
 * (stderr read after the exit event, say) and is skipped, as is any mark after
 * the last one, so the phases always sum to last minus first.
 */
export function computePhases(sequence: readonly (readonly [RunMark, number])[]): Partial<Record<Phase, number>> {
    const phases: Partial<Record<Phase, number>> = {};
    if(sequence.length === 0) {
        return phases;
    }
    const end = sequence.at(-1)![1];
    let [previousMark, previousAt] = sequence[0];
    for(const [mark, at] of sequence.slice(1)) {
        if(at < previousAt || at > end) {
            continue;
        }
        const phase = mark === 'inspector' ? 'inspector' : PHASE_FROM[previousMark as Exclude<RunMark, 'returned'>];
        phases[phase] = (phases[phase] ?? 0) + (at - previousAt);
        previousMark = mark;
        previousAt = at;
    }
    return phases;
}

/** Nearest-rank percentile (`q` in 0..1) of ascending, non-empty `sorted`. */
export function percentile(sorted: readonly number[], q: number): number {
    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** {@link Stats} of non-empty `values`. */
export function summarize(values: readonly number[]): Stats {
    const sorted = values.toSorted((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        count: sorted.length,
        sum:   round3(sum),
        mean:  round3(sum / sorted.length),
        p50:   round3(percentile(sorted, 0.5)),
        p95:   round3(percentile(sorted, 0.95)),
    };
}

/**
 * The groups a run is counted in: `all`; `dry` and `dry/<status>`; or `mutant`,
 * `mutant/<status>`, `mutant/*\/<scope>` and `mutant/<status>/<scope>`.
 */
export function groupKeys(record: RunRecord): string[] {
    if(record.kind === 'dry') {
        return ['all', 'dry', `dry/${record.status}`];
    }
    const scope = record.scope ?? 'unknown';
    return ['all', 'mutant', `mutant/${record.status}`, `mutant/*/${scope}`, `mutant/${record.status}/${scope}`];
}

function optionalStats(values: number[]): Stats | undefined {
    return values.length > 0 ? summarize(values) : undefined;
}

function groupStats(records: readonly RunRecord[]): GroupStats {
    const totalMs = summarize(records.map(record => record.totalMs));
    const phases: Partial<Record<Phase, Stats>> = {};
    const phaseShare: Partial<Record<Phase, number>> = {};
    for(const phase of PHASES) {
        const stats = optionalStats(records.flatMap(record => record.phases[phase] ?? []));
        if(stats) {
            phases[phase] = stats;
            phaseShare[phase] = share(stats.sum, totalMs.sum);
        }
    }
    return {
        runs:        records.length,
        totalMs,
        files:       optionalStats(records.flatMap(record => record.files ?? [])),
        fileHeaders: optionalStats(records.flatMap(record => record.fileHeaders ?? [])),
        phases,
        phaseShare,
    };
}

/** Aggregate run records by {@link groupKeys}, keys sorted. */
export function aggregateRuns(records: readonly RunRecord[]): Record<string, GroupStats> {
    const groups = new Map<string, RunRecord[]>();
    for(const record of records) {
        for(const key of groupKeys(record)) {
            const members = groups.get(key);
            if(members) {
                members.push(record);
            } else {
                groups.set(key, [record]);
            }
        }
    }
    return Object.fromEntries([...groups.keys()].toSorted((a, b) => a.localeCompare(b)).map(key => [key, groupStats(groups.get(key)!)]));
}

/** A bun test failure line: `(fail) name`, or `✗ name` from a terminal. */
const FAIL_LINE_RE = /^(?:\(fail\)|✗) /;
/** A stderr line longer than this cannot be one the profile looks for; it is skipped rather than buffered. */
const MAX_PENDING_LINE = 4096;

/** What a child's stderr line says about its progress, if anything. */
export function classifyStderrLine(line: string, bail: boolean): 'file' | DecisiveKind | undefined {
    if(fileHeaderRe.test(line)) {
        return 'file';
    }
    if(line.startsWith(HIT_LIMIT_SENTINEL)) {
        return 'hitLimit';
    }
    if(bail && FAIL_LINE_RE.test(line)) {
        return 'fail';
    }
    return RAN_LINE.test(line) ? 'summary' : undefined;
}

/** One bun child of a run. */
interface SpawnState {
    bail:         boolean
    marks:        Partial<Record<SpawnMark, number>>
    decisive?:    DecisiveKind
    fileHeaders:  number
    /** False once the decisive line is seen: nothing after it is read. */
    scanning:     boolean
    decoder:      StringDecoder
    /** The unterminated end of the stderr read so far. */
    pending:      string
    /** True while the rest of an over-long line is being skipped. */
    skippingLine: boolean
}

/**
 * The timing of one dry or mutant run. Created by {@link WorkerProfiler.startRun}
 * (the `requested` mark); handed to process-runner, which reports each child's
 * spawn, stderr, exit and close; finished by the runner as it returns.
 */
export class RunProfile {
    private readonly requestedAt: number;
    private readonly spawnStates: SpawnState[] = [];

    private scope?:        RunScope;
    private files?:        number;
    private patternBytes?: number;

    constructor(
        private readonly owner: WorkerProfiler,
        readonly kind: RunKind,
        private readonly mutantId: string | undefined,
        private readonly clock: ProfileClock
    ) {
        this.requestedAt = clock.now();
        this.scope = kind === 'dry' ? 'dry' : undefined;
    }

    /** Which tests the next spawn runs (see {@link mutantRunScope}); the last call wins. */
    public setScope(scope: RunScope): void {
        this.scope = scope;
    }

    /**
     * A child is about to be spawned with these options: start its marks
     * (`spawnStart`). The last child's file list and pattern are the run's.
     */
    public beginSpawn(bail: boolean, testFiles: readonly string[] | undefined, testNamePattern: string | undefined): void {
        this.files = testFiles?.length;
        this.patternBytes = testNamePattern === undefined ? undefined : Buffer.byteLength(testNamePattern);
        this.spawnStates.push({
            bail,
            marks:        { spawnStart: this.clock.now() },
            fileHeaders:  0,
            scanning:     true,
            decoder:      new StringDecoder('utf8'),
            pending:      '',
            skippingLine: false,
        });
    }

    /** Record `name` for the current child; only its first occurrence counts. */
    public mark(name: SpawnMark): void {
        const state = this.spawnStates.at(-1);
        if(state && state.marks[name] === undefined) {
            state.marks[name] = this.clock.now();
        }
    }

    /**
     * A chunk of the current child's stderr: marks `firstStderr`, then reads whole
     * lines for the first test-file header and the decisive line, and stops reading
     * at the decisive line.
     */
    public onStderr(chunk: Buffer): void {
        const state = this.spawnStates.at(-1);
        if(!state) {
            return;
        }
        const at = this.clock.now();
        state.marks.firstStderr ??= at;
        if(!state.scanning) {
            return;
        }
        const lines = (state.pending + state.decoder.write(chunk)).split('\n');
        state.pending = lines.pop()!;
        for(const line of lines) {
            if(state.skippingLine) {
                state.skippingLine = false;
                continue;
            }
            if(!this.readLine(state, stripAnsi(line).replace(/\r$/, ''), at)) {
                return;
            }
        }
        if(state.pending.length > MAX_PENDING_LINE) {
            state.pending = '';
            state.skippingLine = true;
        }
    }

    /** Take in one stderr line read at `at`; false once it was the decisive line, after which nothing more is read. */
    private readLine(state: SpawnState, line: string, at: number): boolean {
        const kind = classifyStderrLine(line, state.bail);
        if(kind === 'file') {
            state.fileHeaders++;
            state.marks.firstFile ??= at;
        } else if(kind !== undefined) {
            state.decisive = kind;
            state.marks.decisive = at;
            state.scanning = false;
        }
        return state.scanning;
    }

    /** The run returns `status` to Stryker now (`returned`): record it. */
    public finish(status: string): void {
        this.owner.record(this.toRecord(status, this.clock.now()));
    }

    private toRecord(status: string, returnedAt: number): RunRecord {
        const sequence: [RunMark, number][] = [['requested', this.requestedAt]];
        for(const state of this.spawnStates) {
            for(const mark of SPAWN_MARKS) {
                const at = state.marks[mark];
                if(at !== undefined) {
                    sequence.push([mark, at]);
                }
            }
        }
        sequence.push(['returned', returnedAt]);
        const phases = computePhases(sequence);
        const last = this.spawnStates.at(-1);
        return {
            type:         'run',
            v:            PROFILE_FORMAT_VERSION,
            pid:          this.owner.pid,
            kind:         this.kind,
            mutant:       this.mutantId,
            status,
            scope:        this.scope,
            files:        this.files,
            patternBytes: this.patternBytes,
            spawns:       this.spawnStates.length,
            bail:         last?.bail,
            decisive:     last?.decisive,
            fileHeaders:  last?.fileHeaders,
            startEpochMs: round3(this.clock.origin + this.requestedAt),
            totalMs:      round3(returnedAt - this.requestedAt),
            marks:        this.spawnStates.map(state => Object.fromEntries(
                SPAWN_MARKS.flatMap(mark => (state.marks[mark] === undefined ? [] : [[mark, round3(state.marks[mark] - this.requestedAt)]]))
            )),
            phases: Object.fromEntries(Object.entries(phases).map(([phase, ms]) => [phase, round3(ms)])),
        };
    }
}

/** What {@link profileInspectorHandlers} adds when not profiling: nothing. */
const NO_HANDLERS: Readonly<Pick<InspectorEventHandlers, 'onTestFound'>> = Object.freeze({});

/**
 * The inspector handlers the dry run adds for its profile: the first TestReporter
 * `found` event marks the first test file as loaded, as its header on stderr
 * would (whichever comes first counts). Without a profile, none, so the dry
 * run's handlers are exactly what they are without profiling.
 */
export function profileInspectorHandlers(profile: RunProfile | undefined): Readonly<Pick<InspectorEventHandlers, 'onTestFound'>> {
    if(profile === undefined) {
        return NO_HANDLERS;
    }
    return {
        onTestFound: (): void => {
            profile.mark('firstFile');
        },
    };
}

/**
 * One worker's profile: hands out a {@link RunProfile} per run, appends each
 * finished run to the file, and appends the worker's summary at dispose().
 * A write that fails is warned about once and ends profiling for the worker.
 */
export class WorkerProfiler {
    private readonly records:   RunRecord[] = [];
    private readonly createdAt: number;
    private failed = false;

    constructor(
        readonly file: string,
        private readonly logger: Logger,
        private readonly clock: ProfileClock = systemClock,
        readonly pid: number = process.pid
    ) {
        this.createdAt = clock.now();
    }

    public startRun(kind: RunKind, mutantId?: string): RunProfile {
        return new RunProfile(this, kind, mutantId, this.clock);
    }

    /** A run finished: keep it for the summary and append its line. */
    public record(record: RunRecord): void {
        this.records.push(record);
        this.append(record);
    }

    /** Append this worker's summary of the runs since the last one, if any, and start over. */
    public writeSummary(): void {
        if(this.records.length === 0) {
            return;
        }
        const end = round3(this.clock.origin + this.clock.now());
        const firstRun = Math.min(...this.records.map(record => record.startEpochMs));
        const busyMs = this.records.reduce((total, record) => total + record.totalMs, 0);
        const dryRunMs = this.records.reduce((total, record) => total + (record.kind === 'dry' ? record.totalMs : 0), 0);
        const wallMs = end - firstRun;
        const summary: WorkerSummary = {
            type:              'summary',
            v:                 PROFILE_FORMAT_VERSION,
            pid:               this.pid,
            runs:              this.records.length,
            createdEpochMs:    round3(this.clock.origin + this.createdAt),
            firstRunEpochMs:   firstRun,
            endEpochMs:        end,
            wallMs:            round3(wallMs),
            busyMs:            round3(busyMs),
            dryRunMs:          round3(dryRunMs),
            dryRunShareOfBusy: share(dryRunMs, busyMs),
            dryRunShareOfWall: share(dryRunMs, wallMs),
            groups:            aggregateRuns(this.records),
        };
        this.records.length = 0;
        this.append(summary);
    }

    private append(line: RunRecord | WorkerSummary): void {
        if(this.failed) {
            return;
        }
        try {
            // Synchronous, one write per line: the line is on disk before the run's
            // result reaches Stryker, so a worker killed later loses nothing, and
            // workers appending to the same file never interleave within a line.
            // eslint-disable-next-line n/no-sync -- see above: the line must be written before the run returns
            appendFileSync(this.file, `${JSON.stringify(line)}\n`);
        } catch (error) {
            this.failed = true;
            this.logger.warn('%s: cannot append to %s (%s); profiling is off for this worker', PROFILE_ENV, this.file, error instanceof Error ? error.message : String(error));
        }
    }
}

/**
 * This worker's profiler when {@link PROFILE_ENV} is set to an absolute path,
 * otherwise undefined. Unset, empty, `0` and `false` mean off; any other value
 * that is not an absolute path is warned about and also means off, since a
 * worker's cwd is Stryker's sandbox, which is deleted after the run.
 */
export function createWorkerProfiler(logger: Logger, env: NodeJS.ProcessEnv = process.env): WorkerProfiler | undefined {
    const value = env[PROFILE_ENV];
    if(value === undefined || value === '' || value === '0' || value === 'false') {
        return undefined;
    }
    if(!path.isAbsolute(value)) {
        logger.warn('%s must be the absolute path of a JSONL file to append to (got %s); profiling is off', PROFILE_ENV, value);
        return undefined;
    }
    logger.debug('Profiling every run to %s', value);
    return new WorkerProfiler(value, logger);
}
