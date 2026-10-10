/**
 * Mutation-testing kill tests for the first half of src/bun-test-runner.ts
 * (the drain-wait helpers, init/dryRun diagnostics and the early mutantRun
 * path). Each test pins behaviour a Stryker mutant of the runner changed
 * without any other test noticing; they live here, apart from
 * bun-test-runner.test.ts, only to keep that file's diff small. The mock
 * setup in the outer describe is the same as that file's.
 */

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, type DryRunOptions } from '@stryker-mutator/api/test-runner';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import * as coverageCollector from '../../src/coverage/collector.js';
import * as coverageMapper from '../../src/coverage/coverage-mapper.js';
import * as preloadGenerator from '../../src/coverage/preload-generator.js';
import * as inspectorModule from '../../src/inspector/inspector-client.js';
import type { TestInfo } from '../../src/inspector/types.js';
import * as processRunner from '../../src/process-runner.js';
import * as bunVersion from '../../src/utils/bun-version.js';
import * as bunfigSanitizer from '../../src/utils/bunfig-sanitizer.js';
import * as privateTempDir from '../../src/utils/private-temp-dir.js';
import * as syncServerModule from '../../src/utils/sync-server.js';
import * as testFileDiscovery from '../../src/utils/test-file-discovery.js';
import { mockGetAvailablePort, mockRename, mockWriteFile, resetAllMocks } from '../test-preload.js';

/**
 * Mirrors the run's private temp directory formula (src/utils/private-temp-dir.ts
 * runTempDirPrefix, first slot of resolveRunTempDir) independently, so tests assert
 * against the real directory the runner uses without calling the code under test to
 * compute the expectation.
 */
function expectedRunTempDir(cwd: string = process.cwd(), ppid: number = process.ppid, baseDir: string = tmpdir()): string {
    const hash = createHash('sha256').update(`${cwd}:${ppid}`).digest('hex').slice(0, 16);
    return path.join(baseDir, `stryker-bun-runner-${process.getuid!()}-${hash}-0`);
}

/**
 * Mirrors BunTestRunner's private `resolveRegistryPath` formula exactly, so tests
 * can assert against the real file the runner reads/writes without hard-coding a
 * path the production code doesn't actually derive. Keep in sync with
 * src/bun-test-runner.ts's resolveRegistryPath.
 */
function expectedRegistryPath(cwd: string = process.cwd(), ppid: number = process.ppid): string {
    return path.join(expectedRunTempDir(cwd, ppid), 'registry.json');
}

