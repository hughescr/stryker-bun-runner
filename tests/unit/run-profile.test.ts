/**
 * The opt-in run profile (src/run-profile.ts): the phase chain, the stderr
 * reading that finds the first test file and the decisive line, the per-run and
 * per-worker JSON lines, and the aggregation math.
 */

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@stryker-mutator/api/logging';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { HIT_LIMIT_SENTINEL } from '../../src/coverage/preload-logic.js';
import type { TestInfo } from '../../src/inspector/types.js';
import {
    PROFILE_ENV,
    aggregateRuns,
    classifyStderrLine,
    computePhases,
    createWorkerProfiler,
    groupKeys,
    mutantRunScope,
    percentile,
    profileInspectorHandlers,
    summarize,
    WorkerProfiler,
    type ProfileClock,
    type RunProfile,
    type RunRecord,
    type WorkerSummary
} from '../../src/run-profile.js';

type MockLogger = Logger & { warn: ReturnType<typeof mock> };

function makeLogger(): MockLogger {
    return {
        debug:          mock(),
        info:           mock(),
        warn:           mock(),
        error:          mock(),
        trace:          mock(),
        fatal:          mock(),
        isTraceEnabled: mock().mockReturnValue(false),
        isDebugEnabled: mock().mockReturnValue(true),
        isInfoEnabled:  mock().mockReturnValue(true),
        isWarnEnabled:  mock().mockReturnValue(true),
        isErrorEnabled: mock().mockReturnValue(true),
        isFatalEnabled: mock().mockReturnValue(true),
    };
}

/** A clock the test sets by hand: `at(ms)` makes every later read return ms. */
function manualClock(origin = 1_000_000): ProfileClock & { at: (ms: number) => void } {
    let current = 0;
    return {
        now: () => current,
        origin,
        at:  (ms: number) => {
            current = ms;
        },
    };
}

/** A minimal run record for the aggregation tests. */
function record(overrides: Partial<RunRecord>): RunRecord {
    return {
        type:         'run',
        v:            1,
        pid:          1,
        kind:         'mutant',
        status:       'killed',
        scope:        'targeted',
        spawns:       1,
        startEpochMs: 0,
        totalMs:      0,
        marks:        [],
        phases:       {},
        ...overrides,
    };
}

describe('computePhases', () => {
    it('gives each gap to the phase between its two marks, in chain order', () => {
        // Distinct powers of two, so a gap given to the wrong phase shows in every total.
        const phases = computePhases([
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 3],
            ['firstStderr', 7],
            ['firstFile', 15],
            ['decisive', 31],
            ['exit', 63],
            ['close', 127],
            ['returned', 255],
        ]);
        expect(phases).toEqual({
            prep:     1,
            spawn:    2,
            startup:  4,
            load:     8,
            tests:    16,
            teardown: 32,
            stdio:    64,
            finish:   128,
        });
    });

    it('splits the dry run\'s inspector wait out of load', () => {
        const phases = computePhases([
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 2],
            ['firstStderr', 4],
            ['inspector', 12],
            ['firstFile', 20],
            ['decisive', 50],
            ['exit', 51],
            ['close', 52],
            ['returned', 60],
        ]);
        expect(phases).toEqual({ prep: 1, spawn: 1, startup: 2, inspector: 8, load: 8, tests: 30, teardown: 1, stdio: 1, finish: 8 });
    });

    it('leaves a missing mark\'s time to the phase before it', () => {
        // Killed at the deadline while still in its first test file: no decisive line.
        expect(computePhases([
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 2],
            ['firstStderr', 5],
            ['firstFile', 10],
            ['exit', 4000],
            ['close', 4001],
            ['returned', 4002],
        ])).toEqual({ prep: 1, spawn: 1, startup: 3, load: 5, tests: 3990, stdio: 1, finish: 1 });
        // Killed before any test file loaded.
        expect(computePhases([
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 2],
            ['firstStderr', 5],
            ['exit', 900],
            ['returned', 901],
        ])).toEqual({ prep: 1, spawn: 1, startup: 3, load: 895, stdio: 1 });
    });

    it('skips a mark earlier than the one before it, and any mark after the last, so phases still sum to the total', () => {
        const sequence = [
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 2],
            ['firstStderr', 3],
            ['decisive', 40],   // the summary chunk was read after the exit event
            ['exit', 30],
            ['close', 99],     // after the result was already returned
            ['returned', 45],
        ] as const;
        const phases = computePhases(sequence);
        expect(phases).toEqual({ prep: 1, spawn: 1, startup: 1, load: 37, teardown: 5 });
        expect(Object.values(phases).reduce((a, b) => a + b, 0)).toBe(45);
    });

    it('follows a retry through both children', () => {
        expect(computePhases([
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 2],
            ['firstStderr', 4],
            ['exit', 10],
            ['close', 11],
            ['spawnStart', 13],
            ['spawned', 14],
            ['firstStderr', 16],
            ['firstFile', 20],
            ['decisive', 30],
            ['exit', 31],
            ['close', 32],
            ['returned', 34],
        ])).toEqual({ prep: 1, spawn: 2, startup: 4, load: 10, finish: 4, tests: 10, teardown: 1, stdio: 2 });
    });

    it('keeps a mark at the same instant as the one before it, as a zero-length phase', () => {
        // The first header and the (fail) line arrived in the same stderr chunk.
        expect(computePhases([
            ['requested', 0],
            ['spawnStart', 1],
            ['spawned', 2],
            ['firstStderr', 5],
            ['firstFile', 9],
            ['decisive', 9],
            ['exit', 12],
            ['returned', 13],
        ])).toEqual({ prep: 1, spawn: 1, startup: 3, load: 4, tests: 0, teardown: 3, stdio: 1 });
    });

    it('returns no phases for no marks', () => {
        expect(computePhases([])).toEqual({});
    });

    it('returns no phases for a single mark, which has no gap after it', () => {
        expect(computePhases([['requested', 5]])).toEqual({});
    });
});

