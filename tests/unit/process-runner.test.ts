/**
 * Unit tests for process-runner
 * Tests the Bun process spawning and management utilities
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { runBunTests } from '../../src/process-runner.js';
import type { ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';

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
    let mockSpawn: ReturnType<typeof mock>;
    let mockChildProcess: MockChildProcess;

    beforeEach(() => {
    // Create a mock child process
        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- mock child process with any-typed properties */
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
        };
        /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- re-enable after mock setup */

        // Mock spawn to return our mock child process
        mockSpawn = mock(() => mockChildProcess as ChildProcess);
        spyOn(childProcess, 'spawn').mockImplementation(mockSpawn);
    });

    afterEach(() => {
        mock.restore();
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
                ['test', '--no-randomize'],
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
        it('should timeout and kill process after timeout period', async () => {
            jest.useFakeTimers();

            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100, // Short timeout for testing
            });

            // Advance timers past the timeout
            jest.advanceTimersByTime(150);

            // Simulate process close after kill
            mockChildProcess.closeHandler?.(null);

            const result = await resultPromise;

            expect(result.timedOut).toBe(true);
            expect(result.exitCode).toBeNull();
            expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');

            jest.useRealTimers();
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
            expect(spawnOptions.env.__STRYKER_ACTIVE_MUTANT__).toBe('42');
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
            expect(spawnOptions.env.__STRYKER_COVERAGE_FILE__).toBe('/tmp/coverage.json');
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
            expect(spawnOptions.env.__STRYKER_SYNC_PORT__).toBe('8080');
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- destructuring mock call data
            const [bunPath, args, options] = spawnCall;

            expect(bunPath).toBe('/custom/bun');
            expect(args).toEqual([
                'test',
                '--preload',
                '/tmp/preload.ts',
                '--test-name-pattern',
                'myTest',
                '--bail',
                '--no-randomize',
                '--verbose',
            ]);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
            expect(options.env.__STRYKER_ACTIVE_MUTANT__).toBe('123');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
            expect(options.env.__STRYKER_COVERAGE_FILE__).toBe('/tmp/coverage.json');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing env property from mock options
            expect(options.env.CUSTOM).toBe('value');
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];
            expect(args).not.toContain('--concurrency=1');
        });
    });

    describe('noCoverage option', () => {
        it('should add --no-coverage flag when noCoverage is true', async () => {
            const resultPromise = runBunTests({
                bunPath:    'bun',
                timeout:    5000,
                noCoverage: true,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];
            expect(args).toContain('--no-coverage');
        });

        it('should not add --no-coverage flag when noCoverage is false', async () => {
            const resultPromise = runBunTests({
                bunPath:    'bun',
                timeout:    5000,
                noCoverage: false,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];
            expect(args).not.toContain('--no-coverage');
        });

        it('should not add --no-coverage flag when noCoverage is undefined', async () => {
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 5000,
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];
            expect(args).not.toContain('--no-coverage');
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            /* eslint-disable @typescript-eslint/no-unsafe-member-access -- accessing array indices from mock args */
            // Verify order: test, preload, test-name-pattern, bail, no-randomize, then custom args
            expect(args[0]).toBe('test');
            expect(args[1]).toBe('--preload');
            expect(args[2]).toBe('/tmp/preload.ts');
            expect(args[3]).toBe('--test-name-pattern');
            expect(args[4]).toBe('test');
            expect(args[5]).toBe('--bail');
            expect(args[6]).toBe('--no-randomize');
            expect(args[7]).toBe('--only');
            /* eslint-enable @typescript-eslint/no-unsafe-member-access -- re-enable after array index access */
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];
            expect(args).toContain('--inspect=9229');
        });

        it('should call onInspectorReady when inspector URL is found in stderr', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
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
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            // Args should only contain 'test' and '--no-randomize', no extra elements
            expect(args).toEqual(['test', '--no-randomize']);
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            // Should work fine with no bunArgs added
            expect(args).toEqual(['test', '--no-randomize']);
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            expect(args).toEqual(['test', '--no-randomize']);
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            // Should only have 'test' and '--no-randomize', not any empty bunArgs
            expect(args).toEqual(['test', '--no-randomize']);
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            // Should not include --bail flag
            expect(args).not.toContain('--bail');
        });

        it('should skip noCoverage when not provided - line 155 mutation', async () => {
            // Kills mutation on line 155: if(options.noCoverage) → if(true)
            const resultPromise = runBunTests({
                bunPath:    'bun',
                timeout:    5000,
                noCoverage: false, // Explicitly false
            });

            mockChildProcess.closeHandler?.(0);
            await resultPromise;

            const spawnCall = mockSpawn.mock.calls[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing args from mock
            const args = spawnCall[1];

            // Should not include --no-coverage flag
            expect(args).not.toContain('--no-coverage');
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
            await expect(resultPromise).resolves.toBeDefined();
        });

        it('should only extract inspector URL when stderr contains expected pattern - line 187 mutation', async () => {
            // Kills mutation on line 187: if(match) → if(true)
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];

            // Check that env matches process.env (not set to 'undefined' string)
            // When running in Stryker, process.env has this set; when running normally it's undefined
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock spawn options
            expect(spawnOptions.env.__STRYKER_ACTIVE_MUTANT__).toBe(originalValue);
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];

            // The mutation would set the property to undefined explicitly
            // We check that the behavior matches: if process.env has it, we inherit it; if not, we don't set it
            // This test will fail if the mutation makes it always execute the assignment
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- accessing mock spawn options
            const actualValue = spawnOptions.env.__STRYKER_COVERAGE_FILE__;
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing spawn options from mock
            const spawnOptions = spawnCall[2];

            // Should match process.env value (could be undefined or inherited from parent)
            // The key check: if mutation changes condition to if(true), it would set to string 'undefined'
            // which would differ from originalValue (either undefined stays undefined correctly, or
            // if Stryker set a value, it should remain that value, not become 'undefined')
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock spawn options
            expect(spawnOptions.env.__STRYKER_SYNC_PORT__).toBe(originalValue);
        });
    });

    describe('null stdout/stderr handling mutation tests', () => {
        it('should handle null stdout gracefully - line 179 mutation', async () => {
            // Kills mutation on line 179: if(childProcess.stdout) → if(true)
            // If mutated to always true, would crash trying to call .on() on null stdout
            // Create a child process with null stdout
            const mockChildProcessNullStdout: MockChildProcess = {
                stdout: null, // Explicitly null
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock child process with any-typed properties
                stderr: {
                    on: mock((event: string, handler: (data: Buffer) => void) => {
                        if(event === 'data') {
                            mockChildProcessNullStdout.stderrHandler = handler;
                        }
                    }),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                } as any,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- mock requires any-typed handler
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

            const mockSpawnNull = mock(() => mockChildProcessNullStdout);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- mock implementation needs any type
            spyOn(childProcess, 'spawn').mockImplementation(mockSpawnNull as any);

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
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock child process with any-typed properties
                stdout: {
                    on: mock((event: string, handler: (data: Buffer) => void) => {
                        if(event === 'data') {
                            mockChildProcessNullStderr.stdoutHandler = handler;
                        }
                    }),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock child process with any-typed properties
                } as any,
                stderr: null, // Explicitly null
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- mock requires any-typed handler
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

            const mockSpawnNull = mock(() => mockChildProcessNullStderr);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- mock implementation needs any type
            spyOn(childProcess, 'spawn').mockImplementation(mockSpawnNull as any);

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
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- mock requires any-typed handler
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

            const mockSpawnNull = mock(() => mockChildProcessBothNull);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- mock implementation needs any type
            spyOn(childProcess, 'spawn').mockImplementation(mockSpawnNull as any);

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
});
