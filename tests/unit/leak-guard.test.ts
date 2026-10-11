/**
 * Tests for tests/leak-guard.ts, the preload guard that fails any test leaving
 * state behind for the tests after it.
 *
 * Each test records the state, leaks something on purpose, checks that the
 * guard names it, and undoes it again before it ends (in a finally), so the
 * guard's own afterEach finds nothing. What a whole `bun test` run reports,
 * and which test it blames, is covered by
 * tests/00-integration/leak-guard-integration.test.ts.
 */

import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it, expect, jest, spyOn, afterEach } from 'bun:test';
import { findLeaks, leakError, takeSnapshot, type Snapshot } from '../leak-guard.js';
import { mockKillProcessGroup, mockSpawn, resetChildProcessMocks, resetFsMocks, resetProcessGroupMocks } from '../test-preload.js';

function leaksSince(since: Snapshot): string[] {
    return findLeaks(since).map(leak => leak.description);
}

const noop = (): void => undefined;

describe('leak guard', () => {
    afterEach(() => {
        // The tests below undo their fake timers themselves; this only matters if one fails first.
        jest.useRealTimers();
    });

    it('finds nothing when the state is as it was recorded', () => {
        expect(leaksSince(takeSnapshot())).toEqual([]);
    });

    it('reports a spy left in place, naming the line that made it, until it is restored', () => {
        const before = takeSnapshot();
        const spy = spyOn(process, 'uptime').mockReturnValue(1);
        try {
            const leaks = leaksSince(before);
            expect(leaks).toHaveLength(1);
            expect(leaks[0]).toContain('spyOn(process, "uptime")');
            expect(leaks[0]).toContain('leak-guard.test.ts:');
            expect(leaks[0]).toContain('was not restored');
        } finally {
            spy.mockRestore();
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('reports calls recorded on a shared mock and an implementation not put back', () => {
        const before = takeSnapshot();
        try {
            mockKillProcessGroup(4242, 'SIGTERM');
            mockSpawn.mockImplementation(() => {
                throw new Error('not spawned');
            });

            expect(leaksSince(before)).toEqual([
                'mock mockSpawn (tests/test-preload.ts): its implementation was changed and not put back',
                'mock mockKillProcessGroup (tests/test-preload.ts): 1 recorded call(s) not cleared (mockClear() it after the test)',
            ]);
        } finally {
            resetChildProcessMocks();
            resetProcessGroupMocks();
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('takes spyOn over a shared mock for that mock, whose state is checked instead', () => {
        const before = takeSnapshot();
        try {
            // bun hands back the mock already in place rather than wrapping it.
            spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

            expect(leaksSince(before)).toEqual(['mock mockUnlink (tests/test-preload.ts): its implementation was changed and not put back']);
        } finally {
            resetFsMocks();
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('does not count calls cleared from before the record as new ones', () => {
        mockKillProcessGroup(4242, 'SIGTERM');
        const before = takeSnapshot();
        mockKillProcessGroup.mockClear();

        expect(leaksSince(before)).toEqual([]);
    });

    it('reports a process.env key added, changed or removed', () => {
        const before = takeSnapshot();
        try {
            process.env.LEAK_GUARD_PROBE = 'set';

            expect(leaksSince(before)).toEqual(['process.env.LEAK_GUARD_PROBE was added and not restored']);
        } finally {
            delete process.env.LEAK_GUARD_PROBE;
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('reports a process listener added and not removed', () => {
        const before = takeSnapshot();
        process.on('SIGUSR2', noop);
        try {
            expect(leaksSince(before)).toEqual(['1 process \'SIGUSR2\' listener(s) added and not removed']);
        } finally {
            process.off('SIGUSR2', noop);
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('reports a process listener removed, and puts it back', () => {
        process.on('SIGUSR2', noop);
        try {
            const before = takeSnapshot();
            process.off('SIGUSR2', noop);

            const leaks = findLeaks(before);
            expect(leaks.map(leak => leak.description)).toEqual(['1 process \'SIGUSR2\' listener(s) removed and not put back']);
            leakError('This test', leaks);
            expect(process.listeners('SIGUSR2')).toEqual([noop]);
        } finally {
            process.off('SIGUSR2', noop);
        }
    });

    it('reports fake timers left installed', () => {
        const before = takeSnapshot();
        jest.useFakeTimers();
        try {
            expect(leaksSince(before)).toEqual(['fake timers are still installed (call jest.useRealTimers() after the test)']);
        } finally {
            jest.useRealTimers();
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('reports a global property replaced, and one added', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const before = takeSnapshot();
        Object.defineProperty(process, 'platform', { ...platform, value: 'aix' });
        Object.assign(globalThis, { leakGuardProbe: 1 });
        try {
            expect(leaksSince(before)).toEqual([
                'globalThis.leakGuardProbe was added and not removed',
                'process.platform was replaced by "aix" and not restored',
            ]);
        } finally {
            Object.defineProperty(process, 'platform', platform);
            Reflect.deleteProperty(globalThis, 'leakGuardProbe');
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('reports a change of working directory', () => {
        const cwd = process.cwd();
        const before = takeSnapshot();
        process.chdir(tmpdir());
        try {
            expect(leaksSince(before)).toEqual([`the working directory changed from ${cwd} to ${process.cwd()}`]);
        } finally {
            process.chdir(cwd);
        }
        expect(leaksSince(before)).toEqual([]);
    });

    it('puts every leak back when it reports them, so the next test starts clean', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const before = takeSnapshot();
        try {
            spyOn(process, 'uptime').mockReturnValue(1);
            mockKillProcessGroup(4242, 'SIGTERM');
            process.env.LEAK_GUARD_PROBE = 'set';
            process.on('SIGUSR2', noop);
            jest.useFakeTimers();
            Object.defineProperty(process, 'platform', { ...platform, value: 'aix' });

            const error = leakError('This test', findLeaks(before));

            expect(error.message).toStartWith('This test left state behind that leaks into the tests after it (6 leaks):');
            expect(error.message).toContain('spyOn(process, "uptime")');
            expect(error.message).toContain('mockKillProcessGroup');
            expect(leaksSince(before)).toEqual([]);
            expect(process.uptime()).not.toBe(1);
            expect(process.platform).toBe(platform.value as NodeJS.Platform);
        } finally {
            // Only reached with something left if an assertion above failed first.
            delete process.env.LEAK_GUARD_PROBE;
            process.off('SIGUSR2', noop);
            jest.useRealTimers();
            Object.defineProperty(process, 'platform', platform);
            resetProcessGroupMocks();
        }
    });
});