describe('percentile and summarize', () => {
    it('uses the nearest rank', () => {
        const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
        expect(percentile(sorted, 0.5)).toBe(10);
        expect(percentile(sorted, 0.95)).toBe(19);
        expect(percentile(sorted, 1)).toBe(20);
        expect(percentile([7], 0.5)).toBe(7);
        expect(percentile([7], 0.95)).toBe(7);
        expect(percentile([1, 2, 3], 0)).toBe(1);
    });

    it('sorts its input and reports count, sum, mean, p50 and p95', () => {
        expect(summarize([40, 10, 30, 20])).toEqual({ count: 4, sum: 100, mean: 25, p50: 20, p95: 40 });
        expect(summarize([5])).toEqual({ count: 1, sum: 5, mean: 5, p50: 5, p95: 5 });
    });

    it('rounds to the microsecond', () => {
        expect(summarize([0.1, 0.2])).toEqual({ count: 2, sum: 0.3, mean: 0.15, p50: 0.1, p95: 0.2 });
        expect(summarize([1 / 3])).toEqual({ count: 1, sum: 0.333, mean: 0.333, p50: 0.333, p95: 0.333 });
    });
});

describe('groupKeys and aggregateRuns', () => {
    it('counts a mutant run under its status, its scope and both, and the dry run apart', () => {
        expect(groupKeys(record({ status: 'survived', scope: 'static' }))).toEqual(['all', 'mutant', 'mutant/survived', 'mutant/*/static', 'mutant/survived/static']);
        expect(groupKeys(record({ kind: 'dry', status: 'complete', scope: 'dry' }))).toEqual(['all', 'dry', 'dry/complete']);
        expect(groupKeys(record({ scope: undefined }))).toContain('mutant/*/unknown');
    });

    it('aggregates totals, phases, shares and file counts per group', () => {
        const groups = aggregateRuns([
            record({ status: 'killed', totalMs: 100, files: 2, fileHeaders: 1, phases: { load: 60, tests: 40 } }),
            record({ status: 'killed', totalMs: 300, files: 4, fileHeaders: 3, phases: { load: 100, tests: 200 } }),
            record({ status: 'survived', totalMs: 600, phases: { load: 150, tests: 450 } }),
            record({ kind: 'dry', status: 'complete', scope: 'dry', totalMs: 1000, files: 9, phases: { inspector: 10, tests: 990 } }),
        ]);
        expect(Object.keys(groups)).toEqual([
            'all', 'dry', 'dry/complete', 'mutant', 'mutant/*/targeted', 'mutant/killed', 'mutant/killed/targeted', 'mutant/survived', 'mutant/survived/targeted',
        ]);
        const killed = groups['mutant/killed'];
        expect(killed.runs).toBe(2);
        expect(killed.totalMs).toEqual({ count: 2, sum: 400, mean: 200, p50: 100, p95: 300 });
        expect(killed.phases.load).toEqual({ count: 2, sum: 160, mean: 80, p50: 60, p95: 100 });
        expect(killed.phases.tests).toEqual({ count: 2, sum: 240, mean: 120, p50: 40, p95: 200 });
        expect(killed.phases.inspector).toBeUndefined();
        expect(killed.phaseShare).toEqual({ load: 0.4, tests: 0.6 });
        expect(killed.files).toEqual({ count: 2, sum: 6, mean: 3, p50: 2, p95: 4 });
        expect(killed.fileHeaders).toEqual({ count: 2, sum: 4, mean: 2, p50: 1, p95: 3 });
        // A run that handed bun no file list is left out of the file statistics, not counted as 0.
        expect(groups['mutant/survived'].files).toBeUndefined();
        expect(groups.mutant.files).toEqual({ count: 2, sum: 6, mean: 3, p50: 2, p95: 4 });
        // The inspector phase only exists in the dry run, so only its one run is counted.
        expect(groups.all.phases.inspector).toEqual({ count: 1, sum: 10, mean: 10, p50: 10, p95: 10 });
        expect(groups.all.totalMs.sum).toBe(2000);
        expect(groups.all.phaseShare).toEqual({ inspector: 0.005, load: 0.155, tests: 0.84 });
    });

    it('reports a zero share, not NaN, for a group whose runs took no time', () => {
        expect(aggregateRuns([record({ totalMs: 0, phases: { load: 0 } })]).all.phaseShare).toEqual({ load: 0 });
    });
});

