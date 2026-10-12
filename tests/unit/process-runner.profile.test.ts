/**
 * process-runner's side of the opt-in run profile (src/run-profile.ts): which
 * child events it reports, in what order, and that an unprofiled spawn is left
 * exactly as it was.
 */

import type { ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@stryker-mutator/api/logging';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { PRELOAD_TIMINGS_ENV } from '../../src/coverage/preload-logic.js';
import { runBunTests, killAllLiveChildren, removeSignalCleanup, PROFILE_ENV, SPAWN_DEPTH_ENV } from '../../src/process-runner.js';
import { SPAWN_MARKS, WorkerProfiler, type RunRecord } from '../../src/run-profile.js';
import { rememberEnv } from '../helpers/env.js';
import { mockSpawn, resetChildProcessMocks, resetProcessGroupMocks } from '../test-preload.js';

interface FakeChild {
    child: ChildProcess
    /** Emit `event` with `args` to the handler the runner registered for it. */
    emit:  (target: 'child' | 'stderr', event: string, ...args: unknown[]) => void
}

/** A ChildProcess stand-in that records the handlers the runner registers on it and its stderr. */
function makeFakeChild(): FakeChild {
    const handlers = { child: new Map<string, (...args: unknown[]) => void>(), stderr: new Map<string, (...args: unknown[]) => void>() };
    /* eslint-disable @typescript-eslint/no-explicit-any -- mock child process */
    const child: any = {
        stdout: { on: mock() },
        stderr: { on: mock((event: string, handler: (...args: unknown[]) => void) => handlers.stderr.set(event, handler)) },
        on:     mock((event: string, handler: (...args: unknown[]) => void) => {
            handlers.child.set(event, handler);
            return child;
        }),
        kill: mock(() => true),
        pid:  12_345,
    };
    /* eslint-enable @typescript-eslint/no-explicit-any -- re-enable after mock setup */
    return {
        child: child as ChildProcess,
        emit:  (target, event, ...args) => handlers[target].get(event)?.(...args),
    };
}

describe('process-runner run profile', () => {
    let fake: FakeChild;
    let restoreEnv: () => void;
    let dir: string;
    let file: string;

    beforeEach(async () => {
        restoreEnv = rememberEnv();
        delete process.env[SPAWN_DEPTH_ENV];
        fake = makeFakeChild();
        mockSpawn.mockImplementation(() => fake.child);
        dir = await fsp.mkdtemp(path.join(tmpdir(), 'sbr-process-profile-'));
        file = path.join(dir, 'profile.jsonl');
    });

    afterEach(async () => {
        killAllLiveChildren();
        removeSignalCleanup();
        resetChildProcessMocks();
        resetProcessGroupMocks();
        restoreEnv();
        await fsp.rm(dir, { recursive: true, force: true });
    });

    /** The one run line in the profile file. */
    async function writtenRun(): Promise<RunRecord> {
        return JSON.parse(await fsp.readFile(file, 'utf8')) as RunRecord;
    }

    /** The env the child was spawned with. */
    function spawnedEnv(): Record<string, string | undefined> {
        const call = mockSpawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string | undefined> }];
        return call[2].env;
    }

    it('reports spawn, stderr, exit and close to the profile in the order they happen', async () => {
        // Every clock read is one later than the last, so the marks' order is the order of the calls.
        let tick = 0;
        const profiler = new WorkerProfiler(file, {} as Logger, { now: () => ++tick, origin: 0 });
        const profile = profiler.startRun('mutant', '5');

        const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000, bail: true, testFiles: ['/p/tests/a.test.ts'], testNamePattern: 'a|b', profile });
        fake.emit('stderr', 'data', Buffer.from('bun test v1.4.2\n'));
        fake.emit('stderr', 'data', Buffer.from('tests/a.test.ts:\n'));
        fake.emit('stderr', 'data', Buffer.from('(fail) a > b [1.00ms]\n'));
        fake.emit('child', 'exit', 1, null);
        fake.emit('child', 'close', 1, null);
        const result = await resultPromise;
        profile.finish('killed');

        // The child's output reaches the result exactly as without a profile.
        expect(result.stderr).toBe('bun test v1.4.2\ntests/a.test.ts:\n(fail) a > b [1.00ms]\n');
        const run = await writtenRun();
        expect(run.bail).toBe(true);
        expect(run.files).toBe(1);
        expect(run.patternBytes).toBe(3);
        expect(run.decisive).toBe('fail');
        const marks = run.marks[0];
        const recorded = SPAWN_MARKS.filter(mark => marks[mark] !== undefined);
        expect(recorded).toEqual(['spawnStart', 'spawned', 'firstStderr', 'firstFile', 'decisive', 'exit', 'close']);
        const times = recorded.map(mark => marks[mark]!);
        expect(times).toEqual(times.toSorted((a, b) => a - b));
        expect(new Set(times).size).toBe(times.length);
    });

    it('marks a child that failed to spawn as closed', async () => {
        const profiler = new WorkerProfiler(file, {} as Logger);
        const profile = profiler.startRun('mutant', '5');
        const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000, profile });
        fake.emit('child', 'error', new Error('spawn bun ENOENT'));
        await resultPromise;
        profile.finish('error');
        const run = await writtenRun();
        expect(Object.keys(run.marks[0]).toSorted((a, b) => a.localeCompare(b))).toEqual(['close', 'spawned', 'spawnStart']);
        expect(run.bail).toBe(false);
    });

    it('keeps a profiled child from profiling runners it starts in turn', async () => {
        process.env[PROFILE_ENV] = file;
        const profile = new WorkerProfiler(file, {} as Logger).startRun('mutant', '5');
        const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000, profile });
        fake.emit('child', 'close', 0, null);
        await resultPromise;
        expect(spawnedEnv()).not.toHaveProperty(PROFILE_ENV);
    });

    it('asks the preload of a profiled dry run (the one with a sync port) for its timings, and no other child', async () => {
        const profiler = new WorkerProfiler(file, {} as Logger);
        process.env[PRELOAD_TIMINGS_ENV] = '1'; // inherited from outside: must not leak into unprofiled children

        const runs: [string, Parameters<typeof runBunTests>[0]][] = [
            ['profiled dry run', { bunPath: 'bun', timeout: 5000, syncPort: 4321, profile: profiler.startRun('dry') }],
            ['profiled mutant run', { bunPath: 'bun', timeout: 5000, profile: profiler.startRun('mutant', '5') }],
            ['unprofiled dry run', { bunPath: 'bun', timeout: 5000, syncPort: 4321 }],
        ];
        const seen: Record<string, string | undefined> = {};
        for(const [name, options] of runs) {
            fake = makeFakeChild();
            const resultPromise = runBunTests(options);
            fake.emit('child', 'close', 0, null);
            // eslint-disable-next-line no-await-in-loop -- one fake child at a time
            await resultPromise;
            const call = mockSpawn.mock.calls.at(-1) as unknown as [string, string[], { env: Record<string, string | undefined> }];
            seen[name] = call[2].env[PRELOAD_TIMINGS_ENV];
        }

        expect(seen).toEqual({ 'profiled dry run': '1', 'profiled mutant run': undefined, 'unprofiled dry run': undefined });
    });

    it('leaves an unprofiled spawn\'s environment alone and writes nothing', async () => {
        process.env[PROFILE_ENV] = file;
        const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000 });
        fake.emit('stderr', 'data', Buffer.from('tests/a.test.ts:\nRan 1 test\n'));
        fake.emit('child', 'close', 0, null);
        await resultPromise;
        expect(spawnedEnv()[PROFILE_ENV]).toBe(file);
        expect(await fsp.readdir(dir)).toEqual([]);
    });
});
