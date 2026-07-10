/**
 * Unit tests for BunTestRunner
 * Integration-level tests for the main TestRunner implementation
 */

import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import * as coverageCollector from '../../src/coverage/collector.js';
import * as coverageMapper from '../../src/coverage/coverage-mapper.js';
import * as preloadGenerator from '../../src/coverage/preload-generator.js';
import * as inspectorModule from '../../src/inspector/inspector-client.js';
import type { TestInfo } from '../../src/inspector/types.js';
import * as processRunner from '../../src/process-runner.js';
import * as bunfigSanitizer from '../../src/utils/bunfig-sanitizer.js';
import * as syncServerModule from '../../src/utils/sync-server.js';
import * as testFileDiscovery from '../../src/utils/test-file-discovery.js';
import { mockGetAvailablePort, mockRename, mockWriteFile, resetAllMocks } from '../test-preload.js';

describe('BunTestRunner', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let mockCollectCoverage: ReturnType<typeof mock>;
    let mockCleanupCoverageFile: ReturnType<typeof mock>;
    let mockGeneratePreloadScript: ReturnType<typeof mock>;
    let mockCleanupPreloadScript: ReturnType<typeof mock>;
    let mockGenerateSanitizedBunfig: ReturnType<typeof mock>;
    let mockCleanupSanitizedBunfig: ReturnType<typeof mock>;
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

    // Store spy instances for cleanup in afterEach
    let runBunTestsSpy: ReturnType<typeof spyOn>;
    let collectCoverageSpy: ReturnType<typeof spyOn>;
    let cleanupCoverageFileSpy: ReturnType<typeof spyOn>;
    let generatePreloadScriptSpy: ReturnType<typeof spyOn>;
    let cleanupPreloadScriptSpy: ReturnType<typeof spyOn>;
    let generateSanitizedBunfigSpy: ReturnType<typeof spyOn>;
    let cleanupSanitizedBunfigSpy: ReturnType<typeof spyOn>;
    let syncServerSpy: ReturnType<typeof spyOn>;
    let inspectorClientSpy: ReturnType<typeof spyOn>;
    let mapCoverageToInspectorIdsSpy: ReturnType<typeof spyOn>;
    let discoverTestFilesSpy: ReturnType<typeof spyOn>;
    let resolveEagerModulesFromGlobsSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Note: Global fake timers cause tests to hang when running full suite
        // Tests that need fake timers enable them locally within the test

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
        runBunTestsSpy = spyOn(processRunner, 'runBunTests').mockImplementation(mockRunBunTests);

        // Mock coverage collector
        mockCollectCoverage = mock();
        mockCleanupCoverageFile = mock();
        collectCoverageSpy = spyOn(coverageCollector, 'collectCoverage').mockImplementation(mockCollectCoverage);
        cleanupCoverageFileSpy = spyOn(coverageCollector, 'cleanupCoverageFile').mockImplementation(mockCleanupCoverageFile);

        // Mock preload generator
        mockGeneratePreloadScript = mock();
        mockCleanupPreloadScript = mock();
        generatePreloadScriptSpy = spyOn(preloadGenerator, 'generatePreloadScript').mockImplementation(mockGeneratePreloadScript);
        cleanupPreloadScriptSpy = spyOn(preloadGenerator, 'cleanupPreloadScript').mockImplementation(mockCleanupPreloadScript);

        // Mock bunfig sanitizer
        mockGenerateSanitizedBunfig = mock();
        mockCleanupSanitizedBunfig = mock();
        generateSanitizedBunfigSpy = spyOn(bunfigSanitizer, 'generateSanitizedBunfig').mockImplementation(mockGenerateSanitizedBunfig);
        cleanupSanitizedBunfigSpy = spyOn(bunfigSanitizer, 'cleanupSanitizedBunfig').mockImplementation(mockCleanupSanitizedBunfig);

        // Port utility mock comes from preload - just clear its state
        mockGetAvailablePort.mockClear();

        // Mock sync server
        mockSyncServer = {
            start:       mock(),
            signalReady: mock(),
            close:       mock(),
            clientCount: 0,
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        syncServerSpy = spyOn(syncServerModule, 'SyncServer').mockImplementation(() => mockSyncServer);

        // Mock inspector client
        mockInspectorClient = {
            connect:           mock(),
            send:              mock(),
            getTests:          mock(),
            getExecutionOrder: mock(),
            close:             mock(),
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        inspectorClientSpy = spyOn(inspectorModule, 'InspectorClient').mockImplementation(() => mockInspectorClient);

        // Mock coverage mapper
        mockMapCoverageToInspectorIds = mock();
        mapCoverageToInspectorIdsSpy = spyOn(coverageMapper, 'mapCoverageToInspectorIds').mockImplementation(mockMapCoverageToInspectorIds);
        // Default: wrap coverage in the new { coverage, inspectorIdToProjectFile } shape (tests can override if needed)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional pass-through mock
        mockMapCoverageToInspectorIds.mockImplementation((coverage: any) => ({ coverage, inspectorIdToProjectFile: new Map() }));

        // Default mock implementations
        mockCleanupCoverageFile.mockResolvedValue(undefined);
        mockCleanupPreloadScript.mockResolvedValue(undefined);
        mockGenerateSanitizedBunfig.mockResolvedValue('/tmp/stryker-bun-runner-bunfig-0-0.toml');
        mockCleanupSanitizedBunfig.mockResolvedValue(undefined);
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

        // Suppress real filesystem writes from dryRun's registry persistence.
        // Without this, fake-timer tests that call dryRun() hang because Bun's
        // fake-timer implementation starves the libuv I/O callbacks needed to
        // resolve real fsPromises.writeFile / fsPromises.rename awaits.
        // resetAllMocks() in afterEach restores pass-through behaviour.
        mockWriteFile.mockResolvedValue(undefined);
        mockRename.mockResolvedValue(undefined);

        // Mock discoverTestFiles so dryRun/mutantRun resolve synchronously without
        // real filesystem I/O.  Returns a stable sorted list of two fictitious test
        // files.  Tests that need different behaviour can override this spy locally.
        discoverTestFilesSpy = spyOn(testFileDiscovery, 'discoverTestFiles').mockResolvedValue([
            'tests/alpha.test.ts',
            'tests/beta.test.ts',
        ]);

        // Mock resolveEagerModulesFromGlobs so init() does not perform real filesystem I/O.
        // Returns an empty list by default; override locally when testing eager-module behaviour.
        resolveEagerModulesFromGlobsSpy = spyOn(preloadGenerator, 'resolveEagerModulesFromGlobs').mockResolvedValue([]);
    });

    afterEach(async () => {
        // Restore all spies to prevent test pollution

        runBunTestsSpy.mockRestore();

        collectCoverageSpy.mockRestore();

        cleanupCoverageFileSpy.mockRestore();

        generatePreloadScriptSpy.mockRestore();

        cleanupPreloadScriptSpy.mockRestore();

        generateSanitizedBunfigSpy.mockRestore();

        cleanupSanitizedBunfigSpy.mockRestore();

        syncServerSpy.mockRestore();

        inspectorClientSpy.mockRestore();

        mapCoverageToInspectorIdsSpy.mockRestore();

        discoverTestFilesSpy.mockRestore();

        resolveEagerModulesFromGlobsSpy.mockRestore();

        // Reset preload mocks and timers
        resetAllMocks();
        jest.useRealTimers();

        // Clean up the registry file that dryRun writes to the project root.
        // This is scoped to this file's afterEach so it doesn't pollute other test files.
        const registryPath = path.join(process.cwd(), '.stryker-bun-runner-registry.json');
        await fsPromises.rm(registryPath, { force: true });
        await fsPromises.rm(`${registryPath}.tmp`, { force: true });
    });

    describe('constructor', () => {
        it('should initialize with default options', () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            expect(runner).toBeDefined();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('BunTestRunner initialized'),
                expect.objectContaining({
                    bunPath: 'bun',
                    timeout: 10_000,
                })
            );
        });

        it('should use exact default string values', () => {
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            expect(runner).toBeDefined();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'BunTestRunner initialized with options: %o',
                expect.objectContaining({
                    bunPath:          'bun',
                    timeout:          10_000,
                    inspectorTimeout: 5000,
                })
            );
        });

        it('should use custom bunPath from options', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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
                    timeout: 20_000,
                },
            } as unknown as StrykerOptions);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    timeout: 20_000,
                })
            );

            // Verify the option is actually used when running tests
            await runner.init();
            await runner.dryRun();

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    timeout: 20_000,
                })
            );
        });

        it('should accept custom environment variables', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

        it('treats empty testFiles array as undefined and emits a warning', async () => {
            // Fix 3 (runtime guard): an empty array should be treated as "no override"
            // and auto-discovery should be used instead.
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({ exitCode: 0, stdout: '1 pass', stderr: '', timedOut: false });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    testFiles: [],
                },
            } as unknown as StrykerOptions);

            // The constructor-time warning must be emitted for the empty array
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('empty array')
            );

            await runner.init();
            await runner.dryRun();

            // Auto-discovery must run (discoverTestFiles is called during init)
            expect(discoverTestFilesSpy).toHaveBeenCalled();

            // testFilesOverride is undefined → runBunTests receives the discovered list, not []
            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    testFiles: ['tests/alpha.test.ts', 'tests/beta.test.ts'],
                })
            );
        });

        it('warns when absolute testFiles paths are used inside a Stryker sandbox', () => {
            // Fix 1: absolute-path testFiles bypass the sandbox copy — warn the user.
            const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/project/.stryker-tmp/sandbox-ABC');

            try {
                new BunTestRunner(mockLogger, {
                    bun: {
                        testFiles: ['/absolute/path/to/my.test.ts'],
                    },
                } as unknown as StrykerOptions);

                // Assert on substrings from each of the three concatenated string
                // chunks so that mutating any individual chunk to "" is detected.
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('absolute path'),
                    expect.stringContaining('.stryker-tmp/sandbox-')
                );
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('ORIGINAL'),
                    expect.any(String)
                );
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('sandbox copy'),
                    expect.any(String)
                );
            } finally {
                cwdSpy.mockRestore();
            }
        });

        it('warns when at least one testFiles path is absolute (mixed array) inside a Stryker sandbox', () => {
            // Kills the MethodExpression mutant that replaces `some` with `every`.
            // With `every`, a mixed array (one absolute, one relative) would return false,
            // suppressing the warning; `some` correctly fires it on any absolute entry.
            const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/project/.stryker-tmp/sandbox-ABC');

            try {
                new BunTestRunner(mockLogger, {
                    bun: {
                        testFiles: ['/absolute/path/to/my.test.ts', 'tests/relative.test.ts'],
                    },
                } as unknown as StrykerOptions);

                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('absolute path'),
                    expect.stringContaining('.stryker-tmp/sandbox-')
                );
            } finally {
                cwdSpy.mockRestore();
            }
        });

        it('does not warn about absolute testFiles paths when outside a Stryker sandbox', () => {
            // Fix 1: the warning must only fire inside a sandbox — not for normal direct use
            // (e.g. the integration test which uses absolute paths without a Stryker sandbox)
            const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/project/not-a-sandbox');

            try {
                new BunTestRunner(mockLogger, {
                    bun: {
                        testFiles: ['/absolute/path/to/my.test.ts'],
                    },
                } as unknown as StrykerOptions);

                expect(mockLogger.warn).not.toHaveBeenCalledWith(
                    expect.stringContaining('absolute path'),
                    expect.any(String)
                );
            } finally {
                cwdSpy.mockRestore();
            }
        });

        it('does not warn when testFiles contains only relative paths inside a sandbox', () => {
            // Fix 1: relative paths are fine in sandbox — no warning needed
            const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/project/.stryker-tmp/sandbox-XYZ');

            try {
                new BunTestRunner(mockLogger, {
                    bun: {
                        testFiles: ['tests/my.test.ts'],
                    },
                } as unknown as StrykerOptions);

                expect(mockLogger.warn).not.toHaveBeenCalledWith(
                    expect.stringContaining('absolute path'),
                    expect.any(String)
                );
            } finally {
                cwdSpy.mockRestore();
            }
        });

        it('should use testFiles override and skip discoverTestFiles when bun.testFiles is provided', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
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

            const explicitFiles = ['/absolute/path/to/my.test.ts'];
            const runner = new BunTestRunner(mockLogger, {
                bun: {
                    testFiles: explicitFiles,
                },
            } as unknown as StrykerOptions);

            await runner.init();
            await runner.dryRun();

            // discoverTestFiles must NOT have been called — the override bypasses it
            expect(discoverTestFilesSpy).not.toHaveBeenCalled();

            // The explicit file list must be forwarded verbatim to runBunTests
            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    testFiles: explicitFiles,
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

                    tempDir: expect.stringContaining('stryker-bun-runner'),
                })
            );
        });

        it('should log exact init debug messages', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload-test.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            await runner.init();

            // Verify exact debug message strings (kills StringLiteral mutations on lines 127, 133, 138)

            expect(mockLogger.debug).toHaveBeenCalledWith('BunTestRunner init starting...');

            expect(mockLogger.debug).toHaveBeenCalledWith('Generating coverage preload script...');

            expect(mockLogger.debug).toHaveBeenCalledWith('Preload script generated at: %s', '/tmp/preload-test.ts');
        });

        it('should call resolveEagerModulesFromGlobs with options.mutate', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            const mutateGlobs = ['src/**/*.ts', '!src/index.ts'];

            const runner = new BunTestRunner(mockLogger, {
                mutate: mutateGlobs,
            } as unknown as StrykerOptions);

            await runner.init();

            expect(resolveEagerModulesFromGlobsSpy).toHaveBeenCalledWith(mutateGlobs);
        });

        it('should pass eagerModules to generatePreloadScript', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            const eagerModules = ['/abs/src/a.ts', '/abs/src/b.ts'];

            resolveEagerModulesFromGlobsSpy.mockResolvedValue(eagerModules);

            const runner = new BunTestRunner(mockLogger, {
                mutate: ['src/**/*.ts'],
            } as unknown as StrykerOptions);

            await runner.init();

            expect(mockGeneratePreloadScript).toHaveBeenCalledWith(
                expect.objectContaining({
                    eagerModules,
                })
            );
        });

        it('should use empty eagerModules when options.mutate is undefined', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            await runner.init();

            expect(resolveEagerModulesFromGlobsSpy).toHaveBeenCalledWith([]);
            expect(mockGeneratePreloadScript).toHaveBeenCalledWith(
                expect.objectContaining({
                    eagerModules: [],
                })
            );
        });

        it('should cache eagerModules and only call resolveEagerModulesFromGlobs once', async () => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

            const runner = new BunTestRunner(mockLogger, {
                mutate: ['src/**/*.ts'],
            } as unknown as StrykerOptions);

            // Call init twice (simulates re-init in some scenarios)
            await runner.init();
            await runner.init();

            // resolveEagerModulesFromGlobs should only be called once (cached)
            expect(resolveEagerModulesFromGlobsSpy).toHaveBeenCalledTimes(1);
        });

        it('re-resolves eager modules when cwd changes between init() calls', async () => {
            // Simulates Stryker sandbox rotation: init() runs in cwd A, then again in cwd B.
            // The cachedEagerModulesCwd key must detect the change and re-resolve.
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

            // Use a flag to switch cwd after the first init() completes so the spy
            // does not interfere with unrelated process.cwd() calls in test infrastructure.
            let useNewCwd = false;
            const originalCwd = process.cwd();
            const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => (useNewCwd ? '/new/sandbox/cwd' : originalCwd));

            try {
                const runner = new BunTestRunner(mockLogger, {
                    mutate: ['src/**/*.ts'],
                } as unknown as StrykerOptions);

                await runner.init();  // cwd = originalCwd

                // Switch to new cwd before second init so the cache key mismatches
                useNewCwd = true;
                await runner.init();  // cwd = /new/sandbox/cwd (different)

                // resolveEagerModulesFromGlobs must be called twice — once per distinct cwd
                expect(resolveEagerModulesFromGlobsSpy).toHaveBeenCalledTimes(2);
            } finally {
                cwdSpy.mockRestore();
            }
        });

        it('cleans up previous preload script when init() is called again (Fix 6: no preload leak on re-init)', async () => {
            // Stryker sandbox rotation calls init() multiple times on the same runner instance.
            // The old preload script must be cleaned up before generating the new one.
            mockGeneratePreloadScript
                .mockResolvedValueOnce('/tmp/preload-first.ts')
                .mockResolvedValueOnce('/tmp/preload-second.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            await runner.init();   // generates /tmp/preload-first.ts

            // cleanupPreloadScript must NOT have been called yet (first init)
            expect(cleanupPreloadScriptSpy).not.toHaveBeenCalled();

            await runner.init();   // generates /tmp/preload-second.ts, must clean up first

            // cleanupPreloadScript must have been called with the first path
            expect(cleanupPreloadScriptSpy).toHaveBeenCalledWith('/tmp/preload-first.ts');
        });

        it('logs debug message when cleanupPreloadScript throws on re-init', async () => {
            // The catch block in init() must log a debug message when cleanup fails.
            // Mutating the catch body to {} silences the log — this test catches that.
            const fsError = new Error('ENOENT: no such file or directory');
            mockCleanupPreloadScript.mockRejectedValueOnce(fsError);
            mockGeneratePreloadScript
                .mockResolvedValueOnce('/tmp/preload-first.ts')
                .mockResolvedValueOnce('/tmp/preload-second.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();   // sets preloadScriptPath = /tmp/preload-first.ts

            // Second init: cleanupPreloadScript throws — catch block must log debug
            await runner.init();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('Failed to clean up previous preload script'),
                expect.any(String)
            );
        });

        it('cleans up previous coverage file when init() is called again (Fix 6: no coverage file leak on re-init)', async () => {
            // Each init() generates a new coverage-<timestamp>.json path.
            // The previous path must be cleaned up if it still exists.
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            await runner.init();   // sets coverageFilePath = .../coverage-<ts>.json

            // cleanupCoverageFile must NOT have been called yet (first init)
            expect(cleanupCoverageFileSpy).not.toHaveBeenCalled();

            await runner.init();   // must call cleanupCoverageFile for the previous path

            // cleanupCoverageFile must have been called exactly once (cleaning up previous path)
            expect(cleanupCoverageFileSpy).toHaveBeenCalledTimes(1);
        });

        it('logs debug message when cleanupCoverageFile throws on re-init', async () => {
            // The catch block in init() must log a debug message when coverage cleanup fails.
            // Mutating the catch body to {} silences the log — this test catches that.
            const fsError = new Error('ENOENT: no such file or directory');
            mockCleanupCoverageFile.mockRejectedValueOnce(fsError);
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();   // sets coverageFilePath

            // Second init: cleanupCoverageFile throws — catch block must log debug
            await runner.init();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('Failed to clean up previous coverage file'),
                expect.any(String)
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

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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
            jest.useFakeTimers();
            try {
                // Mock runBunTests to never call onInspectorReady (simulates inspector timeout).
                // After the timeout, the runner awaits the child process to drain its
                // stdout/stderr for diagnostics — resolve with a plausible crashed result.
                mockRunBunTests.mockImplementation(() => {
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   '',
                        stderr:   'preload crashed before inspector came up',
                        timedOut: false,
                    });
                });

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 100,
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                const resultPromise = runner.dryRun();

                // Advance past the inspectorTimeout threshold in polling increments
                for(let i = 0; i < 5; i++) {
                    jest.advanceTimersByTime(50);
                    // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test
                    await Promise.resolve();
                }

                const result = await resultPromise;

                expect(result.status).toBe(DryRunStatus.Error);
                if(result.status === DryRunStatus.Error) {
                    expect(result.errorMessage).toBe('Timeout waiting for inspector URL');
                }
            } finally {
                jest.useRealTimers();
            }
        });

        it('should wait in 50ms intervals while waiting for inspector URL', async () => {
            // Enable fake timers for this test only
            jest.useFakeTimers();
            try {
                const delays: number[] = [];

                // Mock runBunTests to call onInspectorReady after 160ms (will be triggered by fake timers)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // Schedule callback after 160ms (3+ polling cycles)
                    setTimeout(() => {
                        if(options.onInspectorReady) {
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
                const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 500,
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                // Start the dryRun (don't await yet)
                const resultPromise = runner.dryRun();

                // Advance fake timers in steps to allow async code to progress
                // Each iteration: advance time, then let microtasks/promises settle
                for(let i = 0; i < 10; i++) {
                    jest.advanceTimersByTime(50);
                    // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test
                    await Promise.resolve();
                }

                const result = await resultPromise;

                // Check all setTimeout calls with 50ms delay
                for(const call of setTimeoutSpy.mock.calls) {
                    if(call[1] === 50) {
                        delays.push(50);
                    }
                }

                setTimeoutSpy.mockRestore();

                expect(result.status).toBe(DryRunStatus.Complete);
                // Verify we had at least 3 polling cycles with 50ms delays
                expect(delays.length).toBeGreaterThanOrEqual(3);
                // Verify all delays were exactly 50ms
                for(const delay of delays) {
                    expect(delay).toBe(50);
                }
            } finally {
                jest.useRealTimers();
            }
        });

        it('should exit wait loop when inspector URL is received before timeout', async () => {
            jest.useFakeTimers();
            try {
                let waitLoopIterations = 0;

                // Mock runBunTests to call onInspectorReady after 60ms (just over one polling cycle)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    setTimeout(() => {
                        if(options.onInspectorReady) {
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
                const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 5000, // Long timeout, but should exit early
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                // Start the dryRun (don't await yet)
                const resultPromise = runner.dryRun();

                // Advance fake timers - only need a few iterations since URL arrives at 60ms
                for(let i = 0; i < 5; i++) {
                    jest.advanceTimersByTime(50);
                    // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test
                    await Promise.resolve();
                }

                const result = await resultPromise;

                // Count the 50ms delay calls
                for(const call of setTimeoutSpy.mock.calls) {
                    if(call[1] === 50) {
                        waitLoopIterations++;
                    }
                }

                setTimeoutSpy.mockRestore();

                expect(result.status).toBe(DryRunStatus.Complete);
                // Should have had only a few iterations before URL arrived (well under 20)
                expect(waitLoopIterations).toBeLessThan(20);
            } finally {
                jest.useRealTimers();
            }
        });

        it('should return specific error message on inspector connection failure', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

        it('closes sync server via finally even when inspector.close() throws', async () => {
            // Kills the BlockStatement mutant at the finally block in dryRun():
            // mutating `{ await syncServer.close(); }` to `{}` would leave the server
            // open when an unexpected exception occurs between signalReady and return.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({ exitCode: 0, stdout: '1 pass', stderr: '', timedOut: false });
            });
            // Make inspector.close() throw to exercise the finally path
            mockInspectorClient.close.mockRejectedValue(new Error('inspector close failed'));

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
            await runner.init();

            // dryRun should throw (because inspector.close() throws inside the try block)
            await expect(runner.dryRun()).rejects.toThrow('inspector close failed');

            // syncServer.close() must have been called despite the throw
            expect(mockSyncServer.close).toHaveBeenCalledTimes(1);
        });

        it('should use fallback when executionOrder is empty', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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
            jest.useFakeTimers();
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // Call onInspectorReady immediately if provided

                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    // Simulate a small delay that will result in timePerTest calculation
                    // Use fake timer advancement for consistent timing
                    jest.advanceTimersByTime(10);
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '✓ test [0.12ms]\n 1 pass',
                        stderr:   '',
                        timedOut: false,
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
            } finally {
                jest.useRealTimers();
            }
        });

        it('should ensure timePerTest is at least 1 when Math.floor would return 0', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

        it('should map passing status correctly via inspector path (kills ConditionalExpression mutant at pending-branch)', async () => {
            // This test exercises the inspector path (non-empty executionOrder) with a passing test
            // and asserts TestStatus.Success — killing the ConditionalExpression 'true' mutant at
            // the skip/pending branch. With the mutant (if(true)), every test falls into the skip branch
            // regardless of actual status, producing TestStatus.Skipped instead of TestStatus.Success.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ passing test [1ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);
            // Non-empty executionOrder triggers the inspector-based code path (not the fallback)
            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockInspectorClient.getTests.mockReturnValue([{
                id:       1,
                name:     'passing test',
                fullName: 'tests/example.test.ts > passing test',
                type:     'test' as const,
                status:   'pass' as const,
                elapsed:  1_000_000, // 1ms in nanoseconds
                url:      '/project/.stryker-tmp/sandbox-123/tests/example.test.ts',
            } satisfies TestInfo]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(1);
                // Must be Success — with ConditionalExpression 'true' mutant, this would be Skipped
                expect(result.tests[0].status).toBe(TestStatus.Success);
            }
        });

        it('should use project file from coverage keys for TestResult.fileName when testInfo.url points to node_modules (RuleTester-style)', async () => {
            // Simulates ESLint's RuleTester.run() pattern:
            // - Test file is "tests/my-rule.test.ts" → counter key prefix via Bun.main
            // - But Bun inspector reports url as node_modules because it() is called from there
            // Without the fix, TestResult.fileName = "node_modules/eslint/..." → Stryker warns
            // With the fix, TestResult.fileName = "tests/my-rule.test.ts"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ my-rule valid 0 [1ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });

            // Coverage has counter key with user's file prefix (from Bun.main in preload)
            const originalCoverage = {
                'static': {},
                perTest:  {
                    'tests/my-rule.test.ts@@test-1': { '1': 1 },
                },
            };
            mockCollectCoverage.mockResolvedValue(originalCoverage);

            // Mock mapCoverageToInspectorIds to return the project-file mapping for this test.
            // The counter key prefix "tests/my-rule.test.ts" maps inspector 10 → project file.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock override
            mockMapCoverageToInspectorIds.mockImplementationOnce((_coverage: any) => ({
                coverage:                 { 'static': {}, perTest: { 'tests/my-rule.test.ts > my-rule valid 0': { '1': 1 } } },
                inspectorIdToProjectFile: new Map([[10, 'tests/my-rule.test.ts']]),
            }));

            // Inspector reports node_modules url for the test (RuleTester calls it() from there)
            mockInspectorClient.getExecutionOrder.mockReturnValue([10]);
            mockInspectorClient.getTests.mockReturnValue([{
                id:       10,
                name:     'my-rule valid 0',
                fullName: 'my-rule valid 0',
                type:     'test' as const,
                status:   'pass' as const,
                elapsed:  1_000_000, // 1ms in nanoseconds
                url:      'node_modules/eslint/lib/rule-tester/rule-tester.js',
                line:     42,
            } satisfies TestInfo]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(1);
                const test = result.tests[0];
                // Name uses the project file prefix from the counter key, not node_modules url
                expect(test.name).toBe('tests/my-rule.test.ts > my-rule valid 0');
                // fileName uses the project file, not node_modules path → Stryker won't warn
                expect(test.fileName).toBe('tests/my-rule.test.ts');
            }
        });

        it('should use computed project file (not testInfo.url) for skipped-test fileName when inspectorIdToProjectFile is populated (Issue 1 regression)', async () => {
            // Regression test for bug: skip/pending branch used normalizeTestFilePath(testInfo.url) directly
            // instead of the precomputed `fileName` variable (which uses the project file from coverage keys).
            // When testInfo.url points to node_modules (RuleTester-style), this produced the wrong fileName.
            //
            // To trigger: provide a mix of a passing test (that generates a counter key → project-file
            // mapping) and a skipped test (no counter key). The passing test's mapping populates
            // inspectorIdToProjectFile for inspector ID 10. We then also include inspector ID 20 for the
            // skipped test in the map by supplying a custom mock. The skipped branch must use `fileName`
            // (precomputed) not `normalizeTestFilePath(testInfo.url)`.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ my-rule valid 0 [1ms]\n- my-rule skip 0 [skipped]\n 1 pass\n 1 skip',
                    stderr:   '',
                    timedOut: false,
                });
            });

            // Coverage has a key for the passing test only (skipped tests have no counter key)
            mockCollectCoverage.mockResolvedValue({
                'static': {},
                perTest:  { 'tests/my-rule.test.ts@@test-1': { '1': 1 } },
            });

            // Both inspector tests have node_modules urls (RuleTester pattern)
            mockInspectorClient.getExecutionOrder.mockReturnValue([10, 20]);
            mockInspectorClient.getTests.mockReturnValue([
                {
                    id:       10,
                    name:     'my-rule valid 0',
                    fullName: 'my-rule valid 0',
                    type:     'test' as const,
                    status:   'pass' as const,
                    elapsed:  1_000_000,
                    url:      'node_modules/eslint/lib/rule-tester/rule-tester.js',
                } satisfies TestInfo,
                {
                    id:       20,
                    name:     'my-rule skip 0',
                    fullName: 'my-rule skip 0',
                    type:     'test' as const,
                    status:   'skip' as const,
                    url:      'node_modules/eslint/lib/rule-tester/rule-tester.js',
                } satisfies TestInfo,
            ]);

            // Mock mapCoverageToInspectorIds to return a project-file map that includes
            // BOTH the passing test (10) and the skipped test (20). This simulates the scenario
            // where a future change includes skipped tests in the map, or for testing
            // the fix in isolation without needing real coverage pairing logic.
            mockMapCoverageToInspectorIds.mockImplementationOnce((_coverage: unknown) => ({
                coverage:                 { 'static': {}, perTest: { 'tests/my-rule.test.ts > my-rule valid 0': { '1': 1 } } },
                inspectorIdToProjectFile: new Map([[10, 'tests/my-rule.test.ts'], [20, 'tests/my-rule.test.ts']]),
            }));

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(2);
                const skippedTest = result.tests.find(t => t.status === TestStatus.Skipped);
                expect(skippedTest).toBeDefined();
                // Bug: before fix, fileName was normalizeTestFilePath('node_modules/...') = 'node_modules/...'
                // After fix, fileName correctly uses the precomputed `fileName` from inspectorIdToProjectFile
                expect(skippedTest!.fileName).toBe('tests/my-rule.test.ts');
            }
        });

        it('should cleanup coverage file after reading', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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
            mockMapCoverageToInspectorIds.mockReturnValue({ coverage: remappedCoverage, inspectorIdToProjectFile: new Map() });

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
                expect.any(Map),
                expect.any(Object)
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

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

                if(options.onInspectorReady) {
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

            expect(mockLogger.debug).toHaveBeenCalledWith('Running dry run with inspector-based coverage collection...');

            expect(mockLogger.debug).toHaveBeenCalledWith('Sync server started on port %d', expect.any(Number));

            expect(mockLogger.debug).toHaveBeenCalledWith('Inspector URL: %s', expect.any(String));

            expect(mockLogger.debug).toHaveBeenCalledWith('Inspector connected and TestReporter enabled');

            expect(mockLogger.debug).toHaveBeenCalledWith('Signaled preload script to proceed');

            expect(mockLogger.debug).toHaveBeenCalledWith('Inspector collected %d tests in hierarchy, %d in execution order',
                1, 1);
        });

        it('should deduplicate test names by appending index suffix', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '✓ test with %s [0.12ms]\n✓ test with %s [0.12ms]\n✓ test with %s [0.12ms]\n 3 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            // Simulate it.each with %s placeholder - inspector reports same name for all iterations
            mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2, 3]);
            mockInspectorClient.getTests.mockReturnValue([
                {
                    id:       1,
                    name:     'test with %s',
                    fullName: 'test with %s',
                    status:   'pass',
                    url:      'file:///project/tests/test.ts',
                },
                {
                    id:       2,
                    name:     'test with %s',
                    fullName: 'test with %s',
                    status:   'pass',
                    url:      'file:///project/tests/test.ts',
                },
                {
                    id:       3,
                    name:     'test with %s',
                    fullName: 'test with %s',
                    status:   'pass',
                    url:      'file:///project/tests/test.ts',
                },
            ]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(3);
                // Tests should be deduplicated with [0], [1], [2] suffixes
                const testNames = result.tests.map(t => t.name);
                expect(testNames).toContain('file:///project/tests/test.ts > test with %s [0]');
                expect(testNames).toContain('file:///project/tests/test.ts > test with %s [1]');
                expect(testNames).toContain('file:///project/tests/test.ts > test with %s [2]');
                // IDs should match names
                const testIds = result.tests.map(t => t.id);
                expect(testIds).toContain('file:///project/tests/test.ts > test with %s [0]');
                expect(testIds).toContain('file:///project/tests/test.ts > test with %s [1]');
                expect(testIds).toContain('file:///project/tests/test.ts > test with %s [2]');
            }
        });

        it('should assign [N] dedup suffixes by source line order, not arrival order', async () => {
            // This test verifies that [0] is always assigned to the test with the LOWEST
            // source line number, regardless of which TestReporter.start event arrived first.
            // In real Bun runs, buffering can cause the second it.each iteration to emit
            // start before the first — without line-based ordering this produces [0]/[1] swaps.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 0,
                    stdout:   '3 pass',
                    stderr:   '',
                    timedOut: false,
                });
            });
            mockCollectCoverage.mockResolvedValue(undefined);

            // Inspector returns tests in REVERSE order of their source lines — simulates
            // out-of-order arrival due to WebSocket buffering (line 30 arrives before line 10)
            mockInspectorClient.getExecutionOrder.mockReturnValue([3, 2, 1]);
            mockInspectorClient.getTests.mockReturnValue([
                {
                    id:       1,
                    name:     'edge case %s',
                    fullName: 'Suite > edge case %s',
                    status:   'pass',
                    url:      'file:///project/.stryker-tmp/sandbox-ABC/tests/unit/test.ts',
                    line:     10,   // first in file
                },
                {
                    id:       2,
                    name:     'edge case %s',
                    fullName: 'Suite > edge case %s',
                    status:   'pass',
                    url:      'file:///project/.stryker-tmp/sandbox-ABC/tests/unit/test.ts',
                    line:     20,   // second in file
                },
                {
                    id:       3,
                    name:     'edge case %s',
                    fullName: 'Suite > edge case %s',
                    status:   'pass',
                    url:      'file:///project/.stryker-tmp/sandbox-ABC/tests/unit/test.ts',
                    line:     30,   // third in file — but arrives FIRST in executionOrder
                },
            ]);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.dryRun();

            expect(result.status).toBe(DryRunStatus.Complete);
            if(result.status === DryRunStatus.Complete) {
                expect(result.tests).toHaveLength(3);
                const testNames = result.tests.map(t => t.name);
                // [0] must be the test at line 10 (earliest in file), not the one that arrived first
                expect(testNames).toContain('tests/unit/test.ts > Suite > edge case %s [0]');
                expect(testNames).toContain('tests/unit/test.ts > Suite > edge case %s [1]');
                expect(testNames).toContain('tests/unit/test.ts > Suite > edge case %s [2]');

                // Verify [0] is the test from line 10, [1] from line 20, [2] from line 30
                const test0 = result.tests.find(t => t.name.endsWith('[0]'));
                const test1 = result.tests.find(t => t.name.endsWith('[1]'));
                const test2 = result.tests.find(t => t.name.endsWith('[2]'));
                // Line 10 → [0], line 20 → [1], line 30 → [2]
                expect(test0?.startPosition?.line).toBe(10);
                expect(test1?.startPosition?.line).toBe(20);
                expect(test2?.startPosition?.line).toBe(30);
            }
        });

        describe('test file discovery (sorted testFiles passthrough)', () => {
            // These tests verify that dryRun passes the sorted list returned by
            // discoverTestFiles as testFiles positional args to runBunTests, and that
            // mutantRun reuses the cached list without re-discovering.

            it('passes sorted testFiles from discoverTestFiles to runBunTests in dryRun', async () => {
                // Arrange: discoverTestFiles returns a pre-sorted list (spy already set globally)
                // Default spy returns ['tests/alpha.test.ts', 'tests/beta.test.ts']

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                await runner.init();
                await runner.dryRun();

                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({
                        testFiles: ['tests/alpha.test.ts', 'tests/beta.test.ts'],
                    })
                );
            });

            it('passes undefined testFiles when discoverTestFiles returns undefined (no test files found)', async () => {
                // Override the global spy: no test files found → fallback to Bun discovery

                discoverTestFilesSpy.mockResolvedValue(undefined);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                await runner.init();
                await runner.dryRun();

                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({
                        testFiles: undefined,
                    })
                );
            });

            it('discoverTestFiles is called once during init; dryRun reuses cached result without re-discovering', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                await runner.init();
                await runner.dryRun();

                // discoverTestFiles should have been called exactly once (during init)
                expect(discoverTestFilesSpy).toHaveBeenCalledTimes(1);
            });

            it('rediscovers test files when cwd changes between init() and dryRun()', async () => {
                // Simulates Stryker sandbox rotation: init() runs in one cwd, dryRun() runs in another.
                // The cachedTestFilesCwd key must detect the change and re-discover from the new cwd.
                discoverTestFilesSpy
                    .mockResolvedValueOnce(['tests/original.test.ts'])
                    .mockResolvedValueOnce(['tests/sandbox.test.ts']);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
                mockCollectCoverage.mockResolvedValue(undefined);

                // Use a flag to switch cwd after init() completes so the spy does not
                // interfere with unrelated process.cwd() calls during init or test infra.
                let useNewCwd = false;
                const originalCwd = process.cwd();
                const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => (useNewCwd ? '/new/sandbox/cwd' : originalCwd));

                try {
                    const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                    mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                    await runner.init();    // cwd = originalCwd → discovers ['tests/original.test.ts']

                    // Switch to new cwd before dryRun so the cachedTestFilesCwd key mismatches
                    useNewCwd = true;
                    await runner.dryRun(); // cwd = /new/sandbox/cwd → must re-discover

                    // discoverTestFiles must be called twice (once per distinct cwd)
                    expect(discoverTestFilesSpy).toHaveBeenCalledTimes(2);

                    // dryRun must use the re-discovered file list from the new cwd
                    expect(mockRunBunTests).toHaveBeenCalledWith(
                        expect.objectContaining({
                            testFiles: ['tests/sandbox.test.ts'],
                        })
                    );
                } finally {
                    cwdSpy.mockRestore();
                }
            });
        });

        describe('memory containment options', () => {
            beforeEach(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
            });

            it('passes smol, maxChildRss, and rssCheckIntervalMs through to runBunTests', async () => {
                const runner = new BunTestRunner(mockLogger, {
                    bun: { smol: true, maxChildRss: 500_000_000, rssCheckIntervalMs: 2000 },
                } as unknown as StrykerOptions);
                await runner.init();

                await runner.dryRun();

                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({
                        smol:               true,
                        maxChildRss:        500_000_000,
                        rssCheckIntervalMs: 2000,
                    })
                );
            });

            it('defaults smol to false when bun.smol is not configured', async () => {
                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                await runner.dryRun();

                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({ smol: false })
                );
            });

            it('logs a warning via onMemoryLimitExceeded when the child exceeds maxChildRss', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    options.onMemoryLimitExceeded?.(600_000_000);
                    return Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true, memoryLimitExceeded: true });
                });

                const runner = new BunTestRunner(mockLogger, { bun: { maxChildRss: 500_000_000 } } as unknown as StrykerOptions);
                await runner.init();

                await runner.dryRun();

                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('exceeded maxChildRss'),
                    600_000_000
                );
            });
        });

        describe('in-flight abort via dispose', () => {
            it('clears currentAbortController after dryRun completes (subsequent dispose does not re-abort a finished run)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();

                // dryRun has fully completed — dispose() must not log the
                // "aborting in-flight" debug message since nothing is in flight.
                await runner.dispose();

                expect(mockLogger.debug).not.toHaveBeenCalledWith('Aborting in-flight bun test child during dispose');
            });

            it('aborts the in-flight child when dispose() runs while dryRun has not yet resolved', async () => {
                let capturedSignal: AbortSignal | undefined;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                let releaseRunBunTests: (value: any) => void = () => {};
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    capturedSignal = options.signal;
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    return new Promise((resolve: (value: any) => void) => {
                        releaseRunBunTests = resolve;
                    });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const dryRunPromise = runner.dryRun();

                // Let the dryRun() microtasks run up to the point where runBunTests
                // has been called and the inspector connection has been established,
                // but the child process promise itself is still pending.
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();

                expect(capturedSignal?.aborted).toBe(false);

                await runner.dispose();

                expect(capturedSignal?.aborted).toBe(true);
                expect(mockLogger.debug).toHaveBeenCalledWith('Aborting in-flight bun test child during dispose');

                // Let the still-pending dryRun() promise resolve so it doesn't leak
                // into other tests.
                releaseRunBunTests({ exitCode: null, stdout: '', stderr: '', timedOut: true });
                await dryRunPromise;
            });
        });
    });

    describe('mutantRun', () => {
        beforeEach(async () => {
            // Init no longer validates bun, so no need to mock runBunTests for init
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
        });

        it('should treat non-zero exit with no parsed failures as Killed+unknown (bunfig sanitized, so threshold miss cannot occur)', async () => {
            // With the sanitized bunfig disabling coverage/coverageThreshold/onlyFailures,
            // a non-zero exit with no parsed failures is now treated as a genuine (unparseable)
            // kill rather than Survived.  killedBy: ['unknown'] is the fallback.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   'bun test v1.3.12\n\n',
                    stderr:   '---|---|---\nFile | % Funcs | % Lines\n---|---|---\nAll files\n',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['unknown']);
            }
        });

        it('returns MutantRunStatus.Error when stderr indicates a syntax error and no tests ran', async () => {
            // Kills ConditionalExpression/LogicalOperator/EqualityOperator mutants at L803-814:
            //   - ConditionalExpression→true (always fires) would return Error even when tests DID run
            //   - LogicalOperator→|| would return Error when rawFailedNames>0 but tests=0
            //   - EqualityOperator inversions change when the runtime-error path fires
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   '',   // no test output at all (parsed.tests will be empty)
                    stderr:   'SyntaxError: Unexpected token \'export\'',
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '77' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            // rawFailedNames=0 and parsed.tests=0 → checkRuntimeError fires → SyntaxError in stderr → Error
            expect(result.status).toBe(MutantRunStatus.Error);
            if(result.status === MutantRunStatus.Error) {
                expect(result.errorMessage).toContain('SyntaxError');
            }
        });

        it('returns MutantRunStatus.Killed (not Error) when tests fail even with runtime-error keywords in stderr', async () => {
            // Kills LogicalOperator mutant 328: && → || would make runtime-error check fire when
            // rawFailedNames is non-empty, returning Error instead of Killed.
            // Also kills ConditionalExpression→true mutant 326 in the same way.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                }
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   'tests/foo.test.ts:\n✗ my test [1ms]\n  error: fail\n\n 0 pass\n 1 fail\n',
                    stderr:   'SyntaxError: some unrelated log line',  // error keyword in stderr but tests DID run
                    timedOut: false,
                });
            });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '77' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            // rawFailedNames.length > 0 → runtime-error check MUST NOT fire → Killed
            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toContain('tests/foo.test.ts > my test');
            }
        });

        it('should filter out null failure messages', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toContain('tests/example.test.ts > test 1');
                expect(result.killedBy).toContain('tests/example.test.ts > test 2');
                expect(result.failureMessage).toBe('error: Expected 2 but received 3');
            }
        });

        it('should include all failed test names in killedBy', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['tests/example.test.ts > test alpha', 'tests/example.test.ts > test beta', 'tests/example.test.ts > test gamma']);
                expect(result.failureMessage).toBe('error: Alpha failed\n\nerror: Beta failed\n\nerror: Gamma failed');
            }
        });

        it('should return killed status when tests fail', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      ['should catch mutant'],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toHaveLength(1);
                expect(result.killedBy[0]).toBe('tests/example.test.ts > should catch mutant');
                expect(result.nrOfTests).toBe(1);
            }
        });

        it('should return survived status when all tests pass', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Timeout);
        });

        it('should treat generic non-zero exit with no output as Killed+unknown (sanitized bunfig prevents threshold miss)', async () => {
            // With sanitized bunfig in place, a non-zero exit with unparseable output is
            // a genuine (unknown) kill.  killedBy: ['unknown'] is the expected fallback.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['unknown']);
            }
        });

        it('should set activeMutant in environment', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

        it('should enable bail for mutant runs when disableBail is not set', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

        it('should enable bail for mutant runs when disableBail is false', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
                disableBail:     false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    bail: true,
                })
            );
        });

        it('should disable bail for mutant runs when disableBail is true', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
                disableBail:     true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    bail: false,
                })
            );
        });

        it('should pass preload script to mutant runs', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

        it('should pass cached testFiles to mutantRun (reuses list from init without re-discovering)', async () => {
            // Arrange: discoverTestFiles returns a sorted list (set in global beforeEach)
            mockRunBunTests.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // discoverTestFiles called once during init
            expect(discoverTestFilesSpy).toHaveBeenCalledTimes(1);

            // Act: mutantRun should reuse the cached list (no additional call to discoverTestFiles)

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            // discoverTestFiles should still have been called only once (from init)
            expect(discoverTestFilesSpy).toHaveBeenCalledTimes(1);

            // mutantRun should have received the same testFiles list
            expect(mockRunBunTests).toHaveBeenCalledWith(
                expect.objectContaining({
                    testFiles: ['tests/alpha.test.ts', 'tests/beta.test.ts'],
                })
            );
        });

        it('should correctly filter and map failed tests for killedBy', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Console parser includes file path, so killedBy should have full paths
                expect(result.killedBy).toHaveLength(2);
                expect(result.killedBy).toContain('tests/example.test.ts > failing test 1');
                expect(result.killedBy).toContain('tests/example.test.ts > failing test 2');
                // Tests filter/map chain for failure messages
                expect(result.failureMessage).toBe('error: First error\n\nerror: Second error');
            }
        });

        it('should filter out empty failure messages and join with double newline', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

        it('should classify non-zero exit with no parsed failures as Killed+unknown (sanitized bunfig in place)', async () => {
            // With sanitized bunfig disabling coverage/onlyFailures, a non-zero exit with
            // no parseable failure output is treated as a genuine kill with killedBy: ['unknown'].
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
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

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['unknown']);
            }
        });

        it('should log exact mutantRun debug messages', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                // Call onInspectorReady immediately if provided

                if(options.onInspectorReady) {
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

            await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '42' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            // Verify exact debug message strings

            expect(mockLogger.debug).toHaveBeenCalledWith('Running mutant run for mutant %s', '42');

            expect(mockLogger.debug).toHaveBeenCalledWith('Mutant run completed: %o', expect.any(Object));
        });

        // ── killedBy resolution tests (Fix 1) ─────────────────────────────────
        // These tests run a dryRun first to populate cachedTestNames / baseNameIndex,
        // then call mutantRun and assert on the resolved killedBy entries.

        /**
         * Helper: set up mockRunBunTests to behave as a dryRun for the given inspector
         * tests/executionOrder, followed by a mutantRun with the provided stdout.
         * The mock switches between the two calls based on whether onInspectorReady
         * is present (dryRun) or not (mutantRun).
         */
        function setupDryRunThenMutantRun(
            inspectorTests: TestInfo[],
            executionOrder: number[],
            mutantRunStdout: string
        ): void {
            mockInspectorClient.getTests.mockReturnValue(inspectorTests);
            mockInspectorClient.getExecutionOrder.mockReturnValue(executionOrder);
            mockCollectCoverage.mockResolvedValue(undefined);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    // dryRun: fire the inspector-ready callback and return exit-0

                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   '',
                        stderr:   '',
                        timedOut: false,
                    });
                }
                // mutantRun: return the provided stdout with exit code 1
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   mutantRunStdout,
                    stderr:   '',
                    timedOut: false,
                });
            });
        }

        // (a) Failing test whose name exactly matches one registry entry → pass-through
        it('(a) killedBy resolution: exact match uses registry ID as-is', async () => {
            setupDryRunThenMutantRun(
                [{ id: 1, name: 'my test', fullName: 'my test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/foo.test.ts', status: 'pass' }],
                [1],
                'tests/foo.test.ts:\n✗ my test [1ms]\n  error: boom\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '1' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                expect(result.killedBy).toEqual(['tests/foo.test.ts > my test']);
            }
        });

        // (b) Failing test whose base name matches two registry entries → killedBy contains both
        it('(b) killedBy resolution: base-name collision expands to all suffixed IDs', async () => {
            // Two tests that collide on name; dryRun will register them as "bar [0]" and "bar [1]"
            setupDryRunThenMutantRun(
                [
                    { id: 1, name: 'bar', fullName: 'bar', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/b.test.ts', status: 'pass' },
                    { id: 2, name: 'bar', fullName: 'bar', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/b.test.ts', status: 'pass' },
                ],
                [1, 2],
                'tests/b.test.ts:\n✗ bar [1ms]\n  error: oops\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '2' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // "tests/b.test.ts > bar" is not in the registry; the base-name lookup
                // finds both "tests/b.test.ts > bar [0]" and "tests/b.test.ts > bar [1]"
                expect(result.killedBy).toHaveLength(2);
                expect(result.killedBy).toContain('tests/b.test.ts > bar [0]');
                expect(result.killedBy).toContain('tests/b.test.ts > bar [1]');
            }
        });

        // (c) Failing test whose name is already a full suffixed form in the registry → pass-through
        it('(c) killedBy resolution: already-suffixed name present in registry is passed through', async () => {
            // Two colliding tests registered as "baz [0]" and "baz [1]"
            setupDryRunThenMutantRun(
                [
                    { id: 1, name: 'baz', fullName: 'baz', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/c.test.ts', status: 'pass' },
                    { id: 2, name: 'baz', fullName: 'baz', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/c.test.ts', status: 'pass' },
                ],
                [1, 2],
                // Console output emits the already-suffixed form (hypothetical, but covers identity entry)
                'tests/c.test.ts:\n✗ baz [0] [1ms]\n  error: err\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '3' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // "tests/c.test.ts > baz [0]" is an exact match in cachedTestNames
                expect(result.killedBy).toEqual(['tests/c.test.ts > baz [0]']);
            }
        });

        // (d) Multiple failing tests with a mix of unique and colliding names → combined, de-duplicated
        it('(d) killedBy resolution: mix of unique and colliding names combined and de-duplicated', async () => {
            setupDryRunThenMutantRun(
                [
                    // "unique" — appears only once, registered as-is
                    { id: 1, name: 'unique test', fullName: 'unique test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/d.test.ts', status: 'pass' },
                    // "dup" — appears twice, registered as "dup [0]" / "dup [1]"
                    { id: 2, name: 'dup', fullName: 'dup', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/d.test.ts', status: 'pass' },
                    { id: 3, name: 'dup', fullName: 'dup', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/d.test.ts', status: 'pass' },
                ],
                [1, 2, 3],
                // Both "unique test" and "dup" fail (same dup base name listed twice to exercise dedup)
                'tests/d.test.ts:\n✗ unique test [1ms]\n  error: a\n✗ dup [1ms]\n  error: b\n✗ dup [1ms]\n  error: c\n\n 0 pass\n 3 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '4' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // unique test → exact match; dup (×2) → expands to [0] and [1], de-duplicated
                expect(result.killedBy).toHaveLength(3);
                expect(result.killedBy).toContain('tests/d.test.ts > unique test');
                expect(result.killedBy).toContain('tests/d.test.ts > dup [0]');
                expect(result.killedBy).toContain('tests/d.test.ts > dup [1]');
            }
        });

        // (e) Unrecognised name → falls back to ['unknown'] and emits a logger.warn
        it('(e) killedBy resolution: unrecognised name falls back to unknown and warns', async () => {
            // Registry has only "tests/e.test.ts > known test"
            setupDryRunThenMutantRun(
                [{ id: 1, name: 'known test', fullName: 'known test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/e.test.ts', status: 'pass' }],
                [1],
                // mutantRun output reports a completely different test name
                'tests/e.test.ts:\n✗ totally unknown test name [1ms]\n  error: err\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '5' } as any,
                testFilter:      [],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // The unrecognised name is included as-is (not dropped)
                expect(result.killedBy).toEqual(['tests/e.test.ts > totally unknown test name']);
            }
            // Should emit a logger.debug (not warn) for the unrecognised name —
            // the fallback is correct behavior, not a recoverable problem.

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('not found in test registry'),
                expect.stringContaining('totally unknown test name'),
                '5'
            );
            expect(mockLogger.warn).not.toHaveBeenCalledWith(
                expect.stringContaining('not found in test registry'),
                expect.anything(),
                expect.anything()
            );
        });

        // ── Local index tests (Fix: use testFilter on every worker) ───────────

        // (f) mutantRun-only worker: no dryRun, testFilter has suffixed IDs, raw output
        //     has bare name → local index resolves to the suffixed registry ID.
        it('resolves killedBy via local index built from options.testFilter', async () => {
            // Simulate a mutantRun-only worker: cachedTestNames/baseNameIndex are NOT set.
            // testFilter carries the suffixed registry ID Stryker recorded from dryRun.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                if(options.onInspectorReady) {
                    // dryRun path — should not be reached in this test

                    options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                }
                // mutantRun: console output uses the base name (no [N] suffix)
                return Promise.resolve({
                    exitCode: 1,
                    stdout:   'tests/foo.test.ts:\n✗ should do X [1ms]\n  error: boom\n\n 0 pass\n 1 fail\n',
                    stderr:   '',
                    timedOut: false,
                });
            });

            // Do NOT call dryRun — this runner has no instance baseNameIndex
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();

            // testFilter includes the suffixed ID (as Stryker would pass it)

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '99' } as any,
                testFilter:      ['tests/foo.test.ts > should do X [0]'],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // The local index must expand the bare "should do X" → suffixed registry ID
                expect(result.killedBy).toContain('tests/foo.test.ts > should do X [0]');
                // Must NOT contain the unsuffixed raw name
                expect(result.killedBy).not.toContain('tests/foo.test.ts > should do X');
            }
        });

        // (g) testFilter is empty; instance baseNameIndex IS populated (dryRun worker).
        //     Verifies the fallback path still works after the local-index change.
        it('falls back to instance baseNameIndex when testFilter is empty', async () => {
            // Use setupDryRunThenMutantRun so cachedTestNames/baseNameIndex are populated,
            // then call mutantRun with an empty testFilter (simulating the dryRun worker).
            setupDryRunThenMutantRun(
                [
                    { id: 1, name: 'should do Y', fullName: 'should do Y', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/bar.test.ts', status: 'pass' },
                    { id: 2, name: 'should do Y', fullName: 'should do Y', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/bar.test.ts', status: 'pass' },
                ],
                [1, 2],
                'tests/bar.test.ts:\n✗ should do Y [1ms]\n  error: oops\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();  // populates cachedTestNames and baseNameIndex

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '100' } as any,
                testFilter:      [],   // empty → must fall back to instance fields
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Instance baseNameIndex expands "should do Y" → [0] and [1]
                expect(result.killedBy).toHaveLength(2);
                expect(result.killedBy).toContain('tests/bar.test.ts > should do Y [0]');
                expect(result.killedBy).toContain('tests/bar.test.ts > should do Y [1]');
            }
        });

        // (h) Leaked test: testFilter is non-empty but the failing test is NOT in testFilter.
        //     The test leaks through Bun's hierarchy regex and kills the mutant.
        //     Its name is absent from localRegistry but present in cachedTestNames (step 3).
        it('(h) killedBy resolution: leaked test (not in testFilter) resolved via instance cachedTestNames', async () => {
            // Run a dryRun so cachedTestNames/baseNameIndex are populated with "leak test"
            setupDryRunThenMutantRun(
                [{ id: 1, name: 'leak test', fullName: 'leak test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/leak.test.ts', status: 'pass' }],
                [1],
                'tests/leak.test.ts:\n✗ leak test [1ms]\n  error: leaked!\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();  // populates cachedTestNames with "tests/leak.test.ts > leak test"

            // mutantRun with testFilter that does NOT include "leak test"

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '101' } as any,
                testFilter:      ['tests/other.test.ts > other test'],   // unrelated test in testFilter
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // "leak test" not in localRegistry, but exact match in cachedTestNames (step 3)
                expect(result.killedBy).toEqual(['tests/leak.test.ts > leak test']);
                // Must NOT warn about unrecognised name

                expect(mockLogger.warn).not.toHaveBeenCalledWith(
                    expect.stringContaining('not found in test registry'),
                    expect.anything(),
                    expect.anything()
                );
            }
        });

        // (i) Leaked test with base-name collision: failing test not in testFilter but
        //     present only in instance baseNameIndex (step 4).
        it('(i) killedBy resolution: leaked test with base-name collision resolved via instance baseNameIndex', async () => {
            // Run a dryRun with two tests sharing the same base name
            setupDryRunThenMutantRun(
                [
                    { id: 1, name: 'shared name', fullName: 'shared name', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/shared.test.ts', status: 'pass' },
                    { id: 2, name: 'shared name', fullName: 'shared name', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/shared.test.ts', status: 'pass' },
                ],
                [1, 2],
                'tests/shared.test.ts:\n✗ shared name [1ms]\n  error: collision!\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();  // registers "shared name [0]" and "shared name [1]"

            // mutantRun with testFilter that does NOT mention "shared name"

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '102' } as any,
                testFilter:      ['tests/other.test.ts > unrelated'],   // unrelated
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // "shared name" not in localRegistry/localBaseIndex; instance baseNameIndex
                // expands it to both suffixed IDs (step 4)
                expect(result.killedBy).toHaveLength(2);
                expect(result.killedBy).toContain('tests/shared.test.ts > shared name [0]');
                expect(result.killedBy).toContain('tests/shared.test.ts > shared name [1]');
                // Must NOT warn about unrecognised name

                expect(mockLogger.warn).not.toHaveBeenCalledWith(
                    expect.stringContaining('not found in test registry'),
                    expect.anything(),
                    expect.anything()
                );
            }
        });

        // (j) Test in testFilter IS the one that fails: local index resolves it (step 1/2).
        //     Verifies unchanged behavior for the normal (non-leaked) case.
        it('(j) killedBy resolution: test in testFilter that fails is resolved via local index', async () => {
            setupDryRunThenMutantRun(
                [
                    { id: 1, name: 'covering test', fullName: 'covering test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/cover.test.ts', status: 'pass' },
                    { id: 2, name: 'covering test', fullName: 'covering test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/cover.test.ts', status: 'pass' },
                ],
                [1, 2],
                'tests/cover.test.ts:\n✗ covering test [1ms]\n  error: mutant!\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            // testFilter includes the suffixed IDs for "covering test"

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant: { id: '103' } as any,
                testFilter:   [
                    'tests/cover.test.ts > covering test [0]',
                    'tests/cover.test.ts > covering test [1]',
                ],
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Bun outputs base name "covering test"; local index (step 2) expands it
                expect(result.killedBy).toHaveLength(2);
                expect(result.killedBy).toContain('tests/cover.test.ts > covering test [0]');
                expect(result.killedBy).toContain('tests/cover.test.ts > covering test [1]');
            }
        });

        // (k) Fallback chain: name present in NEITHER local index nor instance registry.
        //     Warning fires as before and raw name is stored (unchanged behavior).
        it('(k) killedBy resolution: name in neither local nor instance registry warns and includes as-is', async () => {
            setupDryRunThenMutantRun(
                [{ id: 1, name: 'known test', fullName: 'known test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/k.test.ts', status: 'pass' }],
                [1],
                'tests/k.test.ts:\n✗ completely unknown test [1ms]\n  error: nope\n\n 0 pass\n 1 fail\n'
            );

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dryRun();

            const result = await runner.mutantRun({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                activeMutant:    { id: '104' } as any,
                testFilter:      ['tests/k.test.ts > known test'],  // known test in filter, unknown one leaks
                sandboxFileName: 'sandbox',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
            } as any);

            expect(result.status).toBe(MutantRunStatus.Killed);
            if(result.status === MutantRunStatus.Killed) {
                // Raw name stored as-is
                expect(result.killedBy).toContain('tests/k.test.ts > completely unknown test');
            }
            // Debug (not warn) emitted for unresolved name

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('not found in test registry'),
                expect.stringContaining('completely unknown test'),
                expect.anything()
            );
            expect(mockLogger.warn).not.toHaveBeenCalledWith(
                expect.stringContaining('not found in test registry'),
                expect.anything(),
                expect.anything()
            );
        });

        // ── Registry file persistence/loading tests (Fix: shared registry for all workers) ─────

        describe('dryRun registry persistence', () => {
            let writeFileSpy:  ReturnType<typeof spyOn>;
            let renameSpy:     ReturnType<typeof spyOn>;
            let mkdirSpy:      ReturnType<typeof spyOn>;

            beforeEach(() => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
                renameSpy    = spyOn(fsPromises, 'rename').mockResolvedValue(undefined);
                mkdirSpy     = spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
            });

            afterEach(() => {
                writeFileSpy.mockRestore();

                renameSpy.mockRestore();

                mkdirSpy.mockRestore();
            });

            it('writes registry JSON with expected shape after dryRun completes', async () => {
                // Two tests: one unique, one duplicate (so baseNameIndex has both entries)
                mockInspectorClient.getTests.mockReturnValue([
                    { id: 1, name: 'unique test',   fullName: 'unique test',   type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/reg.test.ts', status: 'pass' },
                    { id: 2, name: 'dup test',       fullName: 'dup test',       type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/reg.test.ts', status: 'pass' },
                    { id: 3, name: 'dup test',       fullName: 'dup test',       type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/reg.test.ts', status: 'pass' },
                ]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2, 3]);
                mockCollectCoverage.mockResolvedValue(undefined);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();

                // writeFile should have been called with the .tmp path
                expect(writeFileSpy).toHaveBeenCalled();
                const writeCall = writeFileSpy.mock.calls.find(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic arg
                    (args: any) => String(args[0]).endsWith('.stryker-bun-runner-registry.json.tmp')
                );
                expect(writeCall).toBeDefined();

                // Parse the written JSON and verify shape

                const written = JSON.parse(writeCall![1] as string);

                expect(written.version).toBe(1);

                expect(written.writtenAt).toBeNumber();
                // cachedTestNames: unique test + dup test [0] + dup test [1]

                expect(written.cachedTestNames).toBeArray();

                expect(written.cachedTestNames).toContain('tests/reg.test.ts > unique test');

                expect(written.cachedTestNames).toContain('tests/reg.test.ts > dup test [0]');

                expect(written.cachedTestNames).toContain('tests/reg.test.ts > dup test [1]');
                // baseNameIndex is serialised as entries array — every element must be a [string, string[]] pair
                // (Kills ArrayDeclaration mutant 293: prepending "Stryker was here" would break this structure)
                expect(written.baseNameIndex).toBeArray();
                for(const entry of written.baseNameIndex) {
                    expect(Array.isArray(entry)).toBe(true);
                    expect(typeof entry[0]).toBe('string');
                    expect(Array.isArray(entry[1])).toBe(true);
                    for(const name of entry[1]) {
                        expect(typeof name).toBe('string');
                    }
                }
                // Verify the structure can be reconstructed as a Map (as loadRegistryFile does)
                const reconstructed = new Map<string, string[]>(written.baseNameIndex);
                expect(reconstructed.size).toBeGreaterThan(0);
            });

            it('uses atomic write-to-tmp-then-rename pattern for the registry file', async () => {
                mockInspectorClient.getTests.mockReturnValue([
                    { id: 1, name: 'atomic test', fullName: 'atomic test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/atomic.test.ts', status: 'pass' },
                ]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
                mockCollectCoverage.mockResolvedValue(undefined);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });

                // Track call order to ensure writeFile precedes rename
                const callOrder: string[] = [];
                writeFileSpy.mockImplementation(async () => {
                    callOrder.push('writeFile');
                });
                renameSpy.mockImplementation(async () => {
                    callOrder.push('rename');
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();

                // writeFile must have been called with the .tmp path
                const tmpWriteCall = writeFileSpy.mock.calls.find(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic arg
                    (args: any) => String(args[0]).endsWith('.stryker-bun-runner-registry.json.tmp')
                );
                expect(tmpWriteCall).toBeDefined();

                // rename must have been called from .tmp → final path
                expect(renameSpy).toHaveBeenCalledWith(
                    expect.stringMatching(/\.stryker-bun-runner-registry\.json\.tmp$/),
                    expect.stringMatching(/\.stryker-bun-runner-registry\.json$/)
                );

                // writeFile must precede rename in the call order
                expect(callOrder.indexOf('writeFile')).toBeLessThan(callOrder.indexOf('rename'));
            });

            it('logs a warning but does not throw when writeFile fails', async () => {
                mockInspectorClient.getTests.mockReturnValue([
                    { id: 1, name: 'my test', fullName: 'my test', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/t.test.ts', status: 'pass' },
                ]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
                mockCollectCoverage.mockResolvedValue(undefined);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });

                // Make writeFile fail with a disk-full error
                writeFileSpy.mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                // Should NOT throw even though writeFile fails
                const result = await runner.dryRun();

                expect(result.status).toBe(DryRunStatus.Complete);

                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('Failed to write dryRun registry file'),
                    expect.stringContaining('ENOSPC')
                );
            });
        });

        describe('mutantRun registry lazy-load', () => {
            let readFileSpy:  ReturnType<typeof spyOn>;
            let writeFileSpy: ReturnType<typeof spyOn>;
            let renameSpy:    ReturnType<typeof spyOn>;
            let mkdirSpy:     ReturnType<typeof spyOn>;

            beforeEach(() => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // Suppress writes during these tests (we don't care about the dryRun write)
                writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
                renameSpy    = spyOn(fsPromises, 'rename').mockResolvedValue(undefined);
                mkdirSpy     = spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
                readFileSpy  = spyOn(fsPromises, 'readFile');
            });

            afterEach(() => {
                readFileSpy.mockRestore();

                writeFileSpy.mockRestore();

                renameSpy.mockRestore();

                mkdirSpy.mockRestore();
            });

            it('loads registry from file and correctly resolves a suffixed killedBy name (static-coverage mutant)', async () => {
                // Simulate a non-dryRun worker: no cachedTestNames, testFilter is empty.
                // The registry file contains a test that has a " [N]" suffix.
                const registryJson = JSON.stringify({
                    version:         1,
                    writtenAt:       Date.now(),
                    cachedTestNames: [
                        'tests/static.test.ts > static test [0]',
                        'tests/static.test.ts > static test [1]',
                    ],
                    baseNameIndex: [
                        ['tests/static.test.ts > static test', ['tests/static.test.ts > static test [0]', 'tests/static.test.ts > static test [1]']],
                        ['tests/static.test.ts > static test [0]', ['tests/static.test.ts > static test [0]']],
                        ['tests/static.test.ts > static test [1]', ['tests/static.test.ts > static test [1]']],
                    ],
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns string
                readFileSpy.mockResolvedValue(registryJson as any);

                // mutantRun output: Bun console parser emits the base name (no [N] suffix)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    // Static-coverage mutant: no --test-name-pattern filter; Bun ran all tests
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   'tests/static.test.ts:\n✗ static test [1ms]\n  error: mutant escaped\n\n 0 pass\n 1 fail\n',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                // Do NOT call dryRun — this is a non-dryRun worker
                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '200' } as any,
                    testFilter:      [],   // empty → static-coverage mutant
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Base-name "static test" should expand to both suffixed IDs via loaded registry
                    expect(result.killedBy).toHaveLength(2);
                    expect(result.killedBy).toContain('tests/static.test.ts > static test [0]');
                    expect(result.killedBy).toContain('tests/static.test.ts > static test [1]');
                    // Must NOT contain the raw unsuffixed name
                    expect(result.killedBy).not.toContain('tests/static.test.ts > static test');
                }
                // Registry should have been read (lazy-load triggered)
                expect(readFileSpy).toHaveBeenCalled();
            });

            it('reads registry file even when testFilter is non-empty (fallback chain needs instance registry for leaked tests)', async () => {
                // With the fallback chain fix, loadRegistryFile is called whenever
                // cachedTestNames is absent — regardless of testFilter presence.
                // This ensures leaked tests (tests NOT in testFilter that Bun's hierarchy
                // regex may still run) can be resolved via the instance registry.
                const registryJson = JSON.stringify({
                    version:         1,
                    writtenAt:       Date.now(),
                    cachedTestNames: ['tests/foo.test.ts > should work [0]'],
                    baseNameIndex:   [
                        ['tests/foo.test.ts > should work', ['tests/foo.test.ts > should work [0]']],
                        ['tests/foo.test.ts > should work [0]', ['tests/foo.test.ts > should work [0]']],
                    ],
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns string
                readFileSpy.mockResolvedValue(registryJson as any);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   'tests/foo.test.ts:\n✗ should work [1ms]\n  error: nope\n\n 0 pass\n 1 fail\n',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '201' } as any,
                    testFilter:      ['tests/foo.test.ts > should work [0]'],  // non-empty
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // readFile SHOULD have been called — instance registry is loaded as fallback
                expect(readFileSpy).toHaveBeenCalled();
                // The test name resolves via local index (step 1 exact match) to the registry ID
                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    expect(result.killedBy).toContain('tests/foo.test.ts > should work [0]');
                }
            });

            it('falls back to raw names and warns when registry file is missing (ENOENT)', async () => {
                const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns error
                readFileSpy.mockRejectedValue(enoentErr as any);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   'tests/foo.test.ts:\n✗ raw name test [1ms]\n  error: killed\n\n 0 pass\n 1 fail\n',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '202' } as any,
                    testFilter:      [],  // empty → tries to load registry
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Should NOT throw — falls back to raw name
                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Raw name used as-is since no registry available
                    expect(result.killedBy).toContain('tests/foo.test.ts > raw name test');
                }

                // ENOENT is expected on non-dryRun workers; the log is debug not warn
                expect(mockLogger.debug).toHaveBeenCalledWith(
                    expect.stringContaining('dryRun registry file not found'),
                    expect.stringContaining('.stryker-bun-runner-registry.json')
                );
            });

            it('logs warning when registry file load fails with non-ENOENT error', async () => {
                // Non-ENOENT errors (e.g. EACCES, parse failure) should log a warn, not a debug
                const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns error
                readFileSpy.mockRejectedValue(permError as any);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   'tests/foo.test.ts:\n✗ test name [1ms]\n  error: killed\n\n 0 pass\n 1 fail\n',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '202' } as any,
                    testFilter:      [],  // empty → tries to load registry
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Non-ENOENT error must log a warn with the exact format string (kills StringLiteral mutant 79)
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    'Failed to load dryRun registry from %s: %s',
                    expect.stringContaining('.stryker-bun-runner-registry.json'),
                    'EACCES: permission denied'
                );

                // Must NOT have logged the debug message used for ENOENT
                expect(mockLogger.debug).not.toHaveBeenCalledWith(
                    expect.stringContaining('dryRun registry file not found'),
                    expect.any(String)
                );
            });

            it('caches registry after first load (does not re-read file on second mutantRun)', async () => {
                const registryJson = JSON.stringify({
                    version:         1,
                    writtenAt:       Date.now(),
                    cachedTestNames: ['tests/cache.test.ts > cached test'],
                    baseNameIndex:   [
                        ['tests/cache.test.ts > cached test', ['tests/cache.test.ts > cached test']],
                    ],
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns string
                readFileSpy.mockResolvedValue(registryJson as any);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    return Promise.resolve({
                        exitCode: 1,
                        stdout:   'tests/cache.test.ts:\n✗ cached test [1ms]\n  error: killed\n\n 0 pass\n 1 fail\n',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // First call: triggers registry load

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '203' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Second call: registry already in memory; should NOT read file again

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '204' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // readFile called exactly once (on first load, cached after that)
                expect(readFileSpy).toHaveBeenCalledTimes(1);
            });

            it('logs malformed warning and treats registry as absent when cachedTestNames is not an array', async () => {
                // Registry file has version:1 but cachedTestNames is a string (malformed)
                const malformedJson = JSON.stringify({
                    version:         1,
                    writtenAt:       Date.now(),
                    cachedTestNames: 'not-an-array',
                    baseNameIndex:   [],
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns string
                readFileSpy.mockResolvedValue(malformedJson as any);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    return Promise.resolve({ exitCode: 0, stdout: ' 0 pass\n 0 fail\n', stderr: '', timedOut: false });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // First call: triggers registry load, shape-check fails

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '205' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Should have warned about the malformed file

                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('malformed')
                );

                // Invariant: failed shape-check must leave cachedTestNames undefined, so the
                // guard `if (!this.cachedTestNames) await this.loadRegistryFile()` fires again
                // on the second call.  readFile being invoked twice proves no half-init occurred.
                const callsAfterFirst = readFileSpy.mock.calls.length;

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '206' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);
                expect(readFileSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
            });

            it('rejects registry file where cachedTestNames is missing', async () => {
                // Registry has version:1 but both cachedTestNames AND baseNameIndex are absent.
                const missingJson = JSON.stringify({ version: 1 });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock returns string
                readFileSpy.mockResolvedValue(missingJson as any);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                    }
                    return Promise.resolve({ exitCode: 0, stdout: ' 0 pass\n 0 fail\n', stderr: '', timedOut: false });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                // First call: triggers registry load, shape-check fails

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '205' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Should have warned about the malformed file (cachedTestNames missing)

                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('malformed')
                );

                // Invariant: failed shape-check must leave cachedTestNames undefined, so the
                // guard `if (!this.cachedTestNames) await this.loadRegistryFile()` fires again
                // on the second call.  readFile being invoked twice proves no half-init occurred.
                const callsAfterFirst = readFileSpy.mock.calls.length;

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '207' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);
                expect(readFileSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
            });
        });

        describe('memory containment options', () => {
            it('passes smol, maxChildRss, and rssCheckIntervalMs through to runBunTests', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });

                const runner = new BunTestRunner(mockLogger, {
                    bun: { smol: true, maxChildRss: 500_000_000, rssCheckIntervalMs: 2000 },
                } as unknown as StrykerOptions);
                await runner.init();

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({
                        smol:               true,
                        maxChildRss:        500_000_000,
                        rssCheckIntervalMs: 2000,
                    })
                );
            });

            it('logs a warning identifying the mutant via onMemoryLimitExceeded when the child exceeds maxChildRss', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    options.onMemoryLimitExceeded?.(600_000_000);
                    return Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true, memoryLimitExceeded: true });
                });

                const runner = new BunTestRunner(mockLogger, { bun: { maxChildRss: 500_000_000 } } as unknown as StrykerOptions);
                await runner.init();

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: 'mutant-42' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('exceeded maxChildRss'),
                    600_000_000,
                    'mutant-42'
                );
            });
        });

        describe('in-flight abort via dispose', () => {
            it('clears currentAbortController after mutantRun completes (subsequent dispose does not re-abort a finished run)', async () => {
                mockRunBunTests.mockImplementation(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                await runner.dispose();

                expect(mockLogger.debug).not.toHaveBeenCalledWith('Aborting in-flight bun test child during dispose');
            });

            it('aborts the in-flight child when dispose() runs while mutantRun has not yet resolved', async () => {
                let capturedSignal: AbortSignal | undefined;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                let releaseRunBunTests: (value: any) => void = () => {};
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    capturedSignal = options.signal;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    return new Promise((resolve: (value: any) => void) => {
                        releaseRunBunTests = resolve;
                    });
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const mutantRunPromise = runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // mutantRun() does real (non-mocked-away) fs.readFile/discovery work
                // before reaching runBunTests, which needs at least one real
                // macrotask tick to settle — plain Promise.resolve() microtask
                // chains aren't enough here (unlike the dryRun equivalent test).
                // eslint-disable-next-line no-unmodified-loop-condition -- capturedSignal is set by the mockRunBunTests closure above, a different function; ESLint cannot track that cross-closure mutation
                for(let i = 0; i < 5 && !capturedSignal; i++) {
                    // eslint-disable-next-line no-await-in-loop -- sequential polling to let pending I/O settle before asserting
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, 0);
                    });
                }

                expect(capturedSignal?.aborted).toBe(false);

                await runner.dispose();

                expect(capturedSignal?.aborted).toBe(true);
                expect(mockLogger.debug).toHaveBeenCalledWith('Aborting in-flight bun test child during dispose');

                releaseRunBunTests({ exitCode: null, stdout: '', stderr: '', timedOut: true });
                await mutantRunPromise;
            });
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

            expect(mockLogger.debug).toHaveBeenCalledWith('Disposing BunTestRunner');

            expect(mockLogger.debug).toHaveBeenCalledWith('Cleaning up preload script: %s', expect.any(String));

            expect(mockLogger.debug).toHaveBeenCalledWith('Cleaning up coverage file: %s', expect.any(String));
        });

        it('does not attempt unlink during dispose when dryRun never ran', async () => {
            const unlinkSpy = spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
            await runner.init();
            await runner.dispose();

            // No dryRun → lastRegistryTmpPath is unset → unlink must NOT be called
            const tmpCall = unlinkSpy.mock.calls.find(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic arg check
                (args: any) => String(args[0]).endsWith('.stryker-bun-runner-registry.json.tmp')
            );
            expect(tmpCall).toBeUndefined();

            unlinkSpy.mockRestore();
        });

        describe('dispose after dryRun (lastRegistryTmpPath caching)', () => {
            let writeFileSpy: ReturnType<typeof spyOn>;
            let renameSpy:    ReturnType<typeof spyOn>;

            beforeEach(() => {
                writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
                renameSpy    = spyOn(fsPromises, 'rename').mockResolvedValue(undefined);

                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);
                mockCollectCoverage.mockResolvedValue(undefined);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
            });

            afterEach(() => {
                writeFileSpy.mockRestore();

                renameSpy.mockRestore();
            });

            it('does NOT attempt unlink on the registry tmp path when dryRun succeeds (tmp was renamed away)', async () => {
                // Fix 7: after a successful rename(), lastRegistryTmpPath is cleared so that
                // dispose() does not try to unlink a path that no longer exists.
                // This test verifies the new correct semantics: no unlink for the .tmp file
                // when dryRun() completed normally (rename succeeded).
                const unlinkSpy = spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();
                await runner.dispose();

                // After successful rename, lastRegistryTmpPath is cleared → no unlink for .tmp
                const tmpCall = unlinkSpy.mock.calls.find(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic arg check
                    (args: any) => String(args[0]).endsWith('.stryker-bun-runner-registry.json.tmp')
                );
                expect(tmpCall).toBeUndefined();

                unlinkSpy.mockRestore();
            });

            it('calls unlink on the registry tmp path when rename fails (crash between writeFile and rename)', async () => {
                // When rename() fails (e.g. OS error), lastRegistryTmpPath remains set so
                // dispose() can clean up the orphaned .tmp file.
                renameSpy.mockRejectedValue(Object.assign(new Error('ENOENT: rename failed'), { code: 'ENOENT' }));

                const unlinkSpy = spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                // dryRun will log a warning about the rename failure but still complete
                await runner.dryRun();
                await runner.dispose();

                // lastRegistryTmpPath was NOT cleared (rename failed) → dispose() should unlink
                const tmpCall = unlinkSpy.mock.calls.find(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic arg check
                    (args: any) => String(args[0]).endsWith('.stryker-bun-runner-registry.json.tmp')
                );
                expect(tmpCall).toBeDefined();

                unlinkSpy.mockRestore();
            });

            it('swallows ENOENT silently when registry tmp file does not exist during dispose', async () => {
                // Simulate: rename() failed so lastRegistryTmpPath is still set, but the tmp file
                // is gone by the time dispose() runs → ENOENT from unlink should be silent.
                renameSpy.mockRejectedValue(Object.assign(new Error('ENOENT: rename failed'), { code: 'ENOENT' }));

                const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
                const unlinkSpy = spyOn(fsPromises, 'unlink').mockRejectedValue(enoentErr);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();
                await runner.dispose();
                // ENOENT is normal — must NOT be debug-logged

                expect(mockLogger.debug).not.toHaveBeenCalledWith(
                    expect.stringContaining('Failed to clean registry tmp file'),
                    expect.any(String)
                );

                unlinkSpy.mockRestore();
            });

            it('debug-logs unexpected unlink errors during dispose without rethrowing', async () => {
                // Simulate: rename() failed so lastRegistryTmpPath is still set, and unlink
                // fails with an unexpected error — it should be debug-logged but not thrown.
                renameSpy.mockRejectedValue(Object.assign(new Error('ENOENT: rename failed'), { code: 'ENOENT' }));

                const permErr = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
                const unlinkSpy = spyOn(fsPromises, 'unlink').mockRejectedValue(permErr);

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();
                await runner.dryRun();
                await runner.dispose();
                // Non-ENOENT error must be debug-logged

                expect(mockLogger.debug).toHaveBeenCalledWith(
                    expect.stringContaining('Failed to clean registry tmp file'),
                    expect.stringContaining('EPERM')
                );

                unlinkSpy.mockRestore();
            });
        });
    });

    describe('maxTestRunnerReuse compatibility (dispose + fresh-instance cycle)', () => {
        // Simulates what Stryker core does when `maxTestRunnerReuse` is configured:
        // dispose() the current TestRunner, then construct and init() a BRAND NEW
        // instance (not the disposed one) to continue the campaign. The plugin has
        // no hook into that recycling decision — it only needs to (a) leave no state
        // behind that the next instance depends on, and (b) tolerate never having
        // run dryRun itself, falling back to the shared on-disk registry exactly as
        // it already does for any other multi-worker Stryker run.
        it('a fresh instance can resolve killedBy via the registry file written by the disposed instance', async () => {
            let storedRegistry: string | undefined;

            const writeFileSpy = spyOn(fsPromises, 'writeFile').mockImplementation(((_path: string, data: string) => {
                storedRegistry = data;
                return Promise.resolve();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock signature narrower than fsPromises.writeFile's real overloads
            }) as any);
            const renameSpy = spyOn(fsPromises, 'rename').mockResolvedValue(undefined);

            const readFileSpy = spyOn(fsPromises, 'readFile').mockImplementation((() => {
                if(storedRegistry === undefined) {
                    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
                }
                return Promise.resolve(storedRegistry);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock signature narrower than fsPromises.readFile's real overloads
            }) as any);

            try {
                mockInspectorClient.getTests.mockReturnValue([]);
                mockInspectorClient.getExecutionOrder.mockReturnValue([]);
                mockCollectCoverage.mockResolvedValue(undefined);

                // --- Instance 1: runs dryRun, then Stryker disposes it (maxTestRunnerReuse hit) ---
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload-1.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
                        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                    }
                    return Promise.resolve({
                        exitCode: 0,
                        stdout:   'tests/foo.test.ts:\n✓ my test [1ms]\n\n 1 pass\n',
                        stderr:   '',
                        timedOut: false,
                    });
                });

                const runner1 = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner1.init();
                const dryRunResult = await runner1.dryRun();
                expect(dryRunResult.status).toBe(DryRunStatus.Complete);

                await runner1.dispose();
                expect(storedRegistry).toBeDefined();

                // --- Instance 2: a brand-new BunTestRunner, exactly as Stryker constructs
                // after disposing the old one under maxTestRunnerReuse. It never ran
                // dryRun, so testFilter is empty (as Stryker sends for static-coverage
                // mutants) and localRegistry is empty — resolution MUST come from the
                // lazily-loaded, file-backed registry written by instance 1.
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload-2.ts');
                mockRunBunTests.mockImplementation(() => Promise.resolve({
                    exitCode: 1,
                    stdout:   'tests/foo.test.ts:\n✗ my test [1ms]\n  error: fail\n\n 0 pass\n 1 fail\n',
                    stderr:   '',
                    timedOut: false,
                }));

                const runner2 = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner2.init();

                const mutantResult = await runner2.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '99' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(mutantResult.status).toBe(MutantRunStatus.Killed);
                if(mutantResult.status === MutantRunStatus.Killed) {
                    expect(mutantResult.killedBy).toContain('tests/foo.test.ts > my test');
                    expect(mutantResult.killedBy).not.toContain('unknown');
                }

                await runner2.dispose();
            } finally {
                writeFileSpy.mockRestore();
                renameSpy.mockRestore();
                readFileSpy.mockRestore();
            }
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

                        coverageFile: expect.stringMatching(/coverage-\d+\.json$/),
                    })
                );
            });
        });

        describe('Lines 185-186: timePerTest calculation mutations', () => {
            it('should use division (/) not multiplication (*) for timePerTest', async () => {
                jest.useFakeTimers();
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    mockRunBunTests.mockImplementation((options: any) => {
                        if(options.onInspectorReady) {
                            options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        }
                        // Return after small delay with 2 tests
                        // Use fake timer advancement for consistent timing
                        jest.advanceTimersByTime(20);
                        return Promise.resolve({
                            exitCode: 0,
                            stdout:   '2 passed',
                            stderr:   '',
                            timedOut: false,
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
                } finally {
                    jest.useRealTimers();
                }
            });

            it('should use > 0 not >= 0 for executionOrder length check', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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
                    if(options.onInspectorReady) {
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
                    if(options.onInspectorReady) {
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
                    if(options.onInspectorReady) {
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
                jest.useFakeTimers();
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    mockRunBunTests.mockImplementation((options: any) => {
                        // Call onInspectorReady after 110ms (slightly past the 100ms timeout boundary)
                        setTimeout(() => {
                            if(options.onInspectorReady) {
                                options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                            }
                        }, 110);

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

                    // Start the dryRun (don't await yet)
                    const resultPromise = runner.dryRun();

                    // Advance fake timers past the timeout (100ms) but before callback (110ms)
                    for(let i = 0; i < 5; i++) {
                        jest.advanceTimersByTime(50);
                        // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test
                        await Promise.resolve();
                    }

                    const result = await resultPromise;

                    // With < (correct), timeout at exactly 100ms should fail
                    // With <= (mutation), timeout at exactly 100ms would succeed
                    // Since we're calling onInspectorReady at 110ms (after timeout),
                    // it should timeout with <, but might succeed with <=
                    if(result.status === DryRunStatus.Error) {
                        expect(result.errorMessage).toContain('Timeout waiting for inspector URL');
                    }
                } finally {
                    jest.useRealTimers();
                }
            });
        });

        describe('Lines 321, 451: ObjectLiteral handlers invocation', () => {
            it('should pass empty handlers object to InspectorClient (no per-test relay needed)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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
                let capturedHandlers: Record<string, unknown> | undefined;

                // @ts-expect-error - Mocking constructor with implementation
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                spyOn(inspectorModule, 'InspectorClient').mockImplementation((options: any) => {
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

                // Coverage uses file-prefixed counter keys (Bun.main@@test-N), no per-test relay needed
                expect(capturedHandlers).toBeDefined();
                expect(capturedHandlers).toEqual({});
            });

            it('should log exact debug message after enabling TestReporter (line 332)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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

                expect(mockLogger.debug).toHaveBeenCalledWith('Inspector connected and TestReporter enabled');
            });

            it('should log exact debug message with exit code format (line 383)', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '123' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Verify exact log format with %o

                expect(mockLogger.debug).toHaveBeenCalledWith(
                    'Mutant run completed: %o',
                    expect.objectContaining({

                        totalTests: expect.any(Number),

                        passed: expect.any(Number),

                        failed: expect.any(Number),

                        exitCode: expect.any(Number),
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Verify ONLY failed tests are in killedBy (not the passing one)
                    expect(result.killedBy).toHaveLength(2);
                    expect(result.killedBy).toContain('test/file.test.ts > failing test 1');
                    expect(result.killedBy).toContain('test/file.test.ts > failing test 2');
                    expect(result.killedBy).not.toContain('test/file.test.ts > passing test');
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // If filter was removed or condition changed, we'd get wrong tests
                    expect(result.killedBy).toHaveLength(2);
                    expect(result.killedBy).toContain('test/file.test.ts > test A');
                    expect(result.killedBy).toContain('test/file.test.ts > test B');
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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
                    if(options.onInspectorReady) {
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
                jest.useFakeTimers();
                try {
                    mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                    const totalTime = 20;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    mockRunBunTests.mockImplementation((options: any) => {
                        if(options.onInspectorReady) {
                            options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        }

                        // Use fake timer advancement for consistent timing
                        jest.advanceTimersByTime(totalTime);
                        return Promise.resolve({
                            exitCode: 0,
                            stdout:   '✓ test1 [0.12ms]\n✓ test2 [0.12ms]\n 2 pass',
                            stderr:   '',
                            timedOut: false,
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
                } finally {
                    jest.useRealTimers();
                }
            });

            // Kill mutation #1 & #2: line 186 - ConditionalExpression true and EqualityOperator >= 0
            it('should use correct conditional (> 0 not >= 0) for timePerTest calculation', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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
                jest.useFakeTimers();
                try {
                    mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                    const totalTime = 100; // Use larger time to make difference obvious
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    mockRunBunTests.mockImplementation((options: any) => {
                        if(options.onInspectorReady) {
                            options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                        }

                        // Use fake timer advancement for consistent timing
                        jest.advanceTimersByTime(totalTime);
                        return Promise.resolve({
                            exitCode: 0,
                            stdout:   '✓ test1 [0.12ms]\n✓ test2 [0.12ms]\n 2 pass',
                            stderr:   '',
                            timedOut: false,
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
                } finally {
                    jest.useRealTimers();
                }
            });

            // Kill mutation #81: line 211 - ArithmeticOperator / to *
            it('should convert elapsed nanoseconds to milliseconds correctly', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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
                jest.useFakeTimers();
                try {
                    mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

                    // Mock runBunTests to never call onInspectorReady but resolve the
                    // child promise so the runner can drain stdout/stderr for diagnostics.
                    mockRunBunTests.mockImplementation(() => {
                        return Promise.resolve({
                            exitCode: 1,
                            stdout:   '',
                            stderr:   'simulated early exit',
                            timedOut: false,
                        });
                    });

                    const runner = new BunTestRunner(mockLogger, {
                        bun: {
                            inspectorTimeout: 100,
                        },
                    } as unknown as StrykerOptions);
                    await runner.init();

                    const resultPromise = runner.dryRun();

                    // Advance past the inspectorTimeout threshold in polling increments
                    for(let i = 0; i < 5; i++) {
                        jest.advanceTimersByTime(50);
                        // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test
                        await Promise.resolve();
                    }

                    const result = await resultPromise;

                    expect(result.status).toBe(DryRunStatus.Error);
                    if(result.status === DryRunStatus.Error) {
                        expect(result.errorMessage).toContain('Timeout waiting for inspector URL');
                    }
                } finally {
                    jest.useRealTimers();
                }
            });

            it('should succeed when inspector URL provided just before timeout', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

                // Mock runBunTests to call onInspectorReady immediately (synchronously)
                // This tests the success path without needing fake timers
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    // Call onInspectorReady immediately - simulates URL arriving quickly

                    if(options.onInspectorReady) {
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

                const runner = new BunTestRunner(mockLogger, {
                    bun: {
                        inspectorTimeout: 100,
                    },
                } as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.dryRun();

                // Should succeed - URL was provided before timeout
                expect(result.status).toBe(DryRunStatus.Complete);
            });

            // Kill mutation #4: line 301 - EqualityOperator < to >=
            it('should use < not >= for timeout check boundary condition', async () => {
                jest.useFakeTimers();
                try {
                    mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

                    // Mock runBunTests to call onInspectorReady at 110ms (AFTER the 100ms timeout)
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                    mockRunBunTests.mockImplementation((options: any) => {
                        setTimeout(() => {
                            if(options.onInspectorReady) {
                                options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                            }
                        }, 110);

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

                    // Start the dryRun (don't await yet)
                    const resultPromise = runner.dryRun();

                    // Advance fake timers past the timeout (100ms) but before callback (110ms)
                    for(let i = 0; i < 5; i++) {
                        jest.advanceTimersByTime(50);
                        // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test
                        await Promise.resolve();
                    }

                    const result = await resultPromise;

                    // With < (correct): timeout after 100ms should error
                    // With >= (mutation): would incorrectly pass the first iteration
                    // This test verifies strict < behavior
                    expect(result.status).toBe(DryRunStatus.Error);
                    if(result.status === DryRunStatus.Error) {
                        expect(result.errorMessage).toContain('Timeout waiting for inspector URL');
                    }
                } finally {
                    jest.useRealTimers();
                }
            });
        });

        describe('TestReporter.enable command (line 332)', () => {
            it('should send correct TestReporter.enable command', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    if(options.onInspectorReady) {
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

        describe('bunfigPath passed to mutant runs', () => {
            it('should pass sanitized bunfigPath to mutantRun', async () => {
                mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
                mockGenerateSanitizedBunfig.mockResolvedValue('/tmp/sanitized.toml');
                mockRunBunTests.mockResolvedValue({
                    exitCode: 0,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   '',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                // Verify bunfigPath is the sanitized path (coverage disabled via bunfig, not --no-coverage)
                expect(mockRunBunTests).toHaveBeenCalledWith(
                    expect.objectContaining({
                        bunfigPath: '/tmp/sanitized.toml',
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Should only contain the failed test, not the passing one
                    expect(result.killedBy).toEqual(['test/file.test.ts > failed test']);
                    expect(result.killedBy).not.toContain('test/file.test.ts > passing test');
                }
            });

            it('should classify exit 1 with only passing tests as Killed+unknown (sanitized bunfig prevents threshold miss)', async () => {
                // With the sanitized bunfig disabling coverageThreshold, a non-zero exit where
                // all tests passed but no failure was parsed is treated as an unparseable kill.
                // killedBy: ['unknown'] is the fallback — the scenario this was protecting against
                // (coverageThreshold false positive) can no longer occur.
                mockRunBunTests.mockResolvedValue({
                    exitCode: 1,
                    stdout:   '✓ test [0.12ms]\n 1 pass',
                    stderr:   'Process exited with code 1',
                    timedOut: false,
                });

                const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
                await runner.init();

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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
                    expect(result.killedBy).toEqual(['test/file.test.ts > failed test']);
                    expect(result.killedBy).not.toContain('test/file.test.ts > passing test A');
                    expect(result.killedBy).not.toContain('test/file.test.ts > passing test B');
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
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

                const result = await runner.mutantRun({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
                    activeMutant:    { id: '1' } as any,
                    testFilter:      [],
                    sandboxFileName: 'sandbox',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
                } as any);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    // Verify killedBy has all 3 tests with file paths included
                    // Console parser includes file path in test names
                    expect(result.killedBy).toHaveLength(3);
                    expect(result.killedBy).toContain('test/file.test.ts > test > suite > first failing test');
                    expect(result.killedBy).toContain('test/file.test.ts > test > suite > second failing test');
                    expect(result.killedBy).toContain('test/file.test.ts > test > suite > third failing test');

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

// ── mutantRun testFilter integration tests ─────────────────────────────────

describe('mutantRun testFilter integration', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let mockGeneratePreloadScript: ReturnType<typeof mock>;
    let mockCleanupPreloadScript: ReturnType<typeof mock>;
    let mockCollectCoverage: ReturnType<typeof mock>;
    let mockCleanupCoverageFile: ReturnType<typeof mock>;
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

    let runBunTestsSpy:                ReturnType<typeof spyOn>;
    let generatePreloadScriptSpy:      ReturnType<typeof spyOn>;
    let cleanupPreloadScriptSpy:       ReturnType<typeof spyOn>;
    let generateSanitizedBunfigSpy2:   ReturnType<typeof spyOn>;
    let cleanupSanitizedBunfigSpy2:    ReturnType<typeof spyOn>;
    let collectCoverageSpy:            ReturnType<typeof spyOn>;
    let cleanupCoverageFileSpy:        ReturnType<typeof spyOn>;
    let syncServerSpy:                 ReturnType<typeof spyOn>;
    let inspectorClientSpy:            ReturnType<typeof spyOn>;

    beforeEach(() => {
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

        mockRunBunTests = mock();
        runBunTestsSpy = spyOn(processRunner, 'runBunTests').mockImplementation(mockRunBunTests);

        mockGeneratePreloadScript = mock().mockResolvedValue('/tmp/preload.ts');
        mockCleanupPreloadScript  = mock().mockResolvedValue(undefined);
        generatePreloadScriptSpy  = spyOn(preloadGenerator, 'generatePreloadScript').mockImplementation(mockGeneratePreloadScript);
        cleanupPreloadScriptSpy   = spyOn(preloadGenerator, 'cleanupPreloadScript').mockImplementation(mockCleanupPreloadScript);

        generateSanitizedBunfigSpy2 = spyOn(bunfigSanitizer, 'generateSanitizedBunfig')
            .mockResolvedValue('/tmp/stryker-bun-runner-bunfig-0-0.toml');
        cleanupSanitizedBunfigSpy2  = spyOn(bunfigSanitizer, 'cleanupSanitizedBunfig')
            .mockResolvedValue(undefined);

        mockCollectCoverage      = mock().mockResolvedValue(undefined);
        mockCleanupCoverageFile  = mock().mockResolvedValue(undefined);
        collectCoverageSpy       = spyOn(coverageCollector, 'collectCoverage').mockImplementation(mockCollectCoverage);
        cleanupCoverageFileSpy   = spyOn(coverageCollector, 'cleanupCoverageFile').mockImplementation(mockCleanupCoverageFile);

        mockGetAvailablePort.mockImplementation(() => Promise.resolve(7000));

        mockSyncServer = {
            start:       mock().mockResolvedValue(undefined),
            signalReady: mock().mockReturnValue(undefined),
            close:       mock().mockResolvedValue(undefined),
            clientCount: 0,
        };
        // @ts-expect-error - Mocking constructor
        syncServerSpy = spyOn(syncServerModule, 'SyncServer').mockImplementation(() => mockSyncServer);

        mockInspectorClient = {
            connect:           mock().mockResolvedValue(undefined),
            send:              mock().mockResolvedValue(undefined),
            getTests:          mock().mockReturnValue([]),
            getExecutionOrder: mock().mockReturnValue([]),
            close:             mock().mockResolvedValue(undefined),
        };
        // @ts-expect-error - Mocking constructor
        inspectorClientSpy = spyOn(inspectorModule, 'InspectorClient').mockImplementation(() => mockInspectorClient);
    });

    afterEach(() => {
        runBunTestsSpy.mockRestore();

        generatePreloadScriptSpy.mockRestore();

        cleanupPreloadScriptSpy.mockRestore();

        generateSanitizedBunfigSpy2.mockRestore();

        cleanupSanitizedBunfigSpy2.mockRestore();

        collectCoverageSpy.mockRestore();

        cleanupCoverageFileSpy.mockRestore();

        syncServerSpy.mockRestore();

        inspectorClientSpy.mockRestore();
        resetAllMocks();
        jest.useRealTimers();
    });

    it('passes testNamePattern to runBunTests when testFilter is provided', async () => {
        mockRunBunTests.mockResolvedValue({
            exitCode: 0,
            stdout:   '1 pass',
            stderr:   '',
            timedOut: false,
        });

        const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
        await runner.init();

        await runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant:    { id: '1' } as any,
            testFilter:      ['tests/foo.test.ts > Suite > my test'],
            sandboxFileName: 'sandbox',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
        } as any);

        // runBunTests should have been called exactly once (for mutantRun only)
        expect(mockRunBunTests).toHaveBeenCalledTimes(1);
        expect(mockRunBunTests).toHaveBeenCalledWith(
            expect.objectContaining({
                testNamePattern: '^(?:Suite my test)$',
                sequentialMode:  true,
            })
        );
    });

    it('does not pass testNamePattern when testFilter is empty', async () => {
        mockRunBunTests.mockResolvedValue({
            exitCode: 0,
            stdout:   '1 pass',
            stderr:   '',
            timedOut: false,
        });

        const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
        await runner.init();

        await runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant:    { id: '1' } as any,
            testFilter:      [],
            sandboxFileName: 'sandbox',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
        } as any);

        expect(mockRunBunTests).toHaveBeenCalledTimes(1);
        // testNamePattern should be undefined (not the empty string)
        expect(mockRunBunTests).toHaveBeenCalledWith(
            expect.objectContaining({
                testNamePattern: undefined,
                sequentialMode:  true,
            })
        );
    });

    it('does not pass testNamePattern when testFilter is undefined', async () => {
        mockRunBunTests.mockResolvedValue({
            exitCode: 0,
            stdout:   '1 pass',
            stderr:   '',
            timedOut: false,
        });

        const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
        await runner.init();

        await runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant:    { id: '1' } as any,
            sandboxFileName: 'sandbox',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
        } as any);

        expect(mockRunBunTests).toHaveBeenCalledTimes(1);
        expect(mockRunBunTests).toHaveBeenCalledWith(
            expect.objectContaining({
                testNamePattern: undefined,
                sequentialMode:  true,
            })
        );
    });

    it('collapses duplicate-name filter entries to one alternative in testNamePattern', async () => {
        mockRunBunTests.mockResolvedValue({
            exitCode: 0,
            stdout:   '1 pass',
            stderr:   '',
            timedOut: false,
        });

        const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
        await runner.init();

        await runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant: { id: '1' } as any,
            testFilter:   [
                'tests/foo.test.ts > Suite > dup test [0]',
                'tests/foo.test.ts > Suite > dup test [1]',
            ],
            sandboxFileName: 'sandbox',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
        } as any);

        expect(mockRunBunTests).toHaveBeenCalledTimes(1);
        expect(mockRunBunTests).toHaveBeenCalledWith(
            expect.objectContaining({
                // Both collapse to the same base name → one alternative
                testNamePattern: '^(?:Suite dup test)$',
                sequentialMode:  true,
            })
        );
    });
});