describe('classifyStderrLine', () => {
    it('reads test-file headers, with or without the GitHub Actions group prefix', () => {
        expect(classifyStderrLine('tests/a.test.ts:', true)).toBe('file');
        expect(classifyStderrLine('::group::tests/a.test.ts:', false)).toBe('file');
        expect(classifyStderrLine('tests/a.test.ts:12:5', true)).toBeUndefined();
    });

    it('takes a failing test as decisive only under bail', () => {
        expect(classifyStderrLine('(fail) suite > test [0.10ms]', true)).toBe('fail');
        expect(classifyStderrLine('✗ suite > test', true)).toBe('fail');
        expect(classifyStderrLine('(fail) suite > test [0.10ms]', false)).toBeUndefined();
    });

    it('reads the hit-limit report and bun\'s summary line', () => {
        expect(classifyStderrLine(`${HIT_LIMIT_SENTINEL} token 1234`, false)).toBe('hitLimit');
        expect(classifyStderrLine('Ran 4 tests across 2 files. [12.00ms]', true)).toBe('summary');
        expect(classifyStderrLine('(pass) suite > test [0.10ms]', true)).toBeUndefined();
        expect(classifyStderrLine('bun test v1.4.2 (abcdef)', true)).toBeUndefined();
    });
});

describe('mutantRunScope', () => {
    it('names what a mutant-run spawn handed bun', () => {
        expect(mutantRunScope(true, undefined, 0)).toBe('files');
        expect(mutantRunScope(false, 'pattern', 3)).toBe('targeted');
        expect(mutantRunScope(false, undefined, 3)).toBe('fallback');
        expect(mutantRunScope(false, undefined, 0)).toBe('static');
    });
});

