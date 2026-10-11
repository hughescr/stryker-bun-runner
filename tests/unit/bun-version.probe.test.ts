/**
 * Edge cases of the startup bun version check that the main bun-version tests
 * do not reach: multi-digit components, what the comparison ignores, how long
 * garbage output is reported, and that a finished probe leaves no kill timer
 * behind to fire at a process that is already gone.
 */

import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { checkBunVersion, compareVersions, parseBunVersion } from '../../src/utils/bun-version.js';
import { mockSpawn, resetAllMocks } from '../test-preload.js';

describe('parseBunVersion — component width', () => {
    it('reads multi-digit major, minor and patch components in full', () => {
        expect(parseBunVersion('12.345.6789\n')).toEqual([12, 345, 6789]);
    });

    it('finds the version inside surrounding text', () => {
        expect(parseBunVersion('bun v10.2.3 (linux)')).toEqual([10, 2, 3]);
    });
});

describe('compareVersions — only major.minor.patch count', () => {
    it('ignores components beyond the third', () => {
        expect(compareVersions([1, 2, 3, 9], [1, 2, 3, 1])).toBe(0);
        expect(compareVersions([1, 2, 3, 1], [1, 2, 3, 9])).toBe(0);
        expect(compareVersions([1, 2, 3], [1, 2, 3, 7])).toBe(0);
    });
});

interface Probe {
    stdout: (data: Buffer) => void
    close:  (code: number | null, signal: NodeJS.Signals | null) => void
    error:  (error: Error) => void
    kill:   ReturnType<typeof mock>
}

describe('checkBunVersion — probe lifecycle', () => {
    let probe: Probe;

    beforeEach(() => {
        const handlers = new Map<string, (...args: never[]) => void>();
        const kill = mock();
        /* eslint-disable @typescript-eslint/no-explicit-any -- test mock of ChildProcess */
        const fake: any = {
            stdout: {
                on: mock((_event: string, handler: (...args: never[]) => void) => {
                    handlers.set('data', handler);
                }),
            },
            on: mock((event: string, handler: (...args: never[]) => void) => {
                handlers.set(event, handler);
                return fake;
            }),
            kill,
        };
        /* eslint-enable @typescript-eslint/no-explicit-any -- re-enable after mock setup */
        const call = (event: string, ...args: unknown[]): void => {
            (handlers.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
        };
        probe = {
            stdout: data => call('data', data),
            close:  (code, signal) => call('close', code, signal),
            error:  error => call('error', error),
            kill,
        };
        mockSpawn.mockImplementation(() => fake as ChildProcess);
    });

    afterEach(() => {
        jest.useRealTimers();
        resetAllMocks();
    });

    it('cuts unrecognized --version output at 100 characters in the error message', async () => {
        const result = checkBunVersion('bun');
        await Promise.resolve();
        probe.stdout(Buffer.from(`${'x'.repeat(100)}${'y'.repeat(50)}\n`));
        probe.close(0, null);

        const error = await result.catch((e: unknown) => e);
        expect((error as Error).message).toContain(`unrecognized --version output "${'x'.repeat(100)}")`);
        expect((error as Error).message).not.toContain('yy');
    });

    it.each([
        ['closes', (): void => probe.close(0, null)],
        ['errors', (): void => probe.error(Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' }))],
    ])('cancels the kill timer when the probe %s, so it cannot fire later', async (_label, finish) => {
        jest.useFakeTimers();
        const result = checkBunVersion('bun', undefined, 1000);
        await Promise.resolve();
        probe.stdout(Buffer.from('1.4.2\n'));

        finish();
        await result.catch(() => undefined);
        jest.advanceTimersByTime(60_000);

        expect(probe.kill).not.toHaveBeenCalled();
    });

    it('keeps the first outcome when a timeout is followed by the probe closing normally', async () => {
        jest.useFakeTimers();
        const result = checkBunVersion('bun', undefined, 1000);
        await Promise.resolve();

        jest.advanceTimersByTime(1000);
        probe.stdout(Buffer.from('1.4.2\n'));
        probe.close(0, null);

        const error = await result.catch((e: unknown) => e);
        expect(probe.kill).toHaveBeenCalledTimes(1);
        expect((error as Error).message).toContain('timed out after 1000ms');
    });
});
