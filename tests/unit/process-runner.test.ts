/**
 * Unit tests for process-runner
 * Tests the Bun process spawning and management utilities
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
            await new Promise(resolve => setTimeout(resolve, 10));

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
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100, // Short timeout for testing
            });

            // Wait for timeout to trigger
            await new Promise(resolve => setTimeout(resolve, 150));

            // Simulate process close after kill
            mockChildProcess.closeHandler?.(null);

            const result = await resultPromise;

            expect(result.timedOut).toBe(true);
            expect(result.exitCode).toBeNull();
            expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
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

    describe('bunArgs mutation tests', () => {
        it('should not add bunArgs when array is empty', async () => {
            // This test kills mutations on line 105: options.bunArgs.length > 0
            // If the mutation changes > 0 to >= 0 or changes it to true,
            // an empty array would incorrectly spread empty elements into args
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

        it('should not add bunArgs when undefined', async () => {
            // Test that undefined bunArgs doesn't add any extra arguments
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

            expect(args).toEqual(['test', '--no-randomize']);
        });
    });

    describe('processKilled state mutation tests', () => {
        it('should return null exitCode when process is killed by timeout', async () => {
            // This test kills mutations on line 129 (processKilled = true → false)
            // and line 165 (processKilled ? null : code)
            // If processKilled stays false or the ternary is mutated,
            // exitCode would incorrectly be the signal code instead of null
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100,
            });

            // Wait for timeout to kill the process
            await new Promise(resolve => setTimeout(resolve, 150));

            // Process was killed, close with no exit code (SIGKILL)
            mockChildProcess.closeHandler?.(null);

            const result = await resultPromise;

            // When process is killed by timeout, exitCode MUST be null
            expect(result.exitCode).toBeNull();
            expect(result.timedOut).toBe(true);
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
            const resultPromise = runBunTests({
                bunPath: 'bun',
                timeout: 100,
            });

            // Wait for timeout to kill the process
            await new Promise(resolve => setTimeout(resolve, 150));

            // Close handler receives exit code 143 (typical for SIGTERM) instead of null
            // But we should still return null because processKilled was set to true
            mockChildProcess.closeHandler?.(143);

            const result = await resultPromise;

            // Critical: exitCode must be null even though close handler received 143
            // This proves processKilled flag is working correctly
            expect(result.exitCode).toBeNull();
            expect(result.timedOut).toBe(true);
        });
    });
});
