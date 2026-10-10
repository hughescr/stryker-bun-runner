/**
 * Child-lifecycle tests for process-runner: who gets signalled, when, and how
 * many times; which timers and listeners are left behind; and what the
 * signal-cleanup handler does.
 *
 * Split out of process-runner.test.ts (which covers argv, env and result
 * shaping) because every test here is about a stale or doubled signal — the
 * failure mode of signalling a pid that has already exited and may have been
 * reused, or signalling a live child twice.
 */

import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import { runBunTests, removeSignalCleanup, SPAWN_DEPTH_ENV } from '../../src/process-runner.js';
import * as processRss from '../../src/utils/process-rss.js';
import { mockSpawn, resetChildProcessMocks, mockKillProcessGroup, resetProcessGroupMocks } from '../test-preload.js';

const PID = 12_345;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

interface FakeChild {
    child:   ChildProcess
    exit:    (code: number | null) => void
    close:   (code: number | null) => void
    error:   (error: Error) => void
    handler: (event: string) => ((...args: never[]) => void) | undefined
    kill:    ReturnType<typeof mock>
}

/** A ChildProcess stand-in that records the handlers the runner registers, keyed by event name. */
function makeFakeChild(): FakeChild {
    const handlers = new Map<string, (...args: never[]) => void>();
    const kill = mock(() => true);
    /* eslint-disable @typescript-eslint/no-explicit-any -- mock child process */
    const child: any = {
        stdout: { on: mock() },
        stderr: { on: mock() },
        on:     mock((event: string, handler: (...args: never[]) => void) => {
            handlers.set(event, handler);
            return child;
        }),
        kill,
        pid: PID,
    };
    /* eslint-enable @typescript-eslint/no-explicit-any -- re-enable after mock setup */
    const call = (event: string, ...args: unknown[]): void => {
        (handlers.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
    };
    return {
        child:   child as ChildProcess,
        exit:    code => call('exit', code),
        close:   code => call('close', code),
        error:   error => call('error', error),
        handler: event => handlers.get(event),
        kill,
    };
}

/** Let promise continuations queued by a just-resolved RSS probe run. */
async function flushMicrotasks(): Promise<void> {
    for(let i = 0; i < 4; i++) {
        // eslint-disable-next-line no-await-in-loop -- each await must complete before the next to drain chained continuations
        await Promise.resolve();
    }
}

describe('process-runner child lifecycle', () => {
    let fake: FakeChild;
    let ambientSpawnDepth: string | undefined;

    beforeEach(() => {
        ambientSpawnDepth = process.env[SPAWN_DEPTH_ENV];
        delete process.env[SPAWN_DEPTH_ENV];
        fake = makeFakeChild();
        mockSpawn.mockClear();
        mockSpawn.mockImplementation(() => fake.child);
        mockKillProcessGroup.mockClear();
    });

    afterEach(() => {
        if(ambientSpawnDepth === undefined) {
            delete process.env[SPAWN_DEPTH_ENV];
        } else {
            process.env[SPAWN_DEPTH_ENV] = ambientSpawnDepth;
        }
        resetChildProcessMocks();
        resetProcessGroupMocks();
        jest.useRealTimers();
    });

    const groupSignals = (): NodeJS.Signals[] => mockKillProcessGroup.mock.calls.map(([, signal]) => signal);

    describe('refusing to run', () => {
        it('reports an invalid maxSpawnDepth as a complete, non-timed-out failure result', async () => {
            const result = await runBunTests({ bunPath: 'bun', timeout: 5000, maxSpawnDepth: 0 });

            expect(mockSpawn).not.toHaveBeenCalled();
            expect(result).toEqual({
                stdout:              '',
                stderr:              'stryker-bun-runner: invalid maxSpawnDepth=0; expected a positive integer.',
                exitCode:            1,
                signal:              null,
                timedOut:            false,
                memoryLimitExceeded: false,
            });
        });
    });

    describe('exit during termination', () => {
        it('reaps the group the moment the leader exits (before close), and cancels the pending escalation', async () => {
            jest.useFakeTimers();
            mockKillProcessGroup.mockImplementation(() => true);
            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 100 });

            jest.advanceTimersByTime(100);
            expect(groupSignals()).toEqual(['SIGTERM']);

            // Only the 'exit' event: 'close' (which would mark the run closed and
            // make the escalation skip itself) has not fired, as when a descendant
            // still holds one of the child's stdio streams open.
            fake.exit(null);
            expect(groupSignals()).toEqual(['SIGTERM', 'SIGKILL']);

            // The escalation timer must have been cancelled: were it still
            // pending it would fire here and SIGKILL a pid that may be reused.
            jest.advanceTimersByTime(600);
            expect(groupSignals()).toEqual(['SIGTERM', 'SIGKILL']);

            fake.close(null);
            await resultPromise;
        });

        it('does not signal the group again on leader exit once the escalation already sent SIGKILL', async () => {
            jest.useFakeTimers();
            mockKillProcessGroup.mockImplementation(() => true);
            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 100 });

            jest.advanceTimersByTime(100 + 500);
            expect(groupSignals()).toEqual(['SIGTERM', 'SIGKILL']);

            fake.exit(null);
            fake.close(null);
            await resultPromise;

            expect(groupSignals()).toEqual(['SIGTERM', 'SIGKILL']);
        });

        it('does not reap a group that was never signalled when the leader exits (SIGTERM fell back to the direct child)', async () => {
            jest.useFakeTimers();
            mockKillProcessGroup.mockImplementation(() => false);
            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 100 });

            jest.advanceTimersByTime(100);
            fake.exit(null);
            fake.close(null);
            await resultPromise;

            // One failed group attempt, then the direct kill — and no group SIGKILL
            // for a group the runner never managed to signal.
            expect(groupSignals()).toEqual(['SIGTERM']);
            expect(fake.kill).toHaveBeenCalledTimes(1);
            expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        });
    });

    describe('a single owner for the TERM/KILL lifecycle', () => {
        it('does not start a second termination when an abort arrives after the timeout already fired', async () => {
            jest.useFakeTimers();
            mockKillProcessGroup.mockImplementation(() => true);
            const controller = new AbortController();
            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 100, signal: controller.signal });

            jest.advanceTimersByTime(100);
            expect(groupSignals()).toEqual(['SIGTERM']);

            controller.abort();
            expect(groupSignals()).toEqual(['SIGTERM']);

            // And only one escalation is pending, not two.
            jest.advanceTimersByTime(500);
            expect(groupSignals()).toEqual(['SIGTERM', 'SIGKILL']);

            fake.close(null);
            await resultPromise;
        });

        it('does not signal again when the timeout fires after an abort already terminated the child', async () => {
            jest.useFakeTimers();
            mockKillProcessGroup.mockImplementation(() => true);
            const controller = new AbortController();
            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 100, signal: controller.signal });

            controller.abort();
            expect(groupSignals()).toEqual(['SIGTERM']);

            jest.advanceTimersByTime(100);
            expect(groupSignals()).toEqual(['SIGTERM']);

            fake.close(null);
            const result = await resultPromise;
            expect(result.timedOut).toBe(true);
        });
    });

    describe('a child that finished on its own is never signalled afterwards', () => {
        it.each([
            ['closes', (): void => fake.close(0)],
            ['errors', (): void => fake.error(new Error('spawn failed'))],
        ])('cancels the run timeout when the child %s first', async (_label, finish) => {
            jest.useFakeTimers();
            mockKillProcessGroup.mockImplementation(() => true);
            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 100 });

            finish();
            const result = await resultPromise;
            jest.advanceTimersByTime(10_000);

            expect(mockKillProcessGroup).not.toHaveBeenCalled();
            expect(fake.kill).not.toHaveBeenCalled();
            expect(result.timedOut).toBe(false);
        });

        describe.each([
            ['closes', (): void => fake.close(0)],
            ['errors', (): void => fake.error(new Error('spawn failed'))],
        ])('when the child %s while an RSS probe is still pending', (_label, finish) => {
            let getRssSpy: ReturnType<typeof spyOn>;

            beforeEach(() => {
                getRssSpy = spyOn(processRss, 'getProcessRssBytes');
            });

            afterEach(() => {
                getRssSpy.mockRestore();
            });

            it('ignores an over-limit reading that arrives after the child is gone', async () => {
                jest.useFakeTimers();
                mockKillProcessGroup.mockImplementation(() => true);
                let resolveRss!: (rss: number | null) => void;
                getRssSpy.mockImplementation(() => new Promise((resolve) => {
                    resolveRss = resolve;
                }));
                const onMemoryLimitExceeded = mock();
                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100,
                    rssCheckIntervalMs: 100,
                    onMemoryLimitExceeded,
                });

                jest.advanceTimersByTime(100);
                expect(getRssSpy).toHaveBeenCalledTimes(1);

                finish();
                const result = await resultPromise;

                // The probe was in flight when the child went away; its answer must
                // not be acted on, since the pid it describes no longer exists.
                resolveRss(1_000_000);
                await flushMicrotasks();

                expect(onMemoryLimitExceeded).not.toHaveBeenCalled();
                expect(mockKillProcessGroup).not.toHaveBeenCalled();
                expect(fake.kill).not.toHaveBeenCalled();
                expect(result.memoryLimitExceeded).toBe(false);
            });
        });
    });

    describe('signal cleanup registration', () => {
        afterEach(() => {
            removeSignalCleanup();
        });

        it('attaches the cleanup listeners to SIGINT, SIGTERM and SIGHUP when a child is spawned', async () => {
            removeSignalCleanup();
            const before = SIGNALS.map(s => process.listenerCount(s));

            const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000 });

            for(const [i, signal] of SIGNALS.entries()) {
                expect(process.listenerCount(signal)).toBe(before[i] + 1);
            }

            fake.close(0);
            await resultPromise;
        });

        it('kills every live child, detaches itself, and re-raises the same signal at this process', async () => {
            const killSpy = spyOn(process, 'kill').mockImplementation(() => true);
            try {
                for(const signal of SIGNALS) {
                    removeSignalCleanup();
                    const before = process.listeners(signal);

                    const current = makeFakeChild();
                    mockSpawn.mockImplementation(() => current.child);
                    mockKillProcessGroup.mockClear();
                    killSpy.mockClear();
                    const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000 });

                    const handler = process.listeners(signal).find(l => !before.includes(l));
                    expect(handler).toBeDefined();
                    (handler as (s: NodeJS.Signals) => void)(signal);

                    // The live child's whole group is taken down...
                    expect(mockKillProcessGroup).toHaveBeenCalledWith(PID, 'SIGKILL');
                    // ...the handlers are detached from every signal, so the re-raise
                    // below meets the default disposition instead of looping back here...
                    for(const s of SIGNALS) {
                        expect(process.listeners(s)).not.toContain(handler);
                    }
                    expect(process.listenerCount(signal)).toBe(before.length);
                    // ...and the signal that arrived is re-raised at this process.
                    expect(killSpy).toHaveBeenCalledTimes(1);
                    expect(killSpy).toHaveBeenCalledWith(process.pid, signal);

                    current.close(0);
                    // eslint-disable-next-line no-await-in-loop -- sequential: each iteration reuses the shared mocks
                    await resultPromise;
                }
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    describe('RSS poller handle', () => {
        let getRssSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            getRssSpy = spyOn(processRss, 'getProcessRssBytes').mockResolvedValue(1);
        });

        afterEach(() => {
            getRssSpy.mockRestore();
        });

        it('does not keep the event loop alive on its own (the interval handle is unref\'d)', async () => {
            const realSetInterval = globalThis.setInterval;
            const handles: ReturnType<typeof setInterval>[] = [];
            const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
                const handle = realSetInterval(...args);
                handles.push(handle);
                return handle;
            }) as typeof setInterval);
            try {
                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        1000,
                    rssCheckIntervalMs: 60_000,
                });

                expect(handles).toHaveLength(1);
                expect(handles[0].hasRef()).toBe(false);

                fake.close(0);
                await resultPromise;
            } finally {
                setIntervalSpy.mockRestore();
            }
        });
    });
});