describe('WorkerProfiler and RunProfile', () => {
    let dir: string;
    let file: string;
    let logger: ReturnType<typeof makeLogger>;
    let clock: ReturnType<typeof manualClock>;
    let profiler: WorkerProfiler;

    beforeEach(async () => {
        dir = await fsp.mkdtemp(path.join(tmpdir(), 'sbr-run-profile-'));
        file = path.join(dir, 'profile.jsonl');
        logger = makeLogger();
        clock = manualClock();
        profiler = new WorkerProfiler(file, logger, clock, 4242);
    });

    afterEach(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
    });

    async function lines(): Promise<(RunRecord | WorkerSummary)[]> {
        const text = await fsp.readFile(file, 'utf8');
        return text.trimEnd().split('\n').map(line => JSON.parse(line) as RunRecord | WorkerSummary);
    }

    async function onlyRun(): Promise<RunRecord> {
        const [run] = await lines();
        return run as RunRecord;
    }

    /** Drive one child of `profile` through a bail run killed by its second file. */
    function bailChild(profile: RunProfile, start: number): void {
        clock.at(start);
        profile.beginSpawn(true, ['a', 'b', 'c'], 'é|x');
        clock.at(start + 2);
        profile.mark('spawned');
        clock.at(start + 20);
        profile.onStderr(Buffer.from('bun test v1.4.2\n'));
        clock.at(start + 50);
        // The header arrives split across two chunks, colour codes and all.
        profile.onStderr(Buffer.from('\u001B[1mtests/a.te'));
        clock.at(start + 51);
        profile.onStderr(Buffer.from('st.ts:\u001B[0m\r\n(pass) a [1ms]\n'));
        clock.at(start + 60);
        profile.onStderr(Buffer.from('tests/b.test.ts:\n(fail) b [2ms]\ntests/c.test.ts:\n'));
        clock.at(start + 70);
        profile.onStderr(Buffer.from('Ran 2 tests across 2 files.\n'));
        clock.at(start + 80);
        profile.mark('exit');
        clock.at(start + 81);
        profile.mark('close');
    }

    it('writes one line per run with its marks, phases and plan', async () => {
        clock.at(100);
        const profile = profiler.startRun('mutant', '7');
        profile.setScope('targeted');
        bailChild(profile, 105);
        clock.at(190);
        profile.finish('killed');

        expect(await onlyRun()).toEqual({
            type:         'run',
            v:            1,
            pid:          4242,
            kind:         'mutant',
            mutant:       '7',
            status:       'killed',
            scope:        'targeted',
            files:        3,
            patternBytes: 4,
            spawns:       1,
            bail:         true,
            decisive:     'fail',
            fileHeaders:  2,
            startEpochMs: 1_000_100,
            totalMs:      90,
            // The header completed in the chunk read at 156 (105 + 51); the (fail) line at 165.
            marks:        [{ spawnStart: 5, spawned: 7, firstStderr: 25, firstFile: 56, decisive: 65, exit: 85, close: 86 }],
            phases:       { prep: 5, spawn: 2, startup: 18, load: 31, tests: 9, teardown: 20, stdio: 1, finish: 4 },
        });
    });

    it('takes the summary line as decisive without bail, and keeps the first of each mark', async () => {
        const profile = profiler.startRun('dry');
        clock.at(1);
        profile.beginSpawn(false, undefined, undefined);
        clock.at(2);
        profile.mark('spawned');
        profile.onStderr(Buffer.from('tests/a.test.ts:\n(fail) a\n'));
        clock.at(3);
        profile.mark('spawned');
        profile.mark('inspector');
        clock.at(4);
        profile.mark('firstFile');
        profile.onStderr(Buffer.from('tests/b.test.ts:\nRan 2 tests across 2 files.\ntests/c.test.ts:\n'));
        clock.at(5);
        profile.finish('complete');

        const run = await onlyRun();
        expect(run.kind).toBe('dry');
        expect(run.scope).toBe('dry');
        expect(run.mutant).toBeUndefined();
        expect(run.files).toBeUndefined();
        expect(run.patternBytes).toBeUndefined();
        expect(run.bail).toBe(false);
        expect(run.decisive).toBe('summary');
        expect(run.fileHeaders).toBe(2);
        expect(run.marks).toEqual([{ spawnStart: 1, spawned: 2, firstStderr: 2, inspector: 3, firstFile: 2, decisive: 4 }]);
    });

    it('stops reading at the decisive line, and reads hit-limit reports', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        clock.at(10);
        profile.onStderr(Buffer.from(`tests/a.test.ts:\n${HIT_LIMIT_SENTINEL} t 99\n(fail) a\n`));
        clock.at(20);
        profile.onStderr(Buffer.from('tests/b.test.ts:\nRan 1 test\n'));
        profile.finish('timeout');
        const run = await onlyRun();
        expect(run.scope).toBeUndefined();
        expect(run.decisive).toBe('hitLimit');
        expect(run.fileHeaders).toBe(1);
        expect(run.marks[0].decisive).toBe(10);
    });

    it('skips an over-long line instead of buffering it, and reads on after it', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        clock.at(10);
        profile.onStderr(Buffer.from('x'.repeat(5000)));
        clock.at(11);
        profile.onStderr(Buffer.from('y'.repeat(5000)));
        clock.at(12);
        // The long line ends in something header-shaped: it must not count.
        profile.onStderr(Buffer.from(' tests/z.test.ts:\ntests/a.test.ts:\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.fileHeaders).toBe(1);
        expect(run.marks[0].firstFile).toBe(12);
    });

    it('reads the first whole line after an over-long one from its very start', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        clock.at(10);
        profile.onStderr(Buffer.from('x'.repeat(5000)));
        clock.at(11);
        // The summary line is anchored at its start, so anything left over from the long line would hide it.
        profile.onStderr(Buffer.from('tail\nRan 1 test across 1 file.\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.decisive).toBe('summary');
        expect(run.marks[0].decisive).toBe(11);
    });

    it('keeps skipping through a short chunk that has no newline in it', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        profile.onStderr(Buffer.from('x'.repeat(5000)));
        // Short, so it alone would not start another skip: only the skipping state can drop it.
        profile.onStderr(Buffer.from('tests/z'));
        // Together with the middle chunk this would be a whole header, but both are the long line's tail.
        profile.onStderr(Buffer.from('.test.ts:\ntests/a.test.ts:\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.fileHeaders).toBe(1);
    });

    it('reads the line right after an over-long one when the long line ended at a chunk boundary', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        clock.at(10);
        profile.onStderr(Buffer.from('x'.repeat(5000)));
        clock.at(11);
        // The newline that ends the long line is this chunk's first character.
        profile.onStderr(Buffer.from('\nRan 1 test across 1 file.\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.decisive).toBe('summary');
        expect(run.marks[0].decisive).toBe(11);
    });

    it('reads every later chunk normally once an over-long line has ended', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        profile.onStderr(Buffer.from('x'.repeat(5000)));
        profile.onStderr(Buffer.from('tail\ntests/a.test.ts:\n'));
        // Its first line would be dropped as the tail of a long line if the skip had not been ended.
        profile.onStderr(Buffer.from('tests/b.test.ts:\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.fileHeaders).toBe(2);
    });

    it('reads a header whose line has a carriage return inside it as well as at its end', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        // Only the \r that ends the line is dropped; header names may hold others.
        profile.onStderr(Buffer.from('a\rb/c.test.ts:\r\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.fileHeaders).toBe(1);
    });

    it('still buffers a line of exactly the longest length it reads', async () => {
        const profile = profiler.startRun('mutant', '1');
        profile.beginSpawn(true, undefined, undefined);
        const header = `${'d'.repeat(4096 - '.test.ts'.length)}.test.ts`;
        expect(header).toHaveLength(4096);
        profile.onStderr(Buffer.from(header));
        profile.onStderr(Buffer.from(':\n'));
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.fileHeaders).toBe(1);
    });

    it('keeps a zero-match retry\'s two children, reporting the last one\'s outcome', async () => {
        const profile = profiler.startRun('mutant', '3');
        profile.setScope('targeted');
        clock.at(1);
        profile.beginSpawn(true, ['a'], 'p');
        clock.at(2);
        profile.mark('spawned');
        profile.onStderr(Buffer.from('error: regex "p" matched 0 tests\n'));
        clock.at(3);
        profile.mark('exit');
        profile.mark('close');
        profile.setScope('fallback');
        clock.at(4);
        profile.beginSpawn(false, ['a', 'b'], undefined);
        clock.at(5);
        profile.mark('spawned');
        profile.onStderr(Buffer.from('tests/a.test.ts:\nRan 3 tests\n'));
        clock.at(6);
        profile.mark('exit');
        profile.mark('close');
        clock.at(7);
        profile.finish('survived');
        const run = await onlyRun();
        expect(run.spawns).toBe(2);
        expect(run.scope).toBe('fallback');
        expect(run.files).toBe(2);
        expect(run.patternBytes).toBeUndefined();
        expect(run.bail).toBe(false);
        expect(run.decisive).toBe('summary');
        expect(run.marks).toEqual([
            { spawnStart: 1, spawned: 2, firstStderr: 2, exit: 3, close: 3 },
            { spawnStart: 4, spawned: 5, firstStderr: 5, firstFile: 5, decisive: 5, exit: 6, close: 6 },
        ]);
        expect(run.totalMs).toBe(7);
        expect(Object.values(run.phases).reduce((a, b) => a + b, 0)).toBe(7);
    });

    it('records a run that never spawned as all prep, and ignores child events with no child', async () => {
        const profile = profiler.startRun('mutant', '9');
        profile.mark('exit');
        profile.onStderr(Buffer.from('tests/a.test.ts:\n'));
        clock.at(3);
        profile.finish('error');
        const run = await onlyRun();
        expect(run.spawns).toBe(0);
        expect(run.marks).toEqual([]);
        expect(run.phases).toEqual({ prep: 3 });
        expect(run.bail).toBeUndefined();
    });

    it('appends a summary per worker at dispose, with the dry run\'s share', async () => {
        clock.at(0);
        const dry = profiler.startRun('dry');
        clock.at(400);
        dry.finish('complete');
        const killed = profiler.startRun('mutant', '1');
        clock.at(500);
        killed.finish('killed');
        clock.at(600);
        const survived = profiler.startRun('mutant', '2');
        clock.at(900);
        survived.finish('survived');
        clock.at(1000);
        profiler.writeSummary();

        const all = await lines();
        expect(all.map(line => line.type)).toEqual(['run', 'run', 'run', 'summary']);
        const summary = all[3] as WorkerSummary;
        expect(summary).toMatchObject({
            type:              'summary',
            v:                 1,
            pid:               4242,
            runs:              3,
            createdEpochMs:    1_000_000,
            firstRunEpochMs:   1_000_000,
            endEpochMs:        1_001_000,
            wallMs:            1000,
            busyMs:            800,
            dryRunMs:          400,
            dryRunShareOfBusy: 0.5,
            dryRunShareOfWall: 0.4,
        });
        expect(summary.groups.mutant.totalMs).toEqual({ count: 2, sum: 400, mean: 200, p50: 100, p95: 300 });
        expect(summary.groups.dry.runs).toBe(1);

        // The runs are forgotten once summarised: a second dispose adds nothing.
        profiler.writeSummary();
        expect(await lines()).toHaveLength(4);
    });

    it('marks the first test file at the dry run\'s first TestReporter event', async () => {
        expect(profileInspectorHandlers(undefined)).toEqual({});
        const profile = profiler.startRun('dry');
        profile.beginSpawn(false, undefined, undefined);
        const onFound = profileInspectorHandlers(profile).onTestFound!;
        clock.at(7);
        onFound({} as TestInfo);
        clock.at(9);
        onFound({} as TestInfo);
        profile.finish('complete');
        const run = await onlyRun();
        expect(run.marks[0].firstFile).toBe(7);
    });

    it('summarises a worker with more runs than a call can take arguments (no spread of every run)', async () => {
        // A million runs: spread into one call, their start times overflow the stack
        // (bun 1.4.2; node already fails at ~120k). Pushed straight into the record list,
        // since appending a million lines is not what this test is about.
        const RUNS = 1_000_000;
        const records = (profiler as unknown as { records: RunRecord[] }).records;
        const template = record({ startEpochMs: 0, totalMs: 1 });
        for(let i = 0; i < RUNS; i++) {
            records.push({ ...template, startEpochMs: 1_000_000 + RUNS - i });
        }
        clock.at(RUNS + 10);

        profiler.writeSummary();

        const [summary] = await lines() as [WorkerSummary];
        expect(summary.runs).toBe(RUNS);
        expect(summary.firstRunEpochMs).toBe(1_000_001);
    }, 30_000);

    it('writes no summary for a worker that ran nothing', async () => {
        profiler.writeSummary();
        expect(await fsp.readdir(dir)).toEqual([]);
    });

    it('warns once and stops when the file cannot be written', () => {
        const broken = new WorkerProfiler(path.join(dir, 'missing', 'profile.jsonl'), logger, clock);
        broken.startRun('mutant', '1').finish('killed');
        broken.startRun('mutant', '2').finish('killed');
        broken.writeSummary();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(String(logger.warn.mock.calls[0][0])).toContain('profiling is off for this worker');
    });
});

describe('createWorkerProfiler', () => {
    it('is off, silently, when the variable is unset, empty, 0 or false', () => {
        for(const value of [undefined, '', '0', 'false']) {
            const logger = makeLogger();
            expect(createWorkerProfiler(logger, { [PROFILE_ENV]: value })).toBeUndefined();
            expect(logger.warn).not.toHaveBeenCalled();
        }
    });

    it('is off, with a warning, for a value that is not an absolute path', () => {
        const logger = makeLogger();
        expect(createWorkerProfiler(logger, { [PROFILE_ENV]: '1' })).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            '%s must be the absolute path of a JSONL file to append to (got %s); profiling is off',
            PROFILE_ENV,
            '1'
        );
        expect(createWorkerProfiler(logger, { [PROFILE_ENV]: 'profile.jsonl' })).toBeUndefined();
    });

    it('profiles to an absolute path', () => {
        const logger = makeLogger();
        const profiler = createWorkerProfiler(logger, { [PROFILE_ENV]: '/tmp/x/profile.jsonl' });
        expect(logger.debug).toHaveBeenCalledWith('Profiling every run to %s', '/tmp/x/profile.jsonl');
        expect(profiler).toBeInstanceOf(WorkerProfiler);
        expect(profiler?.file).toBe('/tmp/x/profile.jsonl');
        expect(profiler?.pid).toBe(process.pid);
    });
});
