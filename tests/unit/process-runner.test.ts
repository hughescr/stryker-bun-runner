/**
 * Unit tests for process-runner
 * Tests the Bun process spawning and management utilities
 */

import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import { runBunTests } from '../../src/process-runner.js';
import * as processRss from '../../src/utils/process-rss.js';
import { mockSpawn, resetChildProcessMocks } from '../test-preload.js';

/**
 * Extended mock interface for ChildProcess with handler storage
 * Used to capture event handlers during mocking for later invocation in tests
 */
interface MockChildProcess extends Partial<ChildProcess> {
    stdoutHandler?: (data: Buffer) => void
    stderrHandler?: (data: Buffer) => void
    closeHandler?:  (code: number | null) => void
    errorHandler?:  (error: Error) => void
}

describe('runBunTests', () => {
    let mockChildProcess: MockChildProcess;

    beforeEach(() => {
    // Create a mock child process
        /* eslint-disable @typescript-eslint/no-explicit-any -- mock child process with any-typed properties */
        mockChildProcess = {
            stdout: {
                on: mock((event: string, handler: (data: Buffer) => void) => {
                    // Store handler for later invocation
                    if(event === 'data') {
                        mockChildProcess.stdoutHandler = handler;
                    }
                }),
            } as any,
            stderr: {
                on: mock((event: string, handler: (data: Buffer) => void) => {
                    // Store handler for later invocation
                    if(event === 'data') {
                        mockChildProcess.stderrHandler = handler;
                    }
                }),
            } as any,
            on: mock((event: string, handler: (...args: any[]) => void) => {
                // Store handlers for later invocation
                if(event === 'close') {
                    mockChildProcess.closeHandler = handler;
                } else if(event === 'error') {
                    mockChildProcess.errorHandler = handler;
                }
                return mockChildProcess as ChildProcess;
            }) as any,
            kill: mock(() => true),
            pid:  12_345,
        };
        /* eslint-enable @typescript-eslint/no-explicit-any -- re-enable after mock setup */

        // Configure preload mock spawn to return our mock child process
        mockSpawn.mockClear();
        mockSpawn.mockImplementation(() => mockChildProcess as ChildProcess);
    });

    afterEach(() => {
        // Reset preload mocks and timers to prevent leakage to other tests
        resetChildProcessMocks();
        jest.useRealTimers();
    });

    describe('successful test runs', () => {
        it('should spawn bun test with correct arguments', async () => {
            // Start the async operation
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Wait a tick for spawn to be called
            await Promise.resolve();

            // Simulate successful test run
            mockChildProcess.stdoutHandler?.(Buffer.from('test output'));
            mockChildProcess.closeHandler?.(0);

            const result = await resultPromise;

            expect(mockSpawn).toHaveBeenCalledWith(
                'bun',
                ['test'],
                expect.objectContaining({
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
            );
            expect(result.exitCode).toBe(0);
            expect(result.timedOut).toBe(false);
        });

        it('should collect stdout output', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Simulate test output
            mockChildProcess.stdoutHandler?.(Buffer.from('line 1\n'));
            mockChildProcess.stdoutHandler?.(Buffer.from('line 2\n'));
            mockChildProcess.closeHandler?.(0);

            const result = await resultPromise;

            expect(result.stdout).toBe('line 1\nline 2\n');
            expect(result.stderr).toBe('');
        });

        it('should collect stderr output', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Simulate error output
            mockChildProcess.stderrHandler?.(Buffer.from('warning: test warning\n'));
            mockChildProcess.closeHandler?.(0);

            const result = await resultPromise;

            expect(result.stderr).toBe('warning: test warning\n');
        });

        it('should collect both stdout and stderr', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Simulate mixed output
            mockChildProcess.stdoutHandler?.(Buffer.from('stdout line\n'));
            mockChildProcess.stderrHandler?.(Buffer.from('stderr line\n'));
            mockChildProcess.closeHandler?.(0);

            const result = await resultPromise;

            expect(result.stdout).toBe('stdout line\n');
            expect(result.stderr).toBe('stderr line\n');
        });
    });

    describe('failed test runs', () => {
        it('should handle non-zero exit codes', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Simulate test failure
            mockChildProcess.stdoutHandler?.(Buffer.from('test failed\n'));
            mockChildProcess.closeHandler?.(1);

            const result = await resultPromise;

            expect(result.exitCode).toBe(1);
            expect(result.timedOut).toBe(false);
        });

        it('should handle process errors', async () => {
            const resultPromise = runBunTests({
                bunPath: 'invalid-bun-path',
                timeout: 5000,
            });

            // Simulate process error
            const error = new Error('ENOENT: no such file or directory');
            mockChildProcess.errorHandler?.(error);

            const result = await resultPromise;

            expect(result.exitCode).toBeNull();
            expect(result.stderr).toContain('ENOENT: no such file or directory');
        });
    });

    describe('timeout handling', () => {
        it('should send SIGTERM (not immediate SIGKILL) when the timeout fires', async () => {
            jest.useFakeTimers();

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100, // Short timeout for testing
            });

            // Advance timers past the timeout, but not past the SIGKILL grace period
            jest.advanceTimersByTime(150);

            // Process responds to SIGTERM and exits promptly
            mockChildProcess.closeHandler?.(null);

            const result = await resultPromise;

            expect(result.timedOut).toBe(true);
            expect(result.exitCode).toBeNull();
            expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
            expect(mockChildProcess.kill).not.toHaveBeenCalledWith('SIGKILL');

            jest.useRealTimers();
        });

        it('should escalate to SIGKILL when the process ignores SIGTERM past the grace period', async () => {
            jest.useFakeTimers();

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100,
            });

            // Fire the timeout (sends SIGTERM) then let the grace period elapse
            // WITHOUT the process closing — it should escalate to SIGKILL.
            jest.advanceTimersByTime(100 + 500 + 1);

            expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
            expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');

            // Now let the (unresponsive) process actually close so the promise resolves
            mockChildProcess.closeHandler?.(null);
            const result = await resultPromise;

            expect(result.timedOut).toBe(true);
            expect(result.exitCode).toBeNull();

            jest.useRealTimers();
        });

        it('does not escalate to SIGKILL if the process closes within the grace period, even once time advances past it', async () => {
            jest.useFakeTimers();
            try {
                const resultPromise = runBunTests({
                    bunPath: 'bun',
                    timeout: 100,
                });

                // Fire the timeout (sends SIGTERM, schedules a grace-period SIGKILL).
                jest.advanceTimersByTime(100);

                // The process responds promptly and exits — this must mark the run as
                // closed (hasClosed) so the still-pending grace-period escalation is
                // skipped even once that timer later fires.
                mockChildProcess.closeHandler?.(null);

                // Advance well past the 500ms grace period.
                jest.advanceTimersByTime(600);

                expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
                expect(mockChildProcess.kill).not.toHaveBeenCalledWith('SIGKILL');

                const result = await resultPromise;
                expect(result.timedOut).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });

        it('does not escalate to SIGKILL if the process errors within the grace period, even once time advances past it', async () => {
            jest.useFakeTimers();
            try {
                const resultPromise = runBunTests({
                    bunPath: 'bun',
                    timeout: 100,
                });

                // Fire the timeout (sends SIGTERM, schedules a grace-period SIGKILL).
                jest.advanceTimersByTime(100);

                // The process errors out (e.g. spawn failure surfaced late) — this must
                // mark the run as closed (hasClosed) via the 'error' handler so the
                // still-pending grace-period escalation is skipped once that timer fires.
                mockChildProcess.errorHandler?.(new Error('boom'));

                // Advance well past the 500ms grace period.
                jest.advanceTimersByTime(600);

                expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
                expect(mockChildProcess.kill).not.toHaveBeenCalledWith('SIGKILL');

                const result = await resultPromise;
                expect(result.timedOut).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });

        it('should not timeout if process completes in time', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Complete quickly
            mockChildProcess.closeHandler?.(0);

            const result = await resultPromise;

            expect(result.timedOut).toBe(false);
            expect(mockChildProcess.kill).not.toHaveBeenCalled();
        });
    });

    describe('environment variable handling', () => {
        it('should pass custom environment variables', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                env:     {
                    CUSTOM_VAR:  'custom_value',
                    ANOTHER_VAR: 'another_value',
                },
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            expect(spawnOptions.env).toMatchObject({
                CUSTOM_VAR:  'custom_value',
                ANOTHER_VAR: 'another_value',
            });
        });

        it('should set __STRYKER_ACTIVE_MUTANT__ when activeMutant is provided', async () => {
            const resultPromise = runBunTests({
                bunPath:      'bun',
                timeout:      5000,
                activeMutant: '42',
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            expect(spawnOptions.env!.__STRYKER_ACTIVE_MUTANT__).toBe('42');
        });

        it('should set __STRYKER_COVERAGE_FILE__ when coverageFile is provided', async () => {
            const resultPromise = runBunTests({
                bunPath:      'bun',
                timeout:      5000,
                coverageFile: '/tmp/coverage.json',
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            expect(spawnOptions.env!.__STRYKER_COVERAGE_FILE__).toBe('/tmp/coverage.json');
        });

        it('should set __STRYKER_SYNC_PORT__ when syncPort is provided', async () => {
            const resultPromise = runBunTests({
                bunPath:  'bun',
                timeout:  5000,
                syncPort: 8080,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            expect(spawnOptions.env!.__STRYKER_SYNC_PORT__).toBe('8080');
        });
    });

    describe('test filtering and options', () => {
        it('should add --test-name-pattern when testNamePattern is provided', async () => {
            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                testNamePattern: 'should.*add',
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).toContain('--test-name-pattern');
            expect(args).toContain('should.*add');
        });

        it('should add --bail flag when bail is true', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    true,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).toContain('--bail');
        });

        it('should add --preload flag when preloadScript is provided', async () => {
            const resultPromise = runBunTests({
                bunPath:       'bun',
                timeout:       5000,
                preloadScript: '/tmp/preload.ts',
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).toContain('--preload');
            expect(args).toContain('/tmp/preload.ts');
        });

        it('should add custom bunArgs', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bunArgs: ['--only', '--verbose'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).toContain('--only');
            expect(args).toContain('--verbose');
        });

        it('should combine all options correctly', async () => {
            const resultPromise = runBunTests({
                bunPath:         '/custom/bun',
                timeout:         5000,
                testNamePattern: 'myTest',
                bail:            true,
                preloadScript:   '/tmp/preload.ts',
                bunArgs:         ['--verbose'],
                activeMutant:    '123',
                coverageFile:    '/tmp/coverage.json',
                env:             { CUSTOM: 'value' },
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const [bunPath, args, options] = spawnCall;

            expect(bunPath).toBe('/custom/bun');
            expect(args).toEqual([
                'test',
                '--preload',
                '/tmp/preload.ts',
                '--test-name-pattern',
                'myTest',
                '--bail',
                '--verbose',
            ]);

            expect(options.env!.__STRYKER_ACTIVE_MUTANT__).toBe('123');

            expect(options.env!.__STRYKER_COVERAGE_FILE__).toBe('/tmp/coverage.json');

            expect(options.env!.CUSTOM).toBe('value');
        });
    });

    describe('sequentialMode option', () => {
        it('should add --concurrency=1 flag when sequentialMode is true', async () => {
            const resultPromise = runBunTests({
                bunPath:        'bun',
                timeout:        5000,
                sequentialMode: true,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).toContain('--concurrency=1');
        });

        it('should not add --concurrency flag when sequentialMode is false', async () => {
            const resultPromise = runBunTests({
                bunPath:        'bun',
                timeout:        5000,
                sequentialMode: false,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).not.toContain('--concurrency=1');
        });
    });

    describe('bunfigPath option', () => {
        // bun requires the equals-joined form `--config=PATH`.  With a space-
        // separated pair, bun silently ignores the flag and treats PATH as a
        // positional test-file filter, so the project's own bunfig.toml is used
        // and the sanitized overrides never take effect.
        it('should pass --config=<path> as a single joined argument when bunfigPath is set', async () => {
            const resultPromise = runBunTests({
                bunPath:    'bun',
                timeout:    5000,
                bunfigPath: '/tmp/sanitized-bunfig.toml',
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toContain('--config=/tmp/sanitized-bunfig.toml');
            // Regression guard: reject the space-separated form entirely.
            expect(args).not.toContain('--config');
            expect(args).not.toContain('/tmp/sanitized-bunfig.toml');
        });

        it('should place --config=<path> before --preload in arg order', async () => {
            const resultPromise = runBunTests({
                bunPath:       'bun',
                timeout:       5000,
                bunfigPath:    '/tmp/sanitized.toml',
                preloadScript: '/tmp/preload.ts',
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            const configIdx  = args.indexOf('--config=/tmp/sanitized.toml');
            const preloadIdx = args.indexOf('--preload');

            expect(configIdx).toBeGreaterThan(-1);
            expect(preloadIdx).toBeGreaterThan(-1);
            expect(configIdx).toBeLessThan(preloadIdx);
        });

        it('should not add --config flag when bunfigPath is undefined', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args.some(a => a.startsWith('--config'))).toBe(false);
        });
    });

    describe('argument ordering', () => {
        it('should maintain correct argument order', async () => {
            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                preloadScript:   '/tmp/preload.ts',
                testNamePattern: 'test',
                bail:            true,
                bunArgs:         ['--only'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Verify order: test, preload, test-name-pattern, bail, then custom args
            expect(args[0]).toBe('test');
            expect(args[1]).toBe('--preload');
            expect(args[2]).toBe('/tmp/preload.ts');
            expect(args[3]).toBe('--test-name-pattern');
            expect(args[4]).toBe('test');
            expect(args[5]).toBe('--bail');
            expect(args[6]).toBe('--only');
        });
    });

    describe('testFiles positional args', () => {
        it('should append testFiles as positional args after all flags', async () => {
            const resultPromise = runBunTests({
                bunPath:   'bun',
                timeout:   5000,
                bail:      true,
                testFiles: ['tests/alpha.test.ts', 'tests/beta.test.ts'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];

            // Flags must come before positional file args
            const bailIdx  = args.indexOf('--bail');
            const alphaIdx = args.indexOf('tests/alpha.test.ts');
            const betaIdx  = args.indexOf('tests/beta.test.ts');

            expect(bailIdx).toBeGreaterThan(-1);
            expect(alphaIdx).toBeGreaterThan(-1);
            expect(betaIdx).toBeGreaterThan(-1);
            expect(alphaIdx).toBeGreaterThan(bailIdx);
            expect(betaIdx).toBe(alphaIdx + 1);
        });

        it('should preserve testFiles order (sorted lexicographically by caller)', async () => {
            const resultPromise = runBunTests({
                bunPath:   'bun',
                timeout:   5000,
                testFiles: ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            const aIdx = args.indexOf('tests/a.test.ts');
            const bIdx = args.indexOf('tests/b.test.ts');
            const cIdx = args.indexOf('tests/c.test.ts');

            expect(aIdx).toBeGreaterThan(-1);
            expect(bIdx).toBe(aIdx + 1);
            expect(cIdx).toBe(aIdx + 2);
        });

        it('should place testFiles after bunArgs', async () => {
            const resultPromise = runBunTests({
                bunPath:   'bun',
                timeout:   5000,
                bunArgs:   ['--only'],
                testFiles: ['tests/foo.test.ts'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            const onlyIdx = args.indexOf('--only');
            const fooIdx  = args.indexOf('tests/foo.test.ts');

            expect(onlyIdx).toBeGreaterThan(-1);
            expect(fooIdx).toBeGreaterThan(-1);
            expect(fooIdx).toBeGreaterThan(onlyIdx);
        });

        it('should not add any positional file args when testFiles is undefined', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    true,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];

            // Only flags, no unexpected positional args
            expect(args).toEqual(['test', '--bail']);
        });

        it('should not add any positional file args when testFiles is empty', async () => {
            const resultPromise = runBunTests({
                bunPath:   'bun',
                timeout:   5000,
                testFiles: [],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];

            expect(args).toEqual(['test']);
        });
    });

    describe('inspector debugging', () => {
        it('should add --inspect flag when inspectWaitPort is specified', async () => {
            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                inspectWaitPort: 9229,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];
            expect(args).toContain('--inspect=9229');
        });

        it('should call onInspectorReady when inspector URL is found in stderr', async () => {
            const onInspectorReady = mock(() => {});

            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                inspectWaitPort: 9229,
                onInspectorReady,
            });

            // Simulate Bun's inspector URL output in stderr
            mockChildProcess.stderrHandler?.(Buffer.from('Debugger listening on:\nListening:\n  ws://localhost:9229/abc123def456\n'));

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            expect(onInspectorReady).toHaveBeenCalledWith('ws://localhost:9229/abc123def456');
        });

        it('should only extract inspector URL once even with multiple stderr chunks', async () => {
            const onInspectorReady = mock(() => {});

            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                inspectWaitPort: 9229,
                onInspectorReady,
            });

            // Simulate inspector URL in multiple chunks
            mockChildProcess.stderrHandler?.(Buffer.from('Debugger listening on:\n'));
            mockChildProcess.stderrHandler?.(Buffer.from('Listening:\n  ws://localhost:9229/session1\n'));
            mockChildProcess.stderrHandler?.(Buffer.from('More stderr output\n'));

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            // Should be called exactly once
            expect(onInspectorReady).toHaveBeenCalledTimes(1);
            expect(onInspectorReady).toHaveBeenCalledWith('ws://localhost:9229/session1');
        });
    });

    describe('bunArgs mutation tests', () => {
        it('should not add bunArgs when array is empty', async () => {
            // This test kills mutations on line 134: options.bunArgs.length > 0
            // If the mutation changes > 0 to >= 0, empty array would pass the check
            // but spreading empty array is harmless, so this may not kill that mutation
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bunArgs: [],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Args should only contain 'test', no extra elements
            expect(args).toEqual(['test']);
        });

        it('should not add bunArgs when undefined - kills line 134 ConditionalExpression mutation', async () => {
            // CRITICAL: This test kills the mutation on line 134: if(options.bunArgs && options.bunArgs.length > 0) → if(true)
            // If mutated to if(true), the code would execute args.push(...options.bunArgs) with undefined bunArgs
            // This would throw: "Cannot spread undefined" or similar error
            // We expect this to NOT throw and work correctly
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bunArgs: undefined,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Should work fine with no bunArgs added
            expect(args).toEqual(['test']);
        });

        it('should not crash when bunArgs is null - additional safety test', async () => {
            // Additional test to ensure null is handled (not just undefined)
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bunArgs: null as unknown as string[] | undefined,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            expect(args).toEqual(['test']);
        });
    });

    describe('conditional check mutation tests', () => {
        it('should not add empty bunArgs array elements - line 134 mutation', async () => {
            // Kills mutation on line 134: if(options.bunArgs && options.bunArgs.length > 0)
            // If mutated to if(true), empty bunArgs would be spread incorrectly
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bunArgs: [], // Empty array should not add anything to args
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Should only have 'test', not any empty bunArgs
            expect(args).toEqual(['test']);
        });

        it('should skip testNameFilter when not provided - line 145 mutation', async () => {
            // Kills mutation on line 145: if(options.testNamePattern) → if(true)
            // If mutated to always true, would crash trying to access undefined testNamePattern
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                // testNamePattern intentionally not provided
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Should not include --test-name-pattern flag
            expect(args).not.toContain('--test-name-pattern');
        });

        it('should skip bail when not provided - line 150 mutation', async () => {
            // Kills mutation on line 150: if(options.bail) → if(true)
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false, // Explicitly false
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Should not include --bail flag
            expect(args).not.toContain('--bail');
        });

        it('should skip --config when bunfigPath not provided', async () => {
            // Kills mutation on if(options.bunfigPath) → if(true)
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                // bunfigPath intentionally omitted
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const args = spawnCall[1];

            // Should not include any --config flag (neither `--config=<path>` nor `--config` on its own)
            expect((args).some(a => a.startsWith('--config'))).toBe(false);
        });

        it('should skip onInspectorReady callback when not provided - line 179 mutation', async () => {
            // Kills mutation on line 179: if(options.onInspectorReady) → if(true)
            // If mutated to always true, would crash trying to call undefined callback
            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                inspectWaitPort: 9229,
                // onInspectorReady intentionally not provided
            });

            // Simulate inspector output
            mockChildProcess.stderrHandler?.(Buffer.from('Listening:\n  ws://localhost:9229/abc123\n'));
            mockChildProcess.closeHandler?.(0);

            // Should not crash despite onInspectorReady being undefined
            expect(await resultPromise).toBeDefined();
        });

        it('should only extract inspector URL when stderr contains expected pattern - line 187 mutation', async () => {
            // Kills mutation on line 187: if(match) → if(true)

            const onInspectorReady = mock(() => {});

            const resultPromise = runBunTests({
                bunPath:         'bun',
                timeout:         5000,
                inspectWaitPort: 9229,
                onInspectorReady,
            });

            // Send stderr that DOESN'T contain the inspector URL pattern
            mockChildProcess.stderrHandler?.(Buffer.from('Some random stderr output\n'));
            mockChildProcess.stderrHandler?.(Buffer.from('Error: something happened\n'));
            mockChildProcess.closeHandler?.(0);

            await resultPromise;

            // Callback should NOT be called because pattern didn't match
            expect(onInspectorReady).not.toHaveBeenCalled();
        });

        it('should not set __STRYKER_ACTIVE_MUTANT__ when activeMutant is undefined - line 145 mutation', async () => {
            // Kills mutation on line 145: if(options.activeMutant) → if(true)
            // If mutated to always true, would set env var to undefined
            // Store original value from process.env before test
            const originalValue = process.env.__STRYKER_ACTIVE_MUTANT__;

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                // activeMutant intentionally not provided
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            // Check that env matches process.env (not set to 'undefined' string)
            // When running in Stryker, process.env has this set; when running normally it's undefined

            expect(spawnOptions.env!.__STRYKER_ACTIVE_MUTANT__).toBe(originalValue);
        });

        it('should not set __STRYKER_COVERAGE_FILE__ when coverageFile is undefined - kills line 150 mutation', async () => {
            // CRITICAL: Kills mutation on line 150: if(options.coverageFile) → if(true)
            // If mutated to if(true), would execute: env.__STRYKER_COVERAGE_FILE__ = undefined
            // This explicitly sets the property to undefined, which is observable

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                // coverageFile intentionally not provided (undefined)
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            // The mutation would set the property to undefined explicitly
            // We check that the behavior matches: if process.env has it, we inherit it; if not, we don't set it
            // This test will fail if the mutation makes it always execute the assignment

            const actualValue = spawnOptions.env!.__STRYKER_COVERAGE_FILE__;
            const expectedValue = process.env.__STRYKER_COVERAGE_FILE__;

            // Both should be undefined (not set) when coverageFile option is not provided
            expect(actualValue).toBe(expectedValue);

            // Additionally verify it's actually undefined, not the string 'undefined'
            if(expectedValue === undefined) {
                expect(actualValue).toBeUndefined();
            }
        });

        it('should not set __STRYKER_SYNC_PORT__ when syncPort is undefined - line 155 mutation', async () => {
            // Kills mutation on line 155: if(options.syncPort) → if(true)
            // If mutated to always true, would set env var to string 'undefined'
            // Store original value from process.env before test
            const originalValue = process.env.__STRYKER_SYNC_PORT__;

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                // syncPort intentionally not provided
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];

            const spawnOptions = spawnCall[2];

            // Should match process.env value (could be undefined or inherited from parent)
            // The key check: if mutation changes condition to if(true), it would set to string 'undefined'
            // which would differ from originalValue (either undefined stays undefined correctly, or
            // if Stryker set a value, it should remain that value, not become 'undefined')

            expect(spawnOptions.env!.__STRYKER_SYNC_PORT__).toBe(originalValue);
        });
    });

    describe('null stdout/stderr handling mutation tests', () => {
        it('should handle null stdout gracefully - line 179 mutation', async () => {
            // Kills mutation on line 179: if(childProcess.stdout) → if(true)
            // If mutated to always true, would crash trying to call .on() on null stdout
            // Create a child process with null stdout
            const mockChildProcessNullStdout: MockChildProcess = {
                stdout: null, // Explicitly null

                stderr: {
                    on: mock((event: string, handler: (data: Buffer) => void) => {
                        if(event === 'data') {
                            mockChildProcessNullStdout.stderrHandler = handler;
                        }
                    }),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                } as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock requires any-typed handler
                on: mock((event: string, handler: (...args: any[]) => void) => {
                    if(event === 'close') {
                        mockChildProcessNullStdout.closeHandler = handler;
                    } else if(event === 'error') {
                        mockChildProcessNullStdout.errorHandler = handler;
                    }
                    return mockChildProcessNullStdout as ChildProcess;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                }) as any,

                kill: mock(() => true),
            };

            // Override preload mock to return our custom child process
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock implementation needs any type
            mockSpawn.mockImplementation(() => mockChildProcessNullStdout as any);

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Only stderr data, no stdout
            mockChildProcessNullStdout.stderrHandler?.(Buffer.from('stderr output\n'));
            mockChildProcessNullStdout.closeHandler?.(0);

            const result = await resultPromise;

            // Should not crash and stdout should be empty
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('stderr output\n');
            expect(result.exitCode).toBe(0);
        });

        it('should handle null stderr gracefully - line 187 mutation', async () => {
            // Kills mutation on line 187: if(childProcess.stderr) → if(true)
            // If mutated to always true, would crash trying to call .on() on null stderr
            // Create a child process with null stderr
            const mockChildProcessNullStderr: MockChildProcess = {

                stdout: {
                    on: mock((event: string, handler: (data: Buffer) => void) => {
                        if(event === 'data') {
                            mockChildProcessNullStderr.stdoutHandler = handler;
                        }
                    }),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                } as any,
                stderr: null, // Explicitly null
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock requires any-typed handler
                on:     mock((event: string, handler: (...args: any[]) => void) => {
                    if(event === 'close') {
                        mockChildProcessNullStderr.closeHandler = handler;
                    } else if(event === 'error') {
                        mockChildProcessNullStderr.errorHandler = handler;
                    }
                    return mockChildProcessNullStderr as ChildProcess;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                }) as any,

                kill: mock(() => true),
            };

            // Override preload mock to return our custom child process
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock implementation needs any type
            mockSpawn.mockImplementation(() => mockChildProcessNullStderr as any);

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Only stdout data, no stderr
            mockChildProcessNullStderr.stdoutHandler?.(Buffer.from('stdout output\n'));
            mockChildProcessNullStderr.closeHandler?.(0);

            const result = await resultPromise;

            // Should not crash and stderr should be empty
            expect(result.stdout).toBe('stdout output\n');
            expect(result.stderr).toBe('');
            expect(result.exitCode).toBe(0);
        });

        it('should handle both stdout and stderr being null - comprehensive test', async () => {
            // Test that both null stdout and null stderr are handled correctly
            const mockChildProcessBothNull: MockChildProcess = {
                stdout: null, // Explicitly null
                stderr: null, // Explicitly null
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock requires any-typed handler
                on:     mock((event: string, handler: (...args: any[]) => void) => {
                    if(event === 'close') {
                        mockChildProcessBothNull.closeHandler = handler;
                    } else if(event === 'error') {
                        mockChildProcessBothNull.errorHandler = handler;
                    }
                    return mockChildProcessBothNull as ChildProcess;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                }) as any,

                kill: mock(() => true),
            };

            // Override preload mock to return our custom child process
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock implementation needs any type
            mockSpawn.mockImplementation(() => mockChildProcessBothNull as any);

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Process completes with no output
            mockChildProcessBothNull.closeHandler?.(0);

            const result = await resultPromise;

            // Should not crash and both outputs should be empty
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
            expect(result.exitCode).toBe(0);
        });
    });

    describe('processKilled state mutation tests', () => {
        it('should return null exitCode when process is killed by timeout', async () => {
            // This test kills mutations on line 129 (processKilled = true → false)
            // and line 165 (processKilled ? null : code)
            // If processKilled stays false or the ternary is mutated,
            // exitCode would incorrectly be the signal code instead of null
            jest.useFakeTimers();

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100,
            });

            // Advance timers past the timeout
            jest.advanceTimersByTime(150);

            // Process was killed, close with no exit code (SIGKILL)
            mockChildProcess.closeHandler?.(null);

            const result = await resultPromise;

            // When process is killed by timeout, exitCode MUST be null
            expect(result.exitCode).toBeNull();
            expect(result.timedOut).toBe(true);

            jest.useRealTimers();
        });

        it('should return actual exitCode when process exits normally', async () => {
            // Verify that when processKilled is false, we get the actual exit code
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            // Process exits normally with code 1
            mockChildProcess.closeHandler?.(1);

            const result = await resultPromise;

            // When process exits normally, exitCode should be the actual code
            expect(result.exitCode).toBe(1);
            expect(result.timedOut).toBe(false);
        });

        it('should return null exitCode even if close handler receives a code after timeout kill', async () => {
            // This test specifically targets the mutation: processKilled = true → processKilled = false
            // Even if the close handler receives a non-null exit code (e.g., 143 for SIGTERM),
            // we should return null because processKilled should be true
            jest.useFakeTimers();

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100,
            });

            // Advance timers past the timeout
            jest.advanceTimersByTime(150);

            // Close handler receives exit code 143 (typical for SIGTERM) instead of null
            // But we should still return null because processKilled was set to true
            mockChildProcess.closeHandler?.(143);

            const result = await resultPromise;

            // Critical: exitCode must be null even though close handler received 143
            // This proves processKilled flag is working correctly
            expect(result.exitCode).toBeNull();
            expect(result.timedOut).toBe(true);

            jest.useRealTimers();
        });
    });

    describe('AbortSignal support', () => {
        it('aborts child process when signal fires after spawn', async () => {
            jest.useFakeTimers();
            try {
                const controller = new AbortController();

                const resultPromise = runBunTests({
                    bunPath: 'bun',
                    timeout: 10_000,
                    signal:  controller.signal,
                });

                // Let spawn happen
                await Promise.resolve();

                // Fire abort signal — should SIGTERM the child and resolve with timedOut:true
                controller.abort();

                // Simulate process closing after SIGTERM with a non-null exit code (e.g. 143
                // for SIGTERM on Linux).  processKilled=true must override the code to null;
                // mutating processKilled=false would leave exitCode=143 instead.
                mockChildProcess.closeHandler?.(143);

                const result = await resultPromise;

                expect(result.timedOut).toBe(true);
                expect(result.exitCode).toBeNull();
                expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
            } finally {
                jest.useRealTimers();
            }
        });

        it('resolves immediately with timedOut:true when signal is already aborted before spawn', async () => {
            const controller = new AbortController();
            controller.abort();  // Already aborted before calling runBunTests

            const result = await runBunTests({
                bunPath: 'bun',
                timeout: 10_000,
                signal:  controller.signal,
            });

            // Must resolve immediately without spawning a child process
            expect(result.timedOut).toBe(true);
            expect(result.exitCode).toBeNull();
            expect(result.memoryLimitExceeded).toBe(false);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
        });

        it('does not kill process when signal fires after process already closed normally', async () => {
            jest.useFakeTimers();
            try {
                const controller = new AbortController();

                const resultPromise = runBunTests({
                    bunPath: 'bun',
                    timeout: 10_000,
                    signal:  controller.signal,
                });

                // Process exits normally before abort fires
                mockChildProcess.closeHandler?.(0);

                const result = await resultPromise;

                // Normal exit — no abort involvement
                expect(result.exitCode).toBe(0);
                expect(result.timedOut).toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        it('escalates to SIGKILL when the process ignores SIGTERM after abort', async () => {
            jest.useFakeTimers();
            try {
                const controller = new AbortController();

                const resultPromise = runBunTests({
                    bunPath: 'bun',
                    timeout: 10_000,
                    signal:  controller.signal,
                });

                await Promise.resolve();
                controller.abort();

                // Let the 500ms grace period elapse without the process closing
                jest.advanceTimersByTime(501);

                expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
                expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');

                mockChildProcess.closeHandler?.(null);
                const result = await resultPromise;

                expect(result.timedOut).toBe(true);
                expect(result.exitCode).toBeNull();
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('smol option', () => {
        it('adds --smol flag when smol is true', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                smol:    true,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args = mockSpawn.mock.calls[0][1];
            expect(args).toContain('--smol');
        });

        it('does not add --smol flag when smol is false', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                smol:    false,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args = mockSpawn.mock.calls[0][1];
            expect(args).not.toContain('--smol');
        });

        it('does not add --smol flag when smol is undefined', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args = mockSpawn.mock.calls[0][1];
            expect(args).not.toContain('--smol');
        });
    });

    describe('maxChildRss memory ceiling', () => {
        let getRssSpy: ReturnType<typeof spyOn>;
        let clearIntervalSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            getRssSpy = spyOn(processRss, 'getProcessRssBytes');
            clearIntervalSpy = spyOn(globalThis, 'clearInterval');
        });

        afterEach(() => {
            getRssSpy.mockRestore();
            clearIntervalSpy.mockRestore();
        });

        it('does not probe RSS at all when maxChildRss is not set', async () => {
            jest.useFakeTimers();
            try {
                const resultPromise = runBunTests({ bunPath: 'bun', timeout: 5000 });

                jest.advanceTimersByTime(5000);
                mockChildProcess.closeHandler?.(0);
                await resultPromise;

                expect(getRssSpy).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it('kills the child and resolves memoryLimitExceeded:true when RSS exceeds maxChildRss', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(200 * 1024 * 1024);
                const onMemoryLimitExceeded = mock();

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                    onMemoryLimitExceeded,
                });

                // Fire one poll tick and let the RSS probe's promise settle
                jest.advanceTimersByTime(1000);
                await Promise.resolve();
                await Promise.resolve();

                expect(getRssSpy).toHaveBeenCalledWith(12_345);
                expect(onMemoryLimitExceeded).toHaveBeenCalledWith(200 * 1024 * 1024);
                expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');

                // Close with a non-null "exit code" (e.g. 137, typical for SIGKILL) to
                // prove exitCode is forced to null via processKilled, not merely because
                // we happened to pass null as the close code.
                mockChildProcess.closeHandler?.(137);
                const result = await resultPromise;

                expect(result.memoryLimitExceeded).toBe(true);
                expect(result.timedOut).toBe(true);
                expect(result.exitCode).toBeNull();
            } finally {
                jest.useRealTimers();
            }
        });

        it('clears the RSS poll interval as soon as the ceiling is exceeded (before the process closes)', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(200 * 1024 * 1024);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                jest.advanceTimersByTime(1000);
                await Promise.resolve();
                await Promise.resolve();

                // The interval must already be cleared at this point — the process
                // hasn't closed yet (mockChildProcess.closeHandler has not fired).
                expect(clearIntervalSpy).toHaveBeenCalled();

                mockChildProcess.closeHandler?.(null);
                await resultPromise;
            } finally {
                jest.useRealTimers();
            }
        });

        it('clears the RSS poll interval when the process closes normally (maxChildRss set, ceiling never exceeded)', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(10 * 1024 * 1024);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                mockChildProcess.closeHandler?.(0);
                await resultPromise;

                expect(clearIntervalSpy).toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it('clears the RSS poll interval when the process errors (maxChildRss set)', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(10 * 1024 * 1024);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                mockChildProcess.errorHandler?.(new Error('spawn failed'));
                await resultPromise;

                expect(clearIntervalSpy).toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it('does not kill the child when RSS is exactly equal to maxChildRss (only strictly greater kills)', async () => {
            jest.useFakeTimers();
            try {
                const ceiling = 100 * 1024 * 1024;
                getRssSpy.mockResolvedValue(ceiling);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        ceiling,
                    rssCheckIntervalMs: 1000,
                });

                jest.advanceTimersByTime(1000);
                await Promise.resolve();
                await Promise.resolve();

                expect(mockChildProcess.kill).not.toHaveBeenCalled();

                mockChildProcess.closeHandler?.(0);
                const result = await resultPromise;

                expect(result.memoryLimitExceeded).toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        it('does not re-kill or re-fire the callback if a poll tick was already queued when the ceiling was exceeded', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(200 * 1024 * 1024);
                const onMemoryLimitExceeded = mock();

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 10,
                    onMemoryLimitExceeded,
                });

                // Advance past several poll intervals in one shot. Fake-timer
                // implementations commonly invoke all due callbacks in a single
                // synchronous burst, so a second (and third) tick's synchronous
                // prefix can run before the first tick's probe promise resolves —
                // exercising the reentrancy guard at the top of checkMemoryCeiling.
                jest.advanceTimersByTime(35);
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();

                // Regardless of how many ticks fired before the first kill took
                // effect, the ceiling must only be reported/acted on once.
                expect(onMemoryLimitExceeded).toHaveBeenCalledTimes(1);
                const killMock = mockChildProcess.kill as ReturnType<typeof mock>;
                const sigtermCalls = killMock.mock.calls.filter((c: unknown[]) => c[0] === 'SIGTERM');
                expect(sigtermCalls.length).toBe(1);

                mockChildProcess.closeHandler?.(null);
                const result = await resultPromise;

                expect(result.memoryLimitExceeded).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });

        it('does not kill the child while RSS stays below maxChildRss', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(10 * 1024 * 1024);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                jest.advanceTimersByTime(1000);
                await Promise.resolve();
                await Promise.resolve();

                expect(mockChildProcess.kill).not.toHaveBeenCalled();

                mockChildProcess.closeHandler?.(0);
                const result = await resultPromise;

                expect(result.memoryLimitExceeded).toBe(false);
                expect(result.timedOut).toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        it('treats a null RSS probe result as unknown and does not kill the child', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(null);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                jest.advanceTimersByTime(1000);
                await Promise.resolve();
                await Promise.resolve();

                expect(mockChildProcess.kill).not.toHaveBeenCalled();

                mockChildProcess.closeHandler?.(0);
                const result = await resultPromise;

                expect(result.memoryLimitExceeded).toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        it('stops polling once the process has already closed', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(10 * 1024 * 1024);

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                mockChildProcess.closeHandler?.(0);
                await resultPromise;

                const callsAtClose = getRssSpy.mock.calls.length;

                // Advance well past several more poll intervals — the interval was
                // cleared on close, so the call count must not increase.
                jest.advanceTimersByTime(5000);
                await Promise.resolve();

                expect(getRssSpy.mock.calls.length).toBe(callsAtClose);
            } finally {
                jest.useRealTimers();
            }
        });

        it('defaults the poll interval to 1000ms when rssCheckIntervalMs is not provided', async () => {
            jest.useFakeTimers();
            try {
                getRssSpy.mockResolvedValue(10 * 1024 * 1024);

                const resultPromise = runBunTests({
                    bunPath:     'bun',
                    timeout:     60_000,
                    maxChildRss: 100 * 1024 * 1024,
                });

                jest.advanceTimersByTime(999);
                await Promise.resolve();
                expect(getRssSpy).not.toHaveBeenCalled();

                jest.advanceTimersByTime(1);
                await Promise.resolve();
                expect(getRssSpy).toHaveBeenCalledTimes(1);

                mockChildProcess.closeHandler?.(0);
                await resultPromise;
            } finally {
                jest.useRealTimers();
            }
        });

        it('does not probe RSS when the child has no pid', async () => {
            jest.useFakeTimers();
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test override of mock child process shape
                (mockChildProcess as any).pid = undefined;

                const resultPromise = runBunTests({
                    bunPath:            'bun',
                    timeout:            60_000,
                    maxChildRss:        100 * 1024 * 1024,
                    rssCheckIntervalMs: 1000,
                });

                jest.advanceTimersByTime(1000);
                await Promise.resolve();

                expect(getRssSpy).not.toHaveBeenCalled();

                mockChildProcess.closeHandler?.(0);
                await resultPromise;
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('bail is fully runner-managed — user bunArgs bail flags are stripped', () => {
        it('strips a bare --bail from bunArgs when the runner\'s own bail is false (disableBail case)', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test']);
        });

        it('strips the dry-run construction path too — bunArgs bail is stripped even when options.bail is omitted entirely', async () => {
            // dryRun never passes a `bail` option at all (undefined, not false) — this
            // must be stripped just the same as the explicit disableBail case above.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bunArgs: ['--bail'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test']);
        });

        it('strips the equals form --bail=3 from bunArgs', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail=3'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test']);
        });

        it('strips the space-separated --bail 5 form, dropping the trailing numeric token too', async () => {
            // Bun itself does not accept this form (the number is left over as a
            // positional test-file filter — see the regression guard test below), but
            // if a user writes it anyway both tokens must be dropped so the leftover
            // number doesn't survive as a stray positional filter.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail', '5'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test']);
        });

        it('does not swallow a non-numeric token that happens to follow a bare --bail', async () => {
            // Only a purely-numeric token immediately after a bare --bail is the
            // space-separated bail form; anything else (e.g. a test-file filter the
            // user genuinely intended) must survive.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail', 'not-a-number'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', 'not-a-number']);
        });

        it('does not swallow a trailing numeric token after the equals-form --bail=<N> (pairing only applies to the bare flag)', async () => {
            // The "consume the next token" pairing exists only to handle bun's
            // space-separated quirk for the *bare* `--bail` flag. A token that
            // follows the *equals* form is an unrelated, independent argument
            // (e.g. a positional test-file filter) and must survive untouched.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail=3', '5'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', '5']);
        });

        it('does not swallow a digit-prefixed but non-numeric token (e.g. "5x") after a bare --bail', async () => {
            // Confirms the trailing $ anchor in /^\d+$/ matters: a token that
            // merely starts with digits but has trailing non-digit characters
            // is not the space-separated bail-threshold form and must be left
            // alone rather than swallowed.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail', '5x'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', '5x']);
        });

        it('does not swallow a token with digits only at the end (e.g. "abc5") after a bare --bail', async () => {
            // Confirms the leading ^ anchor in /^\d+$/ matters: a token that
            // merely *ends* with digits but has non-digit characters before
            // them is not purely numeric and must be left alone rather than
            // swallowed.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail', 'abc5'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', 'abc5']);
        });

        it('swallows a multi-digit numeric token after a bare --bail, not just single digits', async () => {
            // Confirms the `+` quantifier in /^\d+$/ matters: a multi-digit
            // threshold like '42' must be recognised and stripped, not just
            // single-digit thresholds like the '5' used in other tests here.
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bail', '42'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test']);
        });

        it('does not strip look-alike flags such as --bailout', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--bailout'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', '--bailout']);
        });

        it('passes non-bail bunArgs entries through unchanged and in order, stripping only the bail entries', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    false,
                bunArgs: ['--only', '--bail', '--verbose', '--bail=2'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', '--only', '--verbose']);
        });

        it('emits exactly one --bail (the runner\'s own) when the runner bails, even if bunArgs also requests bail', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    true,
                bunArgs: ['--bail'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args.filter(a => a === '--bail').length).toBe(1);
            expect(args).toEqual(['test', '--bail']);
        });

        it('does not let a bunArgs --bail=<N> survive alongside the runner\'s own --bail', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
                bail:    true,
                bunArgs: ['--bail=9'],
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const args: readonly string[] = mockSpawn.mock.calls[0][1];
            expect(args).toEqual(['test', '--bail']);
        });
    });
});