describe('BunTestRunner mutation kill tests (first half of the runner)', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let mockCollectCoverage: ReturnType<typeof mock>;
    let mockCollectLateHits: ReturnType<typeof mock>;
    let mockCleanupCoverageFile: ReturnType<typeof mock>;
    let mockGeneratePreloadScript: ReturnType<typeof mock>;
    let mockCleanupPreloadScript: ReturnType<typeof mock>;
    let mockGenerateSanitizedBunfig: ReturnType<typeof mock>;
    let mockCleanupSanitizedBunfig: ReturnType<typeof mock>;
    let mockSyncServer: {
        start:           ReturnType<typeof mock>
        signalReady:     ReturnType<typeof mock>
        setDrainHandler: ReturnType<typeof mock>
        close:           ReturnType<typeof mock>
        clientCount:     number
    };
    let mockInspectorClient: {
        connect:                  ReturnType<typeof mock>
        send:                     ReturnType<typeof mock>
        getTests:                 ReturnType<typeof mock>
        getExecutionOrder:        ReturnType<typeof mock>
        close:                    ReturnType<typeof mock>
        expectClose:              ReturnType<typeof mock>
        waitForClose:             ReturnType<typeof mock>
        wasClosedUnexpectedly:    boolean
        getMsSinceLastFrame:      ReturnType<typeof mock>
        getFoundIdGaps:           ReturnType<typeof mock>
        getEventCounts:           ReturnType<typeof mock>
        getCloseInfo:             ReturnType<typeof mock>
        getFoundIdCollisionStats: ReturnType<typeof mock>
    };
    let mockMapCoverageToInspectorIds: ReturnType<typeof mock>;

    // Store spy instances for cleanup in afterEach
    let runBunTestsSpy: ReturnType<typeof spyOn>;
    let collectCoverageSpy: ReturnType<typeof spyOn>;
    let collectLateHitsSpy: ReturnType<typeof spyOn>;
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
    let checkBunVersionSpy: ReturnType<typeof spyOn>;
    let ensurePrivateDirSpy: ReturnType<typeof spyOn>;
    let resolveRunTempDirSpy: ReturnType<typeof spyOn>;
    let writePrivateFileSpy: ReturnType<typeof spyOn>;

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
        mockCollectLateHits = mock().mockResolvedValue([]);
        mockCleanupCoverageFile = mock();
        collectCoverageSpy = spyOn(coverageCollector, 'collectCoverage').mockImplementation(mockCollectCoverage);
        collectLateHitsSpy = spyOn(coverageCollector, 'collectLateHits').mockImplementation(mockCollectLateHits);
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
            start:           mock(),
            signalReady:     mock(),
            setDrainHandler: mock(),
            close:           mock(),
            clientCount:     0,
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        syncServerSpy = spyOn(syncServerModule, 'SyncServer').mockImplementation(() => mockSyncServer);

        // Mock inspector client
        mockInspectorClient = {
            connect:                  mock(),
            send:                     mock(),
            getTests:                 mock(),
            getExecutionOrder:        mock(),
            close:                    mock(),
            expectClose:              mock(),
            waitForClose:             mock(),
            wasClosedUnexpectedly:    false,
            getMsSinceLastFrame:      mock().mockReturnValue(0),
            getFoundIdGaps:           mock().mockReturnValue([]),
            getEventCounts:           mock().mockReturnValue({ found: 0, start: 0, end: 0 }),
            getCloseInfo:             mock().mockReturnValue({ code: undefined, reason: undefined, wasClean: undefined, msFromLastFrameToClose: undefined }),
            getFoundIdCollisionStats: mock().mockReturnValue({ rawFoundCount: 0, uniqueFoundIdCount: 0, duplicateFoundIdCount: 0 }),
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        inspectorClientSpy = spyOn(inspectorModule, 'InspectorClient').mockImplementation(() => mockInspectorClient);

        // Mock coverage mapper
        mockMapCoverageToInspectorIds = mock();
        mapCoverageToInspectorIdsSpy = spyOn(coverageMapper, 'mapCoverageToInspectorIds').mockImplementation(mockMapCoverageToInspectorIds);
        // Default: wrap coverage in the new { coverage, inspectorIdToProjectFile, counterKeyToTestName, rawKeyCount, orphanedKeyCount } shape (tests can override if needed)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional pass-through mock
        mockMapCoverageToInspectorIds.mockImplementation((coverage: any) => ({ coverage, inspectorIdToProjectFile: new Map(), counterKeyToTestName: new Map(), rawKeyCount: 0, orphanedKeyCount: 0 }));

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
        mockInspectorClient.expectClose.mockReturnValue(undefined);
        mockInspectorClient.waitForClose.mockResolvedValue(undefined);
        mockInspectorClient.wasClosedUnexpectedly = false;

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

        // Mock the startup `bun --version` check so init() neither needs a real bun on
        // PATH nor pays a process spawn per test. Tests of the check itself override this.
        checkBunVersionSpy = spyOn(bunVersion, 'checkBunVersion').mockResolvedValue('1.4.2');

        // The private temp directory's checks are real-fs syscalls (stat/mkdir/lstat/rm),
        // which hang under fake timers just like the writes above. Unit tests here see
        // the directory as already verified, and private writes go through the
        // (controllable) mocked writeFile with the same flags. The real behaviour is
        // covered by tests/unit/private-temp-dir.test.ts and by the 'private temp
        // directory (real fs)' tests below, which restore these spies.
        ensurePrivateDirSpy = spyOn(privateTempDir, 'ensurePrivateDir').mockImplementation((dir: string) => Promise.resolve(dir));
        // The run directory resolves to its first slot, derived from the cwd and ppid at call time.
        resolveRunTempDirSpy = spyOn(privateTempDir, 'resolveRunTempDir').mockImplementation(
            (key: privateTempDir.RunTempDirKey = {}) => Promise.resolve(expectedRunTempDir(key.cwd ?? process.cwd(), key.ppid ?? process.ppid))
        );
        writePrivateFileSpy = spyOn(privateTempDir, 'writePrivateFile').mockImplementation(
            (file: string, data: string) => fsPromises.writeFile(file, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        );
    });

    afterEach(async () => {
        // Restore all spies to prevent test pollution

        runBunTestsSpy.mockRestore();

        collectCoverageSpy.mockRestore();

        collectLateHitsSpy.mockRestore();

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

        checkBunVersionSpy.mockRestore();

        ensurePrivateDirSpy.mockRestore();

        resolveRunTempDirSpy.mockRestore();

        writePrivateFileSpy.mockRestore();

        // Safety net for ad-hoc spies created inline within individual test bodies
        jest.restoreAllMocks();

        // Reset preload mocks and timers
        resetAllMocks();
        jest.useRealTimers();

        // Clean up the registry file that dryRun writes to the OS temp directory.
        // This is scoped to this file's afterEach so it doesn't pollute other test files.
        // Uses the real process.cwd()/process.ppid — same as the production getter — so
        // this cleans up even for tests that don't override either.
        const registryPath = expectedRegistryPath();
        await fsPromises.rm(registryPath, { force: true });
        await fsPromises.rm(`${registryPath}.tmp`, { force: true });
    });

    // ---------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------

    /** The argument lists of every call a mocked logger method received. */
    const callsOf = (logFn: unknown): unknown[][] => (logFn as ReturnType<typeof mock>).mock.calls as unknown[][];

    /** The calls to a logger method whose format string contains `needle`. */
    const callsMatching = (logFn: unknown, needle: string): unknown[][] =>
        callsOf(logFn).filter(args => String(args[0]).includes(needle));

    interface ChildOutcome {
        exitCode?:            number | null
        stdout?:              string
        stderr?:              string
        timedOut?:            boolean
        memoryLimitExceeded?: boolean
    }

    /**
     * Make the mocked `bun test` child report its inspector URL and then exit with
     * `outcome`. Defaults describe a clean one-test run.
     */
    function mockChild(outcome: ChildOutcome = {}): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
        mockRunBunTests.mockImplementation((options: any) => {
            options.onInspectorReady?.('ws://127.0.0.1:6499/inspector');
            return Promise.resolve({
                exitCode: 0,
                stdout:   '✓ test [0.12ms]\n 1 pass',
                stderr:   '',
                timedOut: false,
                ...outcome,
            });
        });
    }

    /** One passing test in the inspector's data, with coverage that covers a mutant. */
    function mockHealthyInspectorRun(): void {
        mockCollectCoverage.mockResolvedValue({ perTest: {}, 'static': { '1': 1 } });
        mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
        mockInspectorClient.getTests.mockReturnValue([{
            id:       1,
            name:     'test',
            fullName: 'test',
            status:   'pass',
            url:      '/project/tests/test.ts',
        }]);
    }

    async function initRunner(options: Record<string, unknown> = {}): Promise<BunTestRunner> {
        const runner = new BunTestRunner(mockLogger, options as unknown as StrykerOptions);
        await runner.init();
        return runner;
    }

    /** Run one dry run on a freshly initialised runner. */
    async function dryRunOnce(options: Record<string, unknown> = {}, dryRunOptions?: Partial<DryRunOptions>): ReturnType<BunTestRunner['dryRun']> {
        const runner = await initRunner(options);
        return runner.dryRun(dryRunOptions as DryRunOptions | undefined);
    }

    /** One mutant run with the given testFilter. */
    async function mutantRunOnce(runner: BunTestRunner, testFilter: string[] = []): ReturnType<BunTestRunner['mutantRun']> {
        return runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant:    { id: '7' } as any,
            testFilter,
            sandboxFileName: 'sandbox',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
        } as any);
    }

    // ---------------------------------------------------------------------
    // init: debug diagnostics and the dropped-bunfig-key warning
    // ---------------------------------------------------------------------

    describe('init diagnostics', () => {
        it('logs how many eager modules the mutate globs resolved to', async () => {
            resolveEagerModulesFromGlobsSpy.mockResolvedValue(['/p/src/a.ts', '/p/src/b.ts']);

            await initRunner({ mutate: ['src/**/*.ts'] });

            expect(mockLogger.debug).toHaveBeenCalledWith('Resolved %d eager modules from mutate globs', 2);
        });

        it('logs where the sanitized bunfig was generated and for which cwd', async () => {
            await initRunner();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Sanitized bunfig (re)generated at: %s for cwd: %s',
                '/tmp/stryker-bun-runner-bunfig-0-0.toml',
                process.cwd()
            );
        });

        describe('warning about bunfig settings ignored for mutation runs', () => {
            interface Drop { key: string, reason: string, warn: boolean }

            function reportDrops(drops: Drop[]): void {
                mockGenerateSanitizedBunfig.mockImplementation((_cwd: string, _tmp: string, _src: string | undefined, onDropped?: (drops: Drop[]) => void) => {
                    onDropped?.(drops);
                    return Promise.resolve('/tmp/sanitized.toml');
                });
            }

            it('lists one "- key: it reason" line per ignored setting, newline-separated', async () => {
                reportDrops([
                    { key: 'test.retry', reason: 'RETRY-REASON', warn: true },
                    { key: 'test.rerunEach', reason: 'RERUN-REASON', warn: true },
                ]);

                await initRunner();

                const [message] = callsOf(mockLogger.warn)[0];
                expect(String(message).endsWith(':\n  - %s: it %s\n  - %s: it %s')).toBe(true);
            });

            it('rewrites only the leading "test." table prefix of a key for display', async () => {
                reportDrops([{ key: 'nested.test.retry', reason: 'R', warn: true }]);

                await initRunner();

                expect(callsOf(mockLogger.warn)[0].slice(1)).toEqual(['nested.test.retry', 'R']);
            });
        });
    });

    // ---------------------------------------------------------------------
    // Constructor / test-file selection
    // ---------------------------------------------------------------------

    describe('test file selection', () => {
        it('hands bun.testFiles to the dry run verbatim, without discovering', async () => {
            mockChild();
            mockHealthyInspectorRun();
            discoverTestFilesSpy.mockClear();

            await dryRunOnce({ bun: { testFiles: ['only/this.test.ts'] } });

            expect(mockRunBunTests.mock.calls[0][0].testFiles).toEqual(['only/this.test.ts']);
            expect(discoverTestFilesSpy).not.toHaveBeenCalled();
        });

        it('warns that Stryker\'s testFiles replace bun.testFiles when the two sets overlap but differ', async () => {
            // Same size, one shared file: a "some file in common" comparison would call them equal.
            mockChild();
            mockHealthyInspectorRun();
            const cwd = process.cwd();

            await dryRunOnce(
                { bun: { testFiles: ['tests/alpha.test.ts', 'tests/beta.test.ts'] } },
                { testFiles: [path.join(cwd, 'tests/alpha.test.ts'), path.join(cwd, 'tests/gamma.test.ts')] }
            );

            expect(callsMatching(mockLogger.warn, 'takes precedence')).toHaveLength(1);
        });

        it('does not narrow a run for an id with no file separator even when dropping its last character names a discovered file', async () => {
            // 'tests/alpha.test.tsx'.slice(0, -1) is a discovered file; the id is nonetheless not file-qualified.
            mockChild();
            const runner = await initRunner();
            mockRunBunTests.mockClear();

            await mutantRunOnce(runner, ['tests/alpha.test.tsx']);

            expect(mockRunBunTests.mock.calls[0][0].testFiles).toEqual(['tests/alpha.test.ts', 'tests/beta.test.ts']);
        });

        it('names at most three build-output test files in the dist/build warning, with an ellipsis for the rest', async () => {
            discoverTestFilesSpy.mockResolvedValue([
                'dist/a.test.js', 'dist/b.test.js', 'build/c.test.js', 'build/d.test.js', 'dist/e.test.js', 'src/ok.test.ts',
            ]);

            await initRunner();

            const [warning] = callsMatching(mockLogger.warn, '"dist" or "build"');
            expect(warning.slice(1)).toEqual([5, 'dist/a.test.js, dist/b.test.js, build/c.test.js', ', …']);
        });
    });

    // ---------------------------------------------------------------------
    // dryRun: startup failures and logging
    // ---------------------------------------------------------------------

    describe('dryRun start-up', () => {
        it('logs the inspector and sync ports it picked', async () => {
            mockChild();
            mockHealthyInspectorRun();

            await dryRunOnce();

            expect(mockLogger.debug).toHaveBeenCalledWith('Using inspector port: %d, sync port: %d', 6499, 6500);
        });

        it('logs the error when the sync server cannot start, and reports it', async () => {
            mockSyncServer.start.mockRejectedValue(new Error('EADDRINUSE'));

            const result = await dryRunOnce();

            expect(result).toEqual({ status: DryRunStatus.Error, errorMessage: 'Failed to start sync server: EADDRINUSE' });
            expect(mockLogger.error).toHaveBeenCalledWith('Failed to start sync server: %s', 'EADDRINUSE');
        });

        it('logs the child\'s exit status and output head when no inspector URL ever appeared', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((_options: any) => Promise.resolve({
                exitCode: 1,
                stdout:   'the stdout',
                stderr:   '',
                timedOut: false,
            }));

            const result = await dryRunOnce();

            expect(result.status).toBe(DryRunStatus.Error);
            const [errorLog] = callsMatching(mockLogger.error, 'Failed to get inspector URL within timeout (%dms)');
            expect(errorLog.slice(1)).toEqual([5000, '1', 'false', 'the stdout', '(empty)']);
        });

        describe('when the inspector connection fails', () => {
            it('logs the failure and aborts the child before closing the inspector', async () => {
                let signal: AbortSignal | undefined;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
                mockRunBunTests.mockImplementation((options: any) => {
                    signal = options.signal as AbortSignal;
                    options.onInspectorReady?.('ws://127.0.0.1:6499/inspector');
                    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
                });
                mockInspectorClient.connect.mockRejectedValue(new Error('refused'));
                let abortedWhenClosing: boolean | undefined;
                mockInspectorClient.close.mockImplementation(() => {
                    abortedWhenClosing = signal?.aborted;
                    return Promise.resolve();
                });

                const result = await dryRunOnce();

                expect(result).toEqual({ status: DryRunStatus.Error, errorMessage: 'Failed to connect to Bun inspector: refused' });
                expect(mockLogger.error).toHaveBeenCalledWith('Failed to connect inspector: %s', 'refused');
                expect(abortedWhenClosing).toBe(true);
            });
        });

        it('always aborts the child\'s signal once the dry run is over', async () => {
            let signal: AbortSignal | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
            mockRunBunTests.mockImplementation((options: any) => {
                signal = options.signal as AbortSignal;
                options.onInspectorReady?.('ws://127.0.0.1:6499/inspector');
                return Promise.resolve({ exitCode: 0, stdout: '✓ test [0.12ms]\n 1 pass', stderr: '', timedOut: false });
            });
            mockHealthyInspectorRun();

            const result = await dryRunOnce();

            expect(result.status).toBe(DryRunStatus.Complete);
            expect(signal?.aborted).toBe(true);
        });
    });

    // ---------------------------------------------------------------------
    // dryRun: the drain handshake's give-up paths
    // ---------------------------------------------------------------------

    describe('drain handler give-up', () => {
        /** Run a dry run to completion and hand back the drain handler it registered. */
        async function registeredDrainHandler(): Promise<() => Promise<void>> {
            mockChild();
            mockHealthyInspectorRun();
            await dryRunOnce();
            return mockSyncServer.setDrainHandler.mock.calls[0][0] as () => Promise<void>;
        }

        /** The args of the one 'Drain handler settled' debug line. */
        function settledLog(): unknown[] {
            const settled = callsMatching(mockLogger.debug, 'Drain handler settled via %s');
            expect(settled).toHaveLength(1);
            return settled[0];
        }

        /**
         * Start the handler under fake timers with a send() that never answers, jump the
         * clock `elapsedMs` ahead (Date.now is faked in lockstep), let one poll tick fire,
         * and report how many timers the handler left pending afterwards.
         */
        async function giveUp(elapsedMs: number, msSinceLastFrame: number): Promise<{ leftoverTimers: number }> {
            const drainHandler = await registeredDrainHandler();
            mockLogger.debug = mock();
            jest.useFakeTimers();
            let fakeNow = Date.now();
            const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
            try {
                mockInspectorClient.send.mockImplementation(() => new Promise(() => {}));
                mockInspectorClient.getMsSinceLastFrame.mockReturnValue(msSinceLastFrame);
                const timersBefore = jest.getTimerCount();
                const drainPromise = drainHandler();
                fakeNow += elapsedMs;
                jest.advanceTimersByTime(250);
                await drainPromise;
                return { leftoverTimers: jest.getTimerCount() - timersBefore };
            } finally {
                dateNowSpy.mockRestore();
                jest.useRealTimers();
            }
        }

        it('on silence: logs the observed silence, the elapsed time, and leaves no timer behind', async () => {
            const { leftoverTimers } = await giveUp(4250, 4321);

            expect(callsMatching(mockLogger.debug, 'Inspector drain wait gave up')).toEqual([
                ['Inspector drain wait gave up: %s', '4321ms of inspector silence (limit 4000ms)'],
            ]);
            const settled = settledLog();
            expect(settled[1]).toBe('silence');
            expect(settled[2]).toBe(4250);
            expect(leftoverTimers).toBe(0);
        });

        it('on the absolute ceiling: logs the ceiling, the elapsed time, and leaves no timer behind', async () => {
            const { leftoverTimers } = await giveUp(30_000, 50);

            expect(callsMatching(mockLogger.debug, 'Inspector drain wait gave up')).toEqual([
                ['Inspector drain wait gave up: %s', '30000ms absolute ceiling reached'],
            ]);
            const settled = settledLog();
            expect(settled[1]).toBe('ceiling');
            expect(settled[2]).toBe(30_000);
            expect(leftoverTimers).toBe(0);
        });

        it('does not claim a wait bound fired when the round-trip itself was rejected', async () => {
            const drainHandler = await registeredDrainHandler();
            mockInspectorClient.send.mockRejectedValue(new Error('socket exploded'));

            await drainHandler();

            expect(callsMatching(mockLogger.debug, 'Inspector drain wait gave up')).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------
    // dryRun: post-drain diagnostics
    // ---------------------------------------------------------------------

    describe('post-drain diagnostics', () => {
        it('explains the found-event counts and why the gap count alone cannot prove losslessness', async () => {
            mockChild();
            mockHealthyInspectorRun();

            await dryRunOnce();

            const [diagnostics] = callsMatching(mockLogger.debug, 'Post-drain inspector close/collision diagnostics');
            const format = String(diagnostics[0]);
            expect(format).toContain('found events %d raw / %d unique id(s) / %d duplicate id event(s)');
            expect(format).toContain('(nonzero duplicates = direct evidence of the Bun TestReporter id-collision bug; ');
            expect(format).toContain('the found-id-gap count above is density-only — it does NOT prove losslessness under collisions)');
        });

        it('joins several abnormal-drain problems with "; " in the single warn', async () => {
            mockChild();
            mockHealthyInspectorRun();
            // The handler is never invoked (so the handshake "never requested") and two gaps remain.
            mockInspectorClient.getFoundIdGaps.mockReturnValue([3, 4]);

            await dryRunOnce();

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Inspector data looks abnormal after the dry run: %s — test results may be incomplete; enable debug logging for the full drain/close/collision diagnostics',
                'drain handshake never requested; 2 found-id gap(s) remaining [3,4]'
            );
        });

        it('logs how many test names it cached for killedBy resolution', async () => {
            mockChild();
            mockHealthyInspectorRun();

            await dryRunOnce();

            expect(mockLogger.debug).toHaveBeenCalledWith('Cached %d test names from dry run for killedBy resolution', 1);
        });

        it('logs where it wrote the registry and how many entries it holds', async () => {
            mockChild();
            mockHealthyInspectorRun();

            await dryRunOnce();

            expect(mockLogger.debug).toHaveBeenCalledWith('Wrote dryRun registry to %s (%d entries)', expectedRegistryPath(), 1);
        });
    });

    // ---------------------------------------------------------------------
    // dryRun: coverage diagnostics
    // ---------------------------------------------------------------------

    describe('coverage diagnostics', () => {
        const preloadLine = (n: number): string => `[Stryker Coverage] problem ${n}`;

        it('carries at most the first 20 preload diagnostics into the warn on a run with coverage', async () => {
            mockChild({ stderr: Array.from({ length: 25 }, (_, i) => `  ${preloadLine(i)}  `).join('\n') });
            mockHealthyInspectorRun();

            await dryRunOnce();

            const [warning] = callsMatching(mockLogger.warn, 'The coverage preload reported problems');
            expect(warning[1]).toBe(Array.from({ length: 20 }, (_, i) => preloadLine(i)).join('\n'));
        });

        it('names every mutate glob, comma-separated, when no mutant is covered', async () => {
            mockChild();
            mockHealthyInspectorRun();
            mockCollectCoverage.mockResolvedValue({ perTest: {}, 'static': {} });

            await dryRunOnce({ mutate: ['src/a.ts', 'src/b.ts'] });

            const [warning] = callsMatching(mockLogger.warn, 'shows no mutant covered by any test');
            expect(warning[1]).toBe('src/a.ts, src/b.ts');
        });

        it('says "(none)" when there are no mutate globs and no mutant is covered', async () => {
            mockChild();
            mockHealthyInspectorRun();
            mockCollectCoverage.mockResolvedValue({ perTest: {}, 'static': {} });

            await dryRunOnce();

            const [warning] = callsMatching(mockLogger.warn, 'shows no mutant covered by any test');
            expect(warning[1]).toBe('(none)');
        });

        it('says no coverage file was configured when the runner was never initialised', async () => {
            mockChild();
            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockInspectorClient.getTests.mockReturnValue([{ id: 1, name: 'test', fullName: 'test', status: 'pass', url: '/project/tests/test.ts' }]);
            const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

            const result = await runner.dryRun({ coverageAnalysis: 'perTest' } as DryRunOptions);

            expect(result.status).toBe(DryRunStatus.Error);
            if(result.status === DryRunStatus.Error) {
                expect(result.errorMessage).toContain('the coverage file (none configured) was missing, unreadable or empty. ');
            }
        });

        it('separates the sentences of the missing-coverage error with spaces and lists preload diagnostics one per line', async () => {
            mockChild({ stderr: `${preloadLine(1)}\n${preloadLine(2)}\n` });
            mockCollectCoverage.mockResolvedValue(undefined);
            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockInspectorClient.getTests.mockReturnValue([{ id: 1, name: 'test', fullName: 'test', status: 'pass', url: '/project/tests/test.ts' }]);

            const result = await dryRunOnce({}, { coverageAnalysis: 'perTest' });

            expect(result.status).toBe(DryRunStatus.Error);
            if(result.status === DryRunStatus.Error) {
                expect(result.errorMessage).toContain(
                    'process.exit). Failing the dry run because coverageAnalysis is \'perTest\'; '
                    + 'set coverageAnalysis to \'all\' or \'off\' to run without per-test coverage instead. '
                    + `Coverage preload diagnostics from the child's stderr:\n${preloadLine(1)}\n${preloadLine(2)}`
                );
            }
        });
    });

    // ---------------------------------------------------------------------
    // dryRun: process outcomes
    // ---------------------------------------------------------------------

    describe('dry-run process outcomes', () => {
        const timeoutWarnings = (): unknown[][] => callsMatching(mockLogger.warn, 'Dry run timed out');

        it('warns about bun.timeout when the child timed out', async () => {
            mockChild({ exitCode: null, timedOut: true });

            const result = await dryRunOnce({ bun: { timeout: 7000 } });

            expect(result.status).toBe(DryRunStatus.Timeout);
            expect(timeoutWarnings()).toHaveLength(1);
            expect(timeoutWarnings()[0].slice(1)).toEqual([7000, 37_000]);
        });

        it('does not add the bun.timeout warning when the child was killed for exceeding maxChildRss', async () => {
            mockChild({ exitCode: null, timedOut: true, memoryLimitExceeded: true });

            const result = await dryRunOnce({ bun: { timeout: 7000 } });

            expect(result.status).toBe(DryRunStatus.Timeout);
            expect(timeoutWarnings()).toEqual([]);
        });

        describe('failed tests named in the error for a crashed run', () => {
            const failedTest = (n: number): TestInfo => ({
                id:       n,
                name:     `t${n}`,
                fullName: `S > t${n}`,
                type:     'test',
                status:   'fail',
                error:    { message: `m${n}`, stack: 'Error: boom\n    at a:1\n    at b:2' },
            });

            async function crashedRunWith(failures: number): Promise<string> {
                mockChild({ exitCode: 1, stdout: '' });
                mockInspectorClient.getTests.mockReturnValue(Array.from({ length: failures }, (_, i) => failedTest(i + 1)));
                mockInspectorClient.getExecutionOrder.mockReturnValue(Array.from({ length: failures }, (_, i) => i + 1));
                const result = await dryRunOnce();
                expect(result.status).toBe(DryRunStatus.Error);
                return result.status === DryRunStatus.Error ? String(result.errorMessage) : '';
            }

            it('indents every line of a stack under its test', async () => {
                const message = await crashedRunWith(1);

                expect(message).toContain('\n  - S > t1: m1\n    Error: boom\n        at a:1\n        at b:2');
            });

            it('says nothing about further failures when exactly the listing cap failed', async () => {
                const message = await crashedRunWith(20);

                expect(message).toContain('20 test(s) reported failed');
                expect(message).not.toContain('...and');
            });

            it('counts the failures beyond the listing cap', async () => {
                const message = await crashedRunWith(22);

                expect(message).toContain('22 test(s) reported failed');
                expect(message).toContain('\n  ...and 2 more');
            });
        });
    });

    // ---------------------------------------------------------------------
    // dryRun: warning when bun reports a failure no test accounts for
    // ---------------------------------------------------------------------

    describe('unidentified dry-run failure warning', () => {
        const passingInspectorTest: TestInfo = { id: 1, name: 'test', fullName: 'test', type: 'test', status: 'pass', url: '/project/tests/test.ts' };
        const unidentifiedWarnings = (): unknown[][] => callsMatching(mockLogger.warn, 'no failing test could be identified');

        beforeEach(() => {
            mockInspectorClient.getTests.mockReturnValue([passingInspectorTest]);
            mockInspectorClient.getExecutionOrder.mockReturnValue([1]);
            mockCollectCoverage.mockResolvedValue({ perTest: {}, 'static': { '1': 1 } });
        });

        // A "(fail)" line with no matching inspector test and no bun summary count: the dry run still
        // completes (the completeness gate only trusts bun's summary), so the warning is all there is.
        const failLineOnly = '(fail) something else entirely [1.00ms]\n';

        it('warns with the exit code, the failure count and the last 500 characters of stderr', async () => {
            mockChild({ exitCode: 1, stdout: failLineOnly, stderr: `head-${'x'.repeat(600)}tail` });

            const result = await dryRunOnce();

            expect(result.status).toBe(DryRunStatus.Complete);
            expect(unidentifiedWarnings()).toHaveLength(1);
            expect(unidentifiedWarnings()[0].slice(1)).toEqual(['1', 1, `${'x'.repeat(496)}tail`]);
        });

        it('warns on a reported failure even when bun exited 0', async () => {
            mockChild({ exitCode: 0, stdout: failLineOnly });

            await dryRunOnce();

            expect(unidentifiedWarnings()).toHaveLength(1);
            expect(unidentifiedWarnings()[0][1]).toBe('0');
        });

        it('does not warn when a built test is Failed, even if other tests passed', async () => {
            mockChild({ exitCode: 1, stdout: failLineOnly });
            mockInspectorClient.getTests.mockReturnValue([
                passingInspectorTest,
                { id: 2, name: 'broken', fullName: 'broken', type: 'test', status: 'fail', url: '/project/tests/test.ts' },
            ]);
            mockInspectorClient.getExecutionOrder.mockReturnValue([1, 2]);

            const result = await dryRunOnce();

            expect(result.status).toBe(DryRunStatus.Complete);
            expect(unidentifiedWarnings()).toEqual([]);
        });

        it('does not warn when bun exited 0 and reported no failure', async () => {
            mockChild({ exitCode: 0, stdout: '✓ test [0.12ms]\n 1 pass' });

            await dryRunOnce();

            expect(unidentifiedWarnings()).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------
    // mutantRun
    // ---------------------------------------------------------------------

    describe('mutantRun diagnostics', () => {
        beforeEach(() => {
            mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
        });

        describe('failure reported outside any single test', () => {
            it('logs the failure and error counts and still scores Killed', async () => {
                mockChild({ exitCode: 1, stdout: '', stderr: ' 0 pass\n 3 fail\n 2 error\nRan 3 tests across 1 file.' });
                const runner = await initRunner();

                const result = await mutantRunOnce(runner);

                expect(result.status).toBe(MutantRunStatus.Killed);
                expect(mockLogger.debug).toHaveBeenCalledWith(
                    'Mutant %s: bun reported %d failure(s) and %d error(s) outside any single test (e.g. a test file that failed to load) — scoring Killed',
                    '7', 3, 2
                );
            });
        });

        describe('Killed result', () => {
            it('reports the number of tests bun ran', async () => {
                mockChild({ exitCode: 1, stdout: '(fail) a broke [1.00ms]\n(pass) b ok [1.00ms]\n(pass) c ok [1.00ms]\n 2 pass\n 1 fail\n' });
                const runner = await initRunner();

                const result = await mutantRunOnce(runner);

                expect(result.status).toBe(MutantRunStatus.Killed);
                if(result.status === MutantRunStatus.Killed) {
                    expect(result.nrOfTests).toBe(3);
                }
            });
        });

        describe('--test-name-pattern matching nothing with no covering tests to retry', () => {
            const longStderr = `error: regex "x" matched 0 tests. ${'S'.repeat(700)}`;

            it('quotes the first 200 characters of stderr in the warning and the first 500 in the error', async () => {
                mockChild({ exitCode: 1, stdout: '', stderr: longStderr });
                const runner = await initRunner();

                const result = await mutantRunOnce(runner);

                expect(result.status).toBe(MutantRunStatus.Error);
                const [warning] = callsMatching(mockLogger.warn, 'no covering tests left to retry');
                expect(warning[2]).toBe(longStderr.slice(0, 200));
                if(result.status === MutantRunStatus.Error) {
                    expect(result.errorMessage.endsWith(`this mutant (runner pattern gap or mutant-changed interpolated title — not a kill): ${longStderr.slice(0, 500)}`)).toBe(true);
                }
            });
        });

        describe('testFilter holding test file paths', () => {
            let sandboxDir: string;

            beforeEach(async () => {
                sandboxDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'stryker-survivors-a-'));
                await Bun.write(path.join(sandboxDir, 'one.test.ts'), '');
                await Bun.write(path.join(sandboxDir, 'two.test.ts'), '');
            });

            afterEach(async () => {
                await fsPromises.rm(sandboxDir, { recursive: true, force: true });
            });

            it('logs how many file paths it ran', async () => {
                mockChild({ stdout: ' 1 pass\n' });
                const runner = await initRunner();

                await mutantRunOnce(runner, [path.join(sandboxDir, 'one.test.ts'), path.join(sandboxDir, 'two.test.ts')]);

                expect(mockLogger.debug).toHaveBeenCalledWith(
                    'Mutant %s: testFilter holds %d test file path(s) (Stryker\'s testFiles option); running those files without a --test-name-pattern',
                    '7', 2
                );
            });
        });
    });
});
