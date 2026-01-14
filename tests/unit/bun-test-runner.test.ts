/**
 * Unit tests for BunTestRunner
 * Integration-level tests for the main TestRunner implementation
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
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

describe('BunTestRunner', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let mockCollectCoverage: ReturnType<typeof mock>;
    let mockCleanupCoverageFile: ReturnType<typeof mock>;
    let mockGeneratePreloadScript: ReturnType<typeof mock>;
    let mockCleanupPreloadScript: ReturnType<typeof mock>;
    let mockGetAvailablePort: ReturnType<typeof mock>;
    let mockSyncServer: {
        start:       ReturnType<typeof mock>
        signalReady: ReturnType<typeof mock>
        close:       ReturnType<typeof mock>
        clientCount: number
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
            start:       mock(),
            signalReady: mock(),
            close:       mock(),
            clientCount: 0,
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
                expect(passingTest?.timeSpentMs).toBe(0.12);

                const failingTest = result.tests.find(t => t.name === 'tests/example.test.ts > failing test');
                expect(failingTest).toBeDefined();
                expect(failingTest?.status).toBe(TestStatus.Failed);
                expect(failingTest?.timeSpentMs).toBe(0.05);

                const skippedTest = result.tests.find(t => t.name === 'tests/example.test.ts > skipped test');
                expect(skippedTest).toBeDefined();
                expect(skippedTest?.status).toBe(TestStatus.Skipped);
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
    });

    describe('mutantRun', () => {
        beforeEach(async () => {
            // Init no longer validates bun, so no need to mock runBunTests for init
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
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
    });
});
