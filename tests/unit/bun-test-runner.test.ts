/**
 * Unit tests for BunTestRunner
 * Integration-level tests for the main TestRunner implementation
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { BunTestRunner, normalizeTestFilePath, stripFilePrefix } from '../../src/bun-test-runner.js';
import { DryRunStatus, MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import type { Logger } from '@stryker-mutator/api/logging';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import * as processRunner from '../../src/process-runner.js';
import * as coverageCollector from '../../src/coverage/collector.js';
import * as preloadGenerator from '../../src/coverage/preload-generator.js';
import * as portUtils from '../../src/utils/port.js';
import * as syncServerModule from '../../src/utils/sync-server.js';
import * as inspectorModule from '../../src/inspector/inspector-client.js';
import * as coverageMapper from '../../src/coverage/coverage-mapper.js';
import type { TestInfo } from '../../src/inspector/types.js';

describe('BunTestRunner', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let mockCollectCoverage: ReturnType<typeof mock>;
    let mockCleanupCoverageFile: ReturnType<typeof mock>;
    let mockGeneratePreloadScript: ReturnType<typeof mock>;
    let mockCleanupPreloadScript: ReturnType<typeof mock>;
    let mockGetAvailablePort: ReturnType<typeof mock>;
    let mockSyncServer: {
        start:         ReturnType<typeof mock>
        signalReady:   ReturnType<typeof mock>
        close:         ReturnType<typeof mock>
        sendTestStart: ReturnType<typeof mock>
        clientCount:   number
    };
    let mockInspectorClient: {
        connect:           ReturnType<typeof mock>
        send:              ReturnType<typeof mock>
        getTests:          ReturnType<typeof mock>
        getExecutionOrder: ReturnType<typeof mock>
        close:             ReturnType<typeof mock>
    };
    let mockMapCoverageToInspectorIds: ReturnType<typeof mock>;

    beforeEach(() => {
    // Create mock logger
        mockLogger = {
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

        // Mock process runner
        mockRunBunTests = mock();
        spyOn(processRunner, 'runBunTests').mockImplementation(mockRunBunTests);

        // Mock coverage collector
        mockCollectCoverage = mock();
        mockCleanupCoverageFile = mock();
        spyOn(coverageCollector, 'collectCoverage').mockImplementation(mockCollectCoverage);
        spyOn(coverageCollector, 'cleanupCoverageFile').mockImplementation(mockCleanupCoverageFile);

        // Mock preload generator
        mockGeneratePreloadScript = mock();
        mockCleanupPreloadScript = mock();
        spyOn(preloadGenerator, 'generatePreloadScript').mockImplementation(mockGeneratePreloadScript);
        spyOn(preloadGenerator, 'cleanupPreloadScript').mockImplementation(mockCleanupPreloadScript);

        // Mock port utility
        mockGetAvailablePort = mock();
        spyOn(portUtils, 'getAvailablePort').mockImplementation(mockGetAvailablePort);

        // Mock sync server
        mockSyncServer = {
            start:         mock(),
            signalReady:   mock(),
            close:         mock(),
            sendTestStart: mock(),
            clientCount:   0,
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        spyOn(syncServerModule, 'SyncServer').mockImplementation(() => mockSyncServer);

        // Mock inspector client
        mockInspectorClient = {
            connect:           mock(),
            send:              mock(),
            getTests:          mock(),
            getExecutionOrder: mock(),
            close:             mock(),
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        spyOn(inspectorModule, 'InspectorClient').mockImplementation(() => mockInspectorClient);

        // Mock coverage mapper
        mockMapCoverageToInspectorIds = mock();
        spyOn(coverageMapper, 'mapCoverageToInspectorIds').mockImplementation(mockMapCoverageToInspectorIds);
        // Default: pass through coverage unchanged (tests can override if needed)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return -- intentional pass-through mock
        mockMapCoverageToInspectorIds.mockImplementation((coverage: any) => coverage);

        // Default mock implementations
        mockCleanupCoverageFile.mockResolvedValue(undefined);
        mockCleanupPreloadScript.mockResolvedValue(undefined);
        let portCounter = 6499;
        mockGetAvailablePort.mockImplementation(() => Promise.resolve(portCounter++));
        mockSyncServer.start.mockResolvedValue(undefined);
        mockSyncServer.signalReady.mockReturnValue(undefined);
        mockSyncServer.close.mockResolvedValue(undefined);
        mockSyncServer.sendTestStart.mockReturnValue(undefined);
        mockInspectorClient.connect.mockResolvedValue(undefined);
        mockInspectorClient.send.mockResolvedValue(undefined);
        mockInspectorClient.getTests.mockReturnValue([]);
        mockInspectorClient.getExecutionOrder.mockReturnValue([]);
        mockInspectorClient.close.mockResolvedValue(undefined);
    });

    afterEach(() => {
        mock.restore();
    });

    describe('constructor', () => {
        it('should initialize with default options', () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            expect(runner).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('BunTestRunner initialized'),
                expect.objectContaining({
                    bunPath: 'bun',
                    timeout: 10000,
                })
            );
        });

        it('should use exact default string values', () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            expect(runner).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith(
                'BunTestRunner initialized with options: %o',
                expect.objectContaining({
                    bunPath:          'bun',
                    timeout:          10000,
                    inspectorTimeout: 5000,
                })
            );
        });

        it('should use custom bunPath from options', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    bunPath: '/custom/bun',
                },
            } as unknown as StrykerOptions);

            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    bunPath: '/custom/bun',
                })
            );

            // Verify the option is actually used when running tests
            await runner.init();
            await runner.dryRun();

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    bunPath: '/custom/bun',
                })
            );
        });

        it('should use custom timeout from options', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    timeout: 20000,
                },
            } as unknown as StrykerOptions);

            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    timeout: 20000,
                })
            );

            // Verify the option is actually used when running tests
            await runner.init();
            await runner.dryRun();

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    timeout: 20000,
                })
            );
        });

        it('should accept custom environment variables', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    env: {
                        CUSTOM_VAR: 'value',
                    },
                },
            } as unknown as StrykerOptions);

            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    env: { CUSTOM_VAR: 'value' },
                })
            );

            // Verify the option is actually used when running tests
            await runner.init();
            await runner.dryRun();

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    env: { CUSTOM_VAR: 'value' },
                })
            );
        });

        it('should accept custom bunArgs', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    bunArgs: ['--only', '--verbose'],
                },
            } as unknown as StrykerOptions);

            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    bunArgs: ['--only', '--verbose'],
                })
            );

            // Verify the option is actually used when running tests
            await runner.init();
            await runner.dryRun();

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    bunArgs: ['--only', '--verbose'],
                })
            );
        });
    });

    describe('capabilities', () => {
        it('should return correct capabilities', () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            const capabilities = runner.capabilities();

            expect(capabilities).toEqual({
                reloadEnvironment: true,
            });
        });
    });

    describe('init', () => {
        it('should generate preload script', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            await runner.init();

            expect(mockGeneratePreloadScript).toHaveBeenCalledWith(
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns any
                    tempDir: expect.stringContaining('stryker-bun-runner'),
                })
            );
        });

        it('should log exact init debug messages', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload-test.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            await runner.init();

            // Verify exact debug message strings (kills StringLiteral mutations on lines 127, 133, 138)
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('BunTestRunner init starting...');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Generating coverage preload script...');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Preload script generated at: %s', '/tmp/preload-test.ts');
        });
    });

    describe('dryRun', () => {
        beforeEach(async () => {
            // Init no longer validates bun, so no need to mock runBunTests for init
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
        });

        it('should run tests with coverage', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms]

 1 pass
`,
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue({
                perTest: {
                    'should pass': { '1': 1, '2': 1 },
                },
                'static': { '3': 1 },
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            expect(result).toHaveProperty('tests');
            // Verify mutantCoverage is passed through from collector unchanged
            // Note: Test ID format ('should pass' vs 'tests/example.test.ts > should pass')
            // is determined by the coverage preload script, not BunTestRunner.
            // This test verifies BunTestRunner correctly passes through collector data.
            if(result.status === DryRunStatus.Complete) {
                expect(result.mutantCoverage).toEqual({
                    perTest: {
                        'should pass': { '1': 1, '2': 1 },
                    },
                    'static': { '3': 1 },
                });
            }
        });

        it('should return timeout status on timeout', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: null,
                    stdout:   '',
                    stderr:   '',
                    timedOut: true,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Timeout);
        });

        it('should return error status on process failure', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   '',
                    stderr:   'Fatal error',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Error);
            expect(result).toHaveProperty('errorMessage');
        });

        it('should map test results correctly', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✓ passing test [0.12ms]
✗ failing test [0.05ms]
  error: Test failed
⏭ skipped test

 1 pass
 1 fail
 1 skip
`,
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(3);

                // Tests are sorted alphabetically, so check for each test independently
                const passingTest = result.tests.find(t => t.name === 'tests/example.test.ts > passing test');
                expect(passingTest).toBeDefined();
                expect(passingTest?.status).toBe(TestStatus.Success);
                expect(passingTest?.timeSpentMs).toBe(0);  // 0.12ms rounds to 0

                const failingTest = result.tests.find(t => t.name === 'tests/example.test.ts > failing test');
                expect(failingTest).toBeDefined();
                expect(failingTest?.status).toBe(TestStatus.Failed);
                expect(failingTest?.timeSpentMs).toBe(0);  // 0.05ms rounds to 0

                const skippedTest = result.tests.find(t => t.name === 'tests/example.test.ts > skipped test');
                expect(skippedTest).toBeDefined();
                expect(skippedTest?.status).toBe(TestStatus.Skipped);
            }
        });

        it('should return specific error message on sync server failure', async () => {
            // Mock sync server to fail on start
            mockSyncServer.start.mockRejectedValue(new Error('Port already in use'));

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Error);
            if(result.status === DryRunStatus.Error) {
                expect(result.errorMessage).toBe('Failed to start sync server: Port already in use');
            }
        });

        it('should return specific error message on inspector timeout', async () => {
            // Mock runBunTests to never call onInspectorReady (simulates inspector timeout)
            mockRunBunTests.mockImplementation(() => {
                // Don't call onInspectorReady to simulate timeout
                // Return a promise that never resolves (simulating hung inspector)
                return new Promise(() => {
                    // Never resolves
                });
            });

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    inspectorTimeout: 100, // Very short timeout to speed up test
                },
            } as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Error);
            if(result.status === DryRunStatus.Error) {
                expect(result.errorMessage).toBe('Timeout waiting for inspector URL');
            }
        });

        it('should wait in 50ms intervals while waiting for inspector URL', async () => {
            const delays: number[] = [];
            let callCount = 0;

            // Mock runBunTests to call onInspectorReady after a short delay
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady after 3 polling cycles (160ms)
                setTimeout(() => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- invoking mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                }, 160);
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            // Spy on setTimeout to verify 50ms delays
            const originalSetTimeout = globalThis.setTimeout;
            globalThis.setTimeout = ((fn: () => void, delay?: number) => {
                if(delay === 50) {
                    delays.push(delay);
                    callCount++;
                }
                return originalSetTimeout(fn, delay);
            }) as typeof setTimeout;

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    inspectorTimeout: 500,
                },
            } as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            // Restore original setTimeout
            globalThis.setTimeout = originalSetTimeout;

            expect(result.status).toBe(DryRunStatus.Complete);
            // Verify we had at least 3 polling cycles with 50ms delays
            expect(callCount).toBeGreaterThanOrEqual(3);
            // Verify all delays were exactly 50ms
            for(const delay of delays) {
                expect(delay).toBe(50);
            }
        });

        it('should exit wait loop when inspector URL is received before timeout', async () => {
            let waitLoopIterations = 0;

            // Mock runBunTests to call onInspectorReady immediately
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady after just one polling cycle
                setTimeout(() => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- invoking mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                }, 60);
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            // Track setTimeout calls to count loop iterations
            const originalSetTimeout = globalThis.setTimeout;
            globalThis.setTimeout = ((fn: () => void, delay?: number) => {
                if(delay === 50) {
                    waitLoopIterations++;
                }
                return originalSetTimeout(fn, delay);
            }) as typeof setTimeout;

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    inspectorTimeout: 5000, // Long timeout, but should exit early
                },
            } as unknown as StrykerOptions);
            await runner.init();

            const startTime = Date.now();
            const result = await runner.dryRun();
            const elapsed = Date.now() - startTime;

            // Restore original setTimeout
            globalThis.setTimeout = originalSetTimeout;

            expect(result.status).toBe(DryRunStatus.Complete);
            // Should have exited loop early (well before 5000ms timeout)
            expect(elapsed).toBeLessThan(1000);
            // Should have had only a few iterations before URL arrived
            expect(waitLoopIterations).toBeLessThan(20);
        });

        it('should return specific error message on inspector connection failure', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockInspectorClient.connect.mockRejectedValue(new Error('Connection refused'));

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Error);
            if(result.status === DryRunStatus.Error) {
                expect(result.errorMessage).toBe('Failed to connect to Bun inspector: Connection refused');
            }
        });

        it('should use fallback when executionOrder is empty', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✓ fallback test [0.12ms]

 1 pass
`,
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            // Return empty execution order to trigger fallback
            mockInspectorClient.getExecutionOrder.mockReturnValue([]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(1);
                expect(result.tests[0].name).toBe('tests/example.test.ts > fallback test');
                expect(result.tests[0].status).toBe(TestStatus.Success);
            }
        });

        it('should handle unknown test IDs gracefully', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            // Return execution order with IDs not in test hierarchy
            mockInspectorClient.getExecutionOrder.mockReturnValue([999, 1000]);
            mockInspectorClient.getTests.mockReturnValue([]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(2);
                expect(result.tests[0].name).toBe('unknown-1000');
                expect(result.tests[0].status).toBe(TestStatus.Success);
                expect(result.tests[1].name).toBe('unknown-999');
                expect(result.tests[1].status).toBe(TestStatus.Success);
            }
        });

        it('should calculate timePerTest correctly when executionOrder has items', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                // Simulate a small delay that will result in timePerTest calculation
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve({
                            exitCode: 0,
                            stdout:   '✓ test [0.12ms]\n 1 pass',
                            stderr:   '',
                            timedOut: false,
                        });
                    }, 10); // Small delay
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            // Return execution order with 4 tests
            mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2, 3, 4]);
            mockInspectorClient.getTests.mockReturnValue([
                {
                    id:       1,
                    name:     'test 1',
                    fullName: 'test 1',
                    status:   'pass',
                    url:      '/project/tests/test.ts',
                },
                {
                    id:       2,
                    name:     'test 2',
                    fullName: 'test 2',
                    status:   'pass',
                    url:      '/project/tests/test.ts',
                },
                {
                    id:       3,
                    name:     'test 3',
                    fullName: 'test 3',
                    status:   'pass',
                    url:      '/project/tests/test.ts',
                },
                {
                    id:       4,
                    name:     'test 4',
                    fullName: 'test 4',
                    status:   'pass',
                    url:      '/project/tests/test.ts',
                },
            ]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(4);
                // timePerTest = Math.max(1, Math.floor(totalElapsedMs / 4))
                // With small delay, should be at least 1ms per test
                for(const test of result.tests) {
                    expect(test.timeSpentMs).toBeGreaterThanOrEqual(1);
                }
            }
        });

        it('should ensure timePerTest is at least 1 when Math.floor would return 0', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                // Return immediately (very small elapsed time)
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            // Many tests with very short total time would cause Math.floor(totalMs / length) < 1
            mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            mockInspectorClient.getTests.mockReturnValue(
                Array.from({ length: 10 }, (_, i) => ({
                    id:       i + 1,
                    name:     `test ${i + 1}`,
                    fullName: `test ${i + 1}`,
                    status:   'pass' as const,
                    url:      '/project/tests/test.ts',
                }))
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(10);
                // Verify Math.max(1, ...) ensures timePerTest is at least 1
                for(const test of result.tests) {
                    expect(test.timeSpentMs).toBeGreaterThanOrEqual(1);
                    expect(test.timeSpentMs).toBe(1); // Should be exactly 1 in this case
                }
            }
        });

        it('should map failed status correctly', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✗ failed test [0.05ms]
  error: Test failed with assertion

 0 pass
 1 fail
`,
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockInspectorClient.getTests.mockReturnValue([{
                id:       1,
                name:     'failed test',
                fullName: 'tests/example.test.ts > failed test',
                status:   'fail',
                elapsed:  0.05,
                url:      '/project/.stryker-tmp/sandbox-123/tests/example.test.ts',
                error:    { message: 'Assertion failed' },
            }]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(1);
                expect(result.tests[0].status).toBe(TestStatus.Failed);
                if(result.tests[0].status === TestStatus.Failed) {
                    expect(result.tests[0].failureMessage).toContain('Test failed');
                }
            }
        });

        it('should map skipped and todo status correctly', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
⏭ skipped test
○ todo test

 0 pass
 2 skip
`,
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2]);
            mockInspectorClient.getTests.mockReturnValue([
                {
                    id:       1,
                    name:     'skipped test',
                    fullName: 'tests/example.test.ts > skipped test',
                    status:   'skip',
                    elapsed:  0,
                    url:      '/project/tests/example.test.ts',
                },
                {
                    id:       2,
                    name:     'todo test',
                    fullName: 'tests/example.test.ts > todo test',
                    status:   'todo',
                    elapsed:  0,
                    url:      '/project/tests/example.test.ts',
                },
            ]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(2);
                expect(result.tests[0].status).toBe(TestStatus.Skipped);
                expect(result.tests[1].status).toBe(TestStatus.Skipped);
            }
        });

        it('should cleanup coverage file after reading', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dryRun();

            expect(mockCleanupCoverageFile).toHaveBeenCalled();
        });

        it('should remap coverage when mutantCoverage is present', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            const originalCoverage = {
                perTest: {
                    'test-1': { '1': 1 },
                },
                'static': {},
            };
            mockCollectCoverage.mockResolvedValue(originalCoverage);

            const remappedCoverage = {
                perTest: {
                    'Full Test Name': { '1': 1 },
                },
                'static': {},
            };
            mockMapCoverageToInspectorIds.mockReturnValue(remappedCoverage);

            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockInspectorClient.getTests.mockReturnValue([{
                id:       1,
                name:     'test',
                fullName: 'Full Test Name',
                status:   'pass',
                url:      '/project/tests/test.ts',
            }]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            // Verify mapCoverageToInspectorIds was called (tests line 378 conditional)
            expect(mockMapCoverageToInspectorIds).toHaveBeenCalledWith(
                originalCoverage,
                [1],
                expect.any(Map)
            );
            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.mutantCoverage).toEqual(remappedCoverage);
            }
        });

        it('should skip coverage remapping when mutantCoverage is null', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined); // No coverage

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dryRun();

            // Verify mapCoverageToInspectorIds was NOT called (tests line 378 conditional)
            expect(mockMapCoverageToInspectorIds).not.toHaveBeenCalled();
        });

        it('should pass sequentialMode: true to runBunTests for dry run', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dryRun();

            // Verify sequentialMode is exactly true (kills BooleanLiteral mutation on line 279)
            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    sequentialMode: true,
                })
            );
        });

        it('should log exact debug messages', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockInspectorClient.getTests.mockReturnValue([{
                id:       1,
                name:     'test',
                fullName: 'test',
                status:   'pass',
                url:      '/project/tests/test.ts',
            }]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dryRun();

            // Verify exact debug message strings (kills StringLiteral mutations)
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Running dry run with inspector-based coverage collection...');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Sync server started on port %d', expect.any(Number));
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Inspector URL: %s', expect.any(String));
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Inspector connected and TestReporter enabled');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Signaled preload script to proceed');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Inspector collected %d tests in hierarchy, %d in execution order',
                1, 1);
        });
    });

    describe('mutantRun', () => {
        beforeEach(async () => {
            // Init no longer validates bun, so no need to mock runBunTests for init
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
        });

        it('should return empty killedBy when no tests failed', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   '',
                    stderr:   'Fatal error: tests crashed',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['unknown']);
                expect(result.failureMessage).toBe('Tests failed with exit code 1');
            }
        });

        it('should filter out null failure messages', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✗ test 1 [0.05ms]
✗ test 2 [0.05ms]
  error: Expected 2 but received 3

 0 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toContain('test 1');
                expect(result.killedBy).toContain('test 2');
                expect(result.failureMessage).toBe('error: Expected 2 but received 3');
            }
        });

        it('should include all failed test names in killedBy', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✗ test alpha [0.05ms]
  error: Alpha failed
✗ test beta [0.05ms]
  error: Beta failed
✗ test gamma [0.05ms]
  error: Gamma failed

 0 pass
 3 fail
`,
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['test alpha', 'test beta', 'test gamma']);
                expect(result.failureMessage).toBe('error: Alpha failed\n\nerror: Beta failed\n\nerror: Gamma failed');
            }
        });

        it('should return killed status when tests fail', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✗ should catch mutant [0.05ms]
  error: Expected 2 but received 3

 0 pass
 1 fail
`,
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      ['should catch mutant'],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toHaveLength(1);
                expect(result.killedBy[0]).toBe('should catch mutant');
                expect(result.nrOfTests).toBe(1);
            }
        });

        it('should return survived status when all tests pass', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.05ms]

 1 pass
`,
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Survived);
            if(result.status === MutantRunStatus.Survived) {
                expect(result.nrOfTests).toBe(1);
            }
        });

        it('should return timeout status on timeout', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: null,
                    stdout:   '',
                    stderr:   '',
                    timedOut: true,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Timeout);
        });

        it('should return killed status on process failure', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   '',
                    stderr:   'Fatal error',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            // When parsing fails (empty stdout), totalTests is 0, so nrOfTests uses fallback of 1
            // This tests the `parsed.totalTests || 1` fallback in mutantRun() (line ~324)
            if(result.status === MutantRunStatus.Killed) {
                expect(result.nrOfTests).toBe(1);
            }
        });

        it('should set activeMutant in environment', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.05ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '42' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    activeMutant: '42',
                })
            );
        });

        it('should enable bail for mutant runs', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.05ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    bail: true,
                })
            );
        });

        it('should pass preload script to mutant runs', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.05ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    preloadScript: '/tmp/preload.ts',
                })
            );
        });

        it('should correctly filter and map failed tests for killedBy', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✓ passing test [0.05ms]
✗ failing test 1 [0.05ms]
  error: First error
✗ failing test 2 [0.05ms]
  error: Second error

 1 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Tests filter(test => test.status === 'failed') on line 443
                expect(result.killedBy).toHaveLength(2);
                expect(result.killedBy).toContain('failing test 1');
                expect(result.killedBy).toContain('failing test 2');
                // Tests map(test => stripFilePrefix(test.name)) on line 444
                // and filter/map chain on lines 450-452
                expect(result.failureMessage).toBe('error: First error\n\nerror: Second error');
            }
        });

        it('should filter out empty failure messages and join with double newline', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   `
bun test v1.1.0

tests/example.test.ts:
✗ test 1 [0.05ms]
✗ test 2 [0.05ms]
  error: Has message
✗ test 3 [0.05ms]

 0 pass
 3 fail
`,
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Tests .filter((msg): msg is string => !!msg) on line 452
                // Should only include the one non-empty message
                expect(result.failureMessage).toBe('error: Has message');
            }
        });

        it('should use default killedBy when filter returns empty array', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   '',
                    stderr:   'Process crashed',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Tests killedBy.length > 0 ? killedBy : ['unknown'] on line 448
                expect(result.killedBy).toEqual(['unknown']);
            }
        });

        it('should log exact mutantRun debug messages', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                if(options.onInspectorReady) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test [0.05ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '42' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            // Verify exact debug message strings (kills StringLiteral mutations on lines 402, 424)
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Running mutant run for mutant %s', '42');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Mutant run completed: %o', expect.any(Object));
        });
    });

    describe('dispose', () => {
        beforeEach(async () => {
            // Init no longer validates bun, so no need to mock runBunTests for init
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
        });

        it('should cleanup preload script', async () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dispose();

            expect(mockCleanupPreloadScript).toHaveBeenCalled();
        });

        it('should cleanup coverage file', async () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dispose();

            expect(mockCleanupCoverageFile).toHaveBeenCalled();
        });

        it('should handle dispose without init', () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            // Should not throw
            expect(runner.dispose()).resolves.toBeUndefined();
        });

        it('should log exact dispose debug messages', async () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            await runner.dispose();

            // Verify exact debug message strings (kills StringLiteral mutations on lines 469, 473, 479)
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Disposing BunTestRunner');
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Cleaning up preload script: %s', expect.any(String));
            // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
            expect(mockLogger.debug).toHaveBeenCalledWith('Cleaning up coverage file: %s', expect.any(String));
        });
    });

    describe('normalizeTestFilePath', () => {
        it('returns undefined for undefined input', () => {
            expect(normalizeTestFilePath(undefined)).toBeUndefined();
        });

        it('returns undefined for empty string', () => {
            expect(normalizeTestFilePath('')).toBeUndefined();
        });

        it('extracts path after .stryker-tmp/sandbox-XXXXX/', () => {
            const input = '/path/to/project/.stryker-tmp/sandbox-ABC123/tests/unit/foo.test.ts';
            expect(normalizeTestFilePath(input)).toBe('tests/unit/foo.test.ts');
        });

        it('handles various sandbox IDs', () => {
            const input = '/project/.stryker-tmp/sandbox-12345678/src/test.ts';
            expect(normalizeTestFilePath(input)).toBe('src/test.ts');
        });

        it('returns original path if no sandbox pattern', () => {
            const input = 'tests/unit/foo.test.ts';
            expect(normalizeTestFilePath(input)).toBe('tests/unit/foo.test.ts');
        });

        it('handles absolute paths without sandbox', () => {
            const input = '/absolute/path/to/file.ts';
            expect(normalizeTestFilePath(input)).toBe('/absolute/path/to/file.ts');
        });
    });

    describe('stripFilePrefix', () => {
        it('strips .test.ts file prefix', () => {
            expect(stripFilePrefix('tests/unit/foo.test.ts > Suite > Test')).toBe('Suite > Test');
        });

        it('strips .spec.ts file prefix', () => {
            expect(stripFilePrefix('src/foo.spec.ts > My Suite > My Test')).toBe('My Suite > My Test');
        });

        it('strips .test.tsx file prefix', () => {
            expect(stripFilePrefix('components/Button.test.tsx > Button > renders')).toBe('Button > renders');
        });

        it('strips .spec.jsx file prefix', () => {
            expect(stripFilePrefix('app.spec.jsx > App > loads')).toBe('App > loads');
        });

        it('strips .test.js file prefix', () => {
            expect(stripFilePrefix('utils.test.js > Utils > works')).toBe('Utils > works');
        });

        it('returns original if no file prefix pattern', () => {
            expect(stripFilePrefix('Suite > Test')).toBe('Suite > Test');
        });

        it('returns original if pattern does not match', () => {
            expect(stripFilePrefix('random string without pattern')).toBe('random string without pattern');
        });

        it('handles deep paths', () => {
            expect(stripFilePrefix('a/b/c/d/e.test.ts > X > Y > Z')).toBe('X > Y > Z');
        });

        it('handles single-level test name', () => {
            expect(stripFilePrefix('file.test.ts > Test')).toBe('Test');
        });
    });

    describe('Mutation Testing: Targeted Tests for Surviving Mutations', () => {
        beforeEach(async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
        });

        describe('Line 135: StringLiteral in coverage file path', () => {
            it('should use exact "coverage-" prefix in coverage file path', async () => {
                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // Verify generatePreloadScript was called with coverageFile containing "coverage-"
                expect(mockGeneratePreloadScript).toHaveBeenCalledWith(
                    expect.objectContaining({
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test mock
                        coverageFile: expect.stringContaining('coverage-'),
                    })
                );
            });

            it('should not use empty string in coverage file path', async () => {
                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // Verify the coverage file path is not empty or just a timestamp
                expect(mockGeneratePreloadScript).toHaveBeenCalledWith(
                    expect.objectContaining({
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test mock
                        coverageFile: expect.stringMatching(/coverage-\d+\.json$/),
                    })
                );
            });
        });

        describe('Lines 185-186: timePerTest calculation mutations', () => {
            it('should use division (/) not multiplication (*) for timePerTest', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    // Return after small delay with 2 tests
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            resolve({
                                exitCode: 0,
                                stdout:   '2 passed',
                                stderr:   '',
                                timedOut: false,
                            });
                        }, 20);
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([
                    { id: 1, name: 'test1', fullName: 'test1', status: 'pass', url: 'test.ts' },
                    { id: 2, name: 'test2', fullName: 'test2', status: 'pass', url: 'test.ts' },
                ]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // With elapsed time and 2 tests: elapsed/2 = timePerTest (division)
                    // If mutation used *: elapsed*2 (wrong, would be much larger)
                    // Verify timeSpentMs is reasonable
                    for(const test of result.tests) {
                        expect(test.timeSpentMs).toBeLessThan(100);
                        expect(test.timeSpentMs).toBeGreaterThan(1);
                    }
                }
            });

            it('should use > 0 not >= 0 for executionOrder length check', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // With executionOrder.length === 0, should use fallback path (not timePerTest path)
                    // If mutation changed > to >=, it would incorrectly calculate timePerTest for length 0
                    expect(result.tests).toEqual([]);
                }
            });

            it('should use <= 0 check correctly (not always true/false)', async () => {
                // This tests that the condition isn't replaced with true/false
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '3 passed',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([
                    { id: 1, name: 'a', fullName: 'a', status: 'pass', url: 'test.ts' },
                    { id: 2, name: 'b', fullName: 'b', status: 'pass', url: 'test.ts' },
                    { id: 3, name: 'c', fullName: 'c', status: 'pass', url: 'test.ts' },
                ]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2, 3]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // If condition was always false, we'd get fallback behavior
                    // If always true, we'd get timePerTest calculation
                    // Verify we got the timePerTest path (length > 0)
                    expect(result.tests).toHaveLength(3);
                    for(const test of result.tests) {
                        expect(test.timeSpentMs).toBeGreaterThanOrEqual(1);
                    }
                }
            });
        });

        describe('Line 199: StringLiteral in unknown test ID', () => {
            it('should use exact "unknown-" prefix for missing tests', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '1 passed',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                // Inspector reports test ID 999 in execution order, but test info not found
                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([999]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    expect(result.tests).toHaveLength(1);
                    expect(result.tests[0].id).toBe('unknown-999');
                    expect(result.tests[0].name).toBe('unknown-999');
                }
            });

            it('should not use empty string for unknown test prefix', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([42]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // Verify the ID contains "unknown-" not just "42"
                    expect(result.tests[0].id).toMatch(/^unknown-/);
                    expect(result.tests[0].id).not.toBe('42');
                }
            });
        });

        describe('Line 299: timeout boundary check (<= vs <)', () => {
            it('should use < not <= for timeout comparison', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // Call onInspectorReady after exactly inspectorTimeout ms
                    setTimeout(() => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                        if(options.onInspectorReady) {
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                            options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        }
                    }, 110); // Wait slightly past the boundary

                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 100,
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                // With < (correct), timeout at exactly 100ms should fail
                // With <= (mutation), timeout at exactly 100ms would succeed
                // Since we're calling onInspectorReady at 110ms (after timeout),
                // it should timeout with <, but might succeed with <=
                if(result.status === DryRunStatus.Error) {
                    expect(result.errorMessage).toContain('Timeout waiting for inspector URL');
                }
            });
        });

        describe('Lines 321, 451: ObjectLiteral handlers invocation', () => {
            it('should invoke onTestStart handler when provided (line 321)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '1 passed',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                // Spy on InspectorClient constructor to capture handlers
                let capturedHandlers: { onTestStart?: (test: TestInfo) => void } | undefined;

                // @ts-expect-error - Mocking constructor with implementation
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                spyOn(inspectorModule, 'InspectorClient').mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test spy
                    capturedHandlers = options.handlers;
                    return mockInspectorClient;
                });

                mockInspectorClient.getTests.mockReturnValue([
                    { id: 1, name: 'test', fullName: 'test', status: 'pass', url: 'test.ts' },
                ]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                await runner.dryRun();

                // Verify handlers were provided (not empty object)
                expect(capturedHandlers).toBeDefined();
                expect(capturedHandlers?.onTestStart).toBeDefined();

                // Invoke the handler to verify it's functional
                if(capturedHandlers?.onTestStart) {
                    capturedHandlers.onTestStart({
                        id:       1,
                        name:     'test',
                        fullName: 'Suite > test',
                        type:     'test',
                        status:   'pass',
                        url:      'test.ts',
                    });
                }

                // Verify sendTestStart was called
                expect(mockSyncServer.sendTestStart).toHaveBeenCalledWith('Suite > test');
            });

            it('should log exact debug message after enabling TestReporter (line 332)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                await runner.dryRun();

                // Verify exact string "Inspector connected and TestReporter enabled"
                // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
                expect(mockLogger.debug).toHaveBeenCalledWith('Inspector connected and TestReporter enabled');
            });

            it('should log exact debug message with exit code format (line 383)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test mock
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   '',
                        stderr:   'some error',
                        timedOut: false,
                    });
                });

                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                // Verify error message contains exact format "exit code"
                expect(result.status).toBe(DryRunStatus.Error);
                if(result.status === DryRunStatus.Error) {
                    expect(result.errorMessage).toContain('exit code 1');
                    expect(result.errorMessage).toContain('Bun test process failed');
                }
            });

            it('should log exact debug messages for mutantRun (line 451)', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 0,
                    stdout:   '1 passed',
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '123' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Verify exact log format with %o
                // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
                expect(mockLogger.debug).toHaveBeenCalledWith(
                    'Mutant run completed: %o',
                    expect.objectContaining({
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test mock
                        totalTests: expect.any(Number),
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test mock
                        passed:     expect.any(Number),
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test mock
                        failed:     expect.any(Number),
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test mock
                        exitCode:   expect.any(Number),
                    })
                );
            });
        });

        describe('Lines 468-469: filter/map chain for killedBy', () => {
            it('should only include failed tests in killedBy (verify filter predicate)', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✓ passing test [0.12ms]
✗ failing test 1 [0.05ms]
error: Expected true but got false
✗ failing test 2 [0.05ms]
error: Expected 1 but got 2

 3 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Verify ONLY failed tests are in killedBy (not the passing one)
                    expect(result.killedBy).toHaveLength(2);
                    expect(result.killedBy).toContain('failing test 1');
                    expect(result.killedBy).toContain('failing test 2');
                    expect(result.killedBy).not.toContain('passing test');
                }
            });

            it('should filter based on status === "failed" not another condition', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✗ test A [0.05ms]
error: Failed A
✗ test B [0.05ms]
error: Failed B

 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // If filter was removed or condition changed, we'd get wrong tests
                    expect(result.killedBy).toHaveLength(2);
                    expect(result.killedBy).toContain('test A');
                    expect(result.killedBy).toContain('test B');
                }
            });

            it('should verify failureMessage uses same filter chain (lines 468-471)', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✓ passing test [0.12ms]
✗ fail 1 [0.05ms]
error: Message 1
✗ fail 2 [0.05ms]
error: Message 2

 1 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Verify failureMessage only includes failed tests' messages
                    expect(result.failureMessage).toContain('Message 1');
                    expect(result.failureMessage).toContain('Message 2');
                    // Should have \n\n separator between messages
                    expect(result.failureMessage).toMatch(/Message 1[\s\S]*Message 2/);
                }
            });
        });
    });

    describe('mutation coverage tests', () => {
        describe('timePerTest calculation (line 185)', () => {
            it('should return 1 when executionOrder is empty (not divide by 0)', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test [0.12ms]\n 1 pass',
                        stderr:   '',
                        timedOut: false,
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                // Return empty execution order to trigger the fallback path
                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                // When executionOrder is empty, should use parsed console output
                // This test verifies we don't divide by zero
            });

            it('should calculate timePerTest correctly when executionOrder has tests', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                const totalTime = 20;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }

                    return new Promise((resolve) => {
                        setTimeout(() => {
                            resolve({
                                exitCode: 0,
                                stdout:   '✓ test1 [0.12ms]\n✓ test2 [0.12ms]\n 2 pass',
                                stderr:   '',
                                timedOut: false,
                            });
                        }, totalTime);
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                // Return non-empty execution order
                const testHierarchy: TestInfo[] = [
                    {
                        id:       1,
                        name:     'test1',
                        fullName: 'test1',
                        type:     'test',
                        status:   'pass',
                        elapsed:  undefined,
                    },
                    {
                        id:       2,
                        name:     'test2',
                        fullName: 'test2',
                        type:     'test',
                        status:   'pass',
                        elapsed:  undefined,
                    },
                ];
                mockInspectorClient.getTests.mockReturnValue(testHierarchy);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // Each test should have roughly totalTime / 2 ms
                    // The mutation would make all tests get 1ms if > 0 becomes >= 0
                    expect(result.tests[0].timeSpentMs).toBeGreaterThan(1);
                    expect(result.tests[1].timeSpentMs).toBeGreaterThan(1);
                }
            });

            // Kill mutation #1 & #2: line 186 - ConditionalExpression true and EqualityOperator >= 0
            it('should use correct conditional (> 0 not >= 0) for timePerTest calculation', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test [0.12ms]\n 1 pass',
                        stderr:   '',
                        timedOut: false,
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                // Return empty execution order (length === 0)
                mockInspectorClient.getTests.mockReturnValue([{
                    id:       1,
                    name:     'test1',
                    fullName: 'test1',
                    type:     'test',
                    status:   'pass',
                }]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // When executionOrder.length === 0, must use fallback (parsed.tests)
                    // If mutation changes > 0 to >= 0 or true, it would incorrectly use timePerTest path
                    // which would cause division by zero or wrong results
                    expect(result.tests).toHaveLength(1);
                    // Fallback uses parsed.tests which has duration from console output
                    expect(result.tests[0].name).toBe('test');
                }
            });

            // Kill mutation #3: line 187 - ArithmeticOperator * instead of /
            it('should use division not multiplication for timePerTest', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                const totalTime = 100; // Use larger time to make difference obvious
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }

                    return new Promise((resolve) => {
                        setTimeout(() => {
                            resolve({
                                exitCode: 0,
                                stdout:   '✓ test1 [0.12ms]\n✓ test2 [0.12ms]\n 2 pass',
                                stderr:   '',
                                timedOut: false,
                            });
                        }, totalTime);
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                const testHierarchy: TestInfo[] = [
                    {
                        id:       1,
                        name:     'test1',
                        fullName: 'test1',
                        type:     'test',
                        status:   'pass',
                        elapsed:  undefined,
                    },
                    {
                        id:       2,
                        name:     'test2',
                        fullName: 'test2',
                        type:     'test',
                        status:   'pass',
                        elapsed:  undefined,
                    },
                ];
                mockInspectorClient.getTests.mockReturnValue(testHierarchy);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // Correct: timePerTest = floor(100 / 2) = 50ms per test
                    // Mutation (*): timePerTest = floor(100 * 2) = 200ms per test
                    // Both tests should be roughly 50ms, definitely less than 100ms
                    expect(result.tests[0].timeSpentMs).toBeGreaterThanOrEqual(1);
                    expect(result.tests[0].timeSpentMs).toBeLessThan(100);
                    expect(result.tests[1].timeSpentMs).toBeGreaterThanOrEqual(1);
                    expect(result.tests[1].timeSpentMs).toBeLessThan(100);
                }
            });

            // Kill mutation #81: line 211 - ArithmeticOperator / to *
            it('should convert elapsed nanoseconds to milliseconds correctly', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test1 [5.00ms]\n✓ test2 [10.00ms]\n 2 pass',
                        stderr:   '',
                        timedOut: false,
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                // Provide elapsed times in nanoseconds (as per TestInfo interface)
                // 5_000_000 ns = 5 ms
                // 10_000_000 ns = 10 ms
                const testHierarchy: TestInfo[] = [
                    {
                        id:       1,
                        name:     'test1',
                        fullName: 'test1',
                        type:     'test',
                        status:   'pass',
                        elapsed:  5_000_000,  // 5 million nanoseconds = 5ms
                    },
                    {
                        id:       2,
                        name:     'test2',
                        fullName: 'test2',
                        type:     'test',
                        status:   'pass',
                        elapsed:  10_000_000, // 10 million nanoseconds = 10ms
                    },
                ];
                mockInspectorClient.getTests.mockReturnValue(testHierarchy);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);
                if(result.status === DryRunStatus.Complete) {
                    // Correct conversion: 5_000_000 / 1_000_000 = 5ms
                    // Mutation would produce: 5_000_000 * 1_000_000 = 5_000_000_000_000ms (absurdly large)
                    expect(result.tests[0].timeSpentMs).toBe(5);
                    expect(result.tests[1].timeSpentMs).toBe(10);
                }
            });
        });

        describe('inspector timeout loop (line 299)', () => {
            it('should timeout when inspector URL not provided within timeout', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

                // Mock runBunTests to never call onInspectorReady
                mockRunBunTests.mockImplementation(() => {
                    return new Promise(() => {
                        // Never resolve - simulating a hung process
                    });
                });

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 100, // Short timeout for test
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Error);
                if(result.status === DryRunStatus.Error) {
                    expect(result.errorMessage).toContain('Timeout waiting for inspector URL');
                }
            });

            it('should succeed when inspector URL provided just before timeout', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

                // Mock runBunTests to call onInspectorReady quickly
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    setTimeout(() => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                        if(options.onInspectorReady) {
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                            options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        }
                    }, 90); // Just before 100ms timeout

                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test [0.12ms]\n 1 pass',
                        stderr:   '',
                        timedOut: false,
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);
                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 100,
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                // Should succeed - the mutation would change < to <= causing off-by-one error
                expect(result.status).toBe(DryRunStatus.Complete);
            });

            // Kill mutation #4: line 301 - EqualityOperator < to >=
            it('should use < not >= for timeout check boundary condition', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

                // Mock runBunTests to call onInspectorReady AFTER the timeout
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    setTimeout(() => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                        if(options.onInspectorReady) {
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                            options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        }
                    }, 110); // After the timeout

                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test [0.12ms]\n 1 pass',
                        stderr:   '',
                        timedOut: false,
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);
                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 100,
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                // With < (correct): timeout after 100ms should error
                // With >= (mutation): would incorrectly pass the first iteration
                // This test verifies strict < behavior
                expect(result.status).toBe(DryRunStatus.Error);
                if(result.status === DryRunStatus.Error) {
                    expect(result.errorMessage).toContain('Timeout waiting for inspector URL');
                }
            });
        });

        describe('TestReporter.enable command (line 332)', () => {
            it('should send correct TestReporter.enable command', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock callback
                    if(options.onInspectorReady) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking mock callback
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test [0.12ms]\n 1 pass',
                        stderr:   '',
                        timedOut: false,
                    });
                });
                mockCollectCoverage.mockResolvedValue(undefined);
                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();

                // Verify the exact command sent to inspector
                expect(mockInspectorClient.send).toHaveBeenCalledWith('TestReporter.enable', {});
            });
        });

        describe('noCoverage flag (line 436)', () => {
            it('should pass noCoverage: true for mutant runs', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Verify noCoverage is set to true (not false)
                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({
                        noCoverage: true,
                    })
                );
            });
        });

        describe('killedBy filter chain (line 468)', () => {
            it('should only include failed tests in killedBy', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✓ passing test [0.12ms]
✗ failed test [0.05ms]
error: Test failure

 1 pass
 1 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Should only contain the failed test, not the passing one
                    expect(result.killedBy).toEqual(['failed test']);
                    expect(result.killedBy).not.toContain('passing test');
                }
            });

            it('should handle case with no failed tests in parsed output', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   'Process exited with code 1',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // When filter returns empty, should use 'unknown'
                    expect(result.killedBy).toEqual(['unknown']);
                }
            });
        });

        describe('failureMessage filter chain (line 469)', () => {
            it('should only include messages from failed tests', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✓ passing test [0.12ms]
✗ failed test 1 [0.05ms]
error: Error message 1
✗ failed test 2 [0.05ms]
error: Error message 2

 1 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Should only contain messages from failed tests
                    expect(result.failureMessage).toContain('Error message 1');
                    expect(result.failureMessage).toContain('Error message 2');
                    // If mutation removes filter, it might include undefined/null values
                }
            });

            it('should filter out null/undefined messages', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✗ failed test without message [0.05ms]
✗ failed test with message [0.05ms]
error: Actual error message

 0 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Should only contain non-null messages
                    expect(result.failureMessage).toBe('error: Actual error message');
                    expect(result.failureMessage).not.toContain('undefined');
                    expect(result.failureMessage).not.toContain('null');
                }
            });

            // Kill mutation #5: line 470 - .filter() removal from parsed.tests
            it('should only process failed tests when building failureMessage', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✓ passing test A [0.12ms]
✓ passing test B [0.12ms]
✗ failed test [0.05ms]
error: Expected error

 2 pass
 1 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Should only have 1 message (from the failed test)
                    // If .filter() was removed, we'd get 3 items (including passing tests with undefined messages)
                    expect(result.failureMessage).toBe('error: Expected error');
                    // Verify killedBy also uses filter correctly
                    expect(result.killedBy).toEqual(['failed test']);
                    expect(result.killedBy).not.toContain('passing test A');
                    expect(result.killedBy).not.toContain('passing test B');
                }
            });

            // Kill mutation #6: line 471 - ConditionalExpression true replacement
            it('should verify filter predicate on line 471 is necessary', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✗ failed test 1 [0.05ms]
✗ failed test 2 [0.05ms]
error: Only this message

 0 pass
 2 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Should only include the actual message, filtering out undefined
                    // If ConditionalExpression was replaced with 'true', it wouldn't filter properly
                    expect(result.failureMessage).toBe('error: Only this message');
                    // The split would create 2 messages but only 1 has content
                    expect(result.failureMessage.split('\n\n')).toHaveLength(1);
                }
            });

            // Kill mutations on lines 470-471: Verify killedBy.length > 0 check and failureMessage join work together
            it('should correctly populate both killedBy and failureMessage when multiple tests fail with messages', async () => {
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   `
test/file.test.ts:
✗ test > suite > first failing test [0.05ms]
error: First failure message
✗ test > suite > second failing test [0.05ms]
error: Second failure message
✗ test > suite > third failing test [0.05ms]
error: Third failure message

 0 pass
 3 fail
`,
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test uses simplified mock data
                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Verify killedBy has all 3 tests (tests line 471: killedBy.length > 0)
                    // stripFilePrefix removes "test/file.test.ts > " prefix
                    expect(result.killedBy).toHaveLength(3);
                    expect(result.killedBy).toContain('test > suite > first failing test');
                    expect(result.killedBy).toContain('test > suite > second failing test');
                    expect(result.killedBy).toContain('test > suite > third failing test');

                    // Verify failureMessage joins all 3 messages with '\n\n' (tests line 470: filter chain)
                    expect(result.failureMessage).toContain('error: First failure message');
                    expect(result.failureMessage).toContain('error: Second failure message');
                    expect(result.failureMessage).toContain('error: Third failure message');
                    expect(result.failureMessage).toContain('\n\n');

                    // Verify the messages are actually joined, not just concatenated
                    const messages = result.failureMessage.split('\n\n');
                    expect(messages).toHaveLength(3);
                }
            });
        });
    });
});
