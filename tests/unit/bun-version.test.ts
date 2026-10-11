/**
 * Unit tests for the startup bun availability/version check
 */

import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { MIN_BUN_VERSION, checkBunVersion, compareVersions, parseBunVersion } from '../../src/utils/bun-version.js';
import { runUntilSettled } from '../helpers/fake-clock.js';
import { mockSpawn, resetAllMocks } from '../test-preload.js';

describe('parseBunVersion', () => {
    it('parses a plain release version', () => {
        expect(parseBunVersion('1.4.2\n')).toEqual([1, 4, 2]);
    });

    it('ignores canary/prerelease and build suffixes', () => {
        expect(parseBunVersion('1.4.3-canary.20260101.1+abc123')).toEqual([1, 4, 3]);
    });

    it('returns undefined when no version is present', () => {
        expect(parseBunVersion('not a version')).toBeUndefined();
        expect(parseBunVersion('')).toBeUndefined();
    });
});

describe('compareVersions', () => {
    it('compares numerically, not lexicographically', () => {
        expect(compareVersions([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
        expect(compareVersions([1, 3, 10], [1, 3, 7])).toBeGreaterThan(0);
    });

    it('is negative when older, zero when equal, positive when newer', () => {
        expect(compareVersions([1, 3, 6], [1, 3, 7])).toBeLessThan(0);
        expect(compareVersions([1, 3, 7], [1, 3, 7])).toBe(0);
        expect(compareVersions([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0);
        expect(compareVersions([0, 9, 9], [1, 0, 0])).toBeLessThan(0);
    });
});

describe('MIN_BUN_VERSION', () => {
    it('is 1.4.0, the oldest bun the suite is run against', () => {
        expect(MIN_BUN_VERSION).toBe('1.4.0');
    });

    it('matches the package.json engines floor', async () => {
        const pkg = await Bun.file(new URL('../../package.json', import.meta.url)).json() as { engines: { bun: string } };
        expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
    });
});

interface MockChild {
    stdoutHandler?: (data: Buffer) => void
    closeHandler?:  (code: number | null, signal: NodeJS.Signals | null) => void
    errorHandler?:  (error: Error) => void
    kill:           ReturnType<typeof mock>
}

describe('checkBunVersion', () => {
    let child: MockChild;

    beforeEach(() => {
        child = { kill: mock() };
        /* eslint-disable @typescript-eslint/no-explicit-any -- test mock of ChildProcess */
        const fake = {
            stdout: {
                on: mock((_event: string, handler: (data: Buffer) => void) => {
                    child.stdoutHandler = handler;
                }),
            } as any,
            on: mock((event: string, handler: (...args: any[]) => void) => {
                if(event === 'close') {
                    child.closeHandler = handler;
                } else if(event === 'error') {
                    child.errorHandler = handler;
                }
                return fake;
            }) as any,
            kill: child.kill,
        };
        /* eslint-enable @typescript-eslint/no-explicit-any -- re-enable after mock setup */
        mockSpawn.mockImplementation(() => fake as unknown as ChildProcess);
    });

    afterEach(() => {
        resetAllMocks();
    });

    /** Let checkBunVersion's internal promise reach the point of having registered handlers. */
    const settleSpawn = async (): Promise<void> => {
        await Promise.resolve();
    };

    it('returns the detected version when bun is new enough', async () => {
        const result = checkBunVersion('bun');
        await settleSpawn();
        child.stdoutHandler?.(Buffer.from('1.4.2\n'));
        child.closeHandler?.(0, null);

        expect(await result).toBe('1.4.2');
    });

    it('spawns "<bunPath> --version" with the configured path, no stdin, and piped output', async () => {
        const result = checkBunVersion('/opt/bun/bin/bun');
        await settleSpawn();
        child.stdoutHandler?.(Buffer.from('1.4.2\n'));
        child.closeHandler?.(0, null);
        await result;

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockSpawn).toHaveBeenCalledWith('/opt/bun/bin/bun', ['--version'], expect.objectContaining({
            stdio: ['ignore', 'pipe', 'pipe'],
        }));
    });

    it('passes bun.env (including PATH) over process.env, as the real spawn does', async () => {
        const result = checkBunVersion('bun', { PATH: '/custom/bin', EXTRA: 'x' });
        await settleSpawn();
        child.stdoutHandler?.(Buffer.from('1.4.2\n'));
        child.closeHandler?.(0, null);
        await result;

        const options = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
        expect(options.env.PATH).toBe('/custom/bin');
        expect(options.env.EXTRA).toBe('x');
        // Unrelated inherited variables survive the overlay.
        expect(options.env.HOME).toBe(process.env.HOME);
    });

    it('accepts exactly the minimum version and anything newer (numeric compare)', async () => {
        for(const output of ['1.4.0', '1.4.10', '1.10.0', '2.0.0']) {
            mockSpawn.mockClear();
            const result = checkBunVersion('bun');
            // eslint-disable-next-line no-await-in-loop -- sequential: each iteration re-uses the shared mock child
            await settleSpawn();
            child.stdoutHandler?.(Buffer.from(`${output}\n`));
            child.closeHandler?.(0, null);
            // eslint-disable-next-line no-await-in-loop -- sequential, see above
            expect(await result).toBe(output);
        }
    });

    it('rejects with the "too old" message when below the minimum version', async () => {
        const result = checkBunVersion('/usr/local/bin/bun');
        await settleSpawn();
        // The last 1.3 release, just below the 1.4.0 floor.
        child.stdoutHandler?.(Buffer.from('1.3.14\n'));
        child.closeHandler?.(0, null);

        const error = await result.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            'stryker-bun-runner: bun 1.3.14 at "/usr/local/bin/bun" is too old; version 1.4.0 or newer is required.'
        );
    });

    it('rejects every version below 1.4.0, whichever component is lower', async () => {
        for(const output of ['1.3.7', '1.3.99', '0.99.99']) {
            mockSpawn.mockClear();
            const result = checkBunVersion('bun');
            // eslint-disable-next-line no-await-in-loop -- sequential: each iteration re-uses the shared mock child
            await settleSpawn();
            child.stdoutHandler?.(Buffer.from(`${output}\n`));
            child.closeHandler?.(0, null);
            // eslint-disable-next-line no-await-in-loop -- sequential, see above
            const error = await result.catch((e: unknown) => e);
            expect((error as Error).message).toBe(`stryker-bun-runner: bun ${output} at "bun" is too old; version 1.4.0 or newer is required.`);
        }
    });

    it('rejects with the "could not run" message including the error code when spawn emits an error (ENOENT)', async () => {
        const result = checkBunVersion('bun');
        await settleSpawn();
        child.errorHandler?.(Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' }));

        const error = await result.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            'stryker-bun-runner: could not run "bun" (ENOENT). Install bun >= 1.4.0 or set bun.bunPath in your Stryker config.'
        );
    });

    it('rejects with "could not run" when spawn throws synchronously', async () => {
        mockSpawn.mockImplementation(() => {
            throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
        });

        const error = await checkBunVersion('/nope/bun').catch((e: unknown) => e);
        expect((error as Error).message).toBe(
            'stryker-bun-runner: could not run "/nope/bun" (EACCES). Install bun >= 1.4.0 or set bun.bunPath in your Stryker config.'
        );
    });

    it('rejects with "could not run" naming the exit code when bun --version exits non-zero', async () => {
        const result = checkBunVersion('bun');
        await settleSpawn();
        child.closeHandler?.(2, null);

        const error = await result.catch((e: unknown) => e);
        expect((error as Error).message).toContain('could not run "bun" (exit code 2)');
    });

    it('rejects with "could not run" naming the signal when bun --version is signalled', async () => {
        const result = checkBunVersion('bun');
        await settleSpawn();
        child.closeHandler?.(null, 'SIGSEGV');

        const error = await result.catch((e: unknown) => e);
        expect((error as Error).message).toContain('could not run "bun" (terminated by SIGSEGV)');
    });

    it('rejects with "could not run" when the output contains no version', async () => {
        const result = checkBunVersion('bun');
        await settleSpawn();
        child.stdoutHandler?.(Buffer.from('hello\n'));
        child.closeHandler?.(0, null);

        const error = await result.catch((e: unknown) => e);
        expect((error as Error).message).toContain('could not run "bun" (unrecognized --version output "hello")');
    });

    describe('when --version never finishes (fake clock)', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('kills the child and rejects with "could not run" when --version does not finish in time', async () => {
            const { value: error, fakeMs } = await runUntilSettled(checkBunVersion('bun', undefined, 10).catch((e: unknown) => e));

            expect(fakeMs).toBe(10);
            expect(child.kill).toHaveBeenCalledWith('SIGKILL');
            expect((error as Error).message).toContain('could not run "bun" (timed out after 10ms)');
        });

        it('ignores a late close after the timeout already settled the check', async () => {
            const { value: error } = await runUntilSettled(checkBunVersion('bun', undefined, 10).catch((e: unknown) => e));
            child.stdoutHandler?.(Buffer.from('1.4.2\n'));
            child.closeHandler?.(0, null);

            expect((error as Error).message).toContain('timed out');
        });
    });
});
