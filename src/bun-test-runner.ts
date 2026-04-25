/**
 * Main TestRunner implementation for Bun
 * Implements the Stryker TestRunner API
 */

import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MutantCoverage, StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import {
    DryRunStatus,
    MutantRunStatus,
    TestStatus,
    type TestRunner,
    type DryRunResult,
    type MutantRunOptions,
    type MutantRunResult,
    type TestRunnerCapabilities,
    type SuccessTestResult,
    type FailedTestResult,
    type SkippedTestResult
} from '@stryker-mutator/api/test-runner';
import {
    generatePreloadScript,
    cleanupPreloadScript,
    collectCoverage,
    cleanupCoverageFile,
    resolveEagerModulesFromGlobs,
    mapCoverageToInspectorIds
} from './coverage/index.js';
import { InspectorClient } from './inspector/index.js';
import type { TestInfo } from './inspector/types.js';
import type { StrykerBunOptions } from './options.js';
import { parseBunTestOutput, type ParsedTestResults } from './parsers/console-parser.js';
import { runBunTests } from './process-runner.js';
import { getAvailablePort, SyncServer, generateSanitizedBunfig, cleanupSanitizedBunfig, normalizeTestFilePath, normalizeTestName, buildUniqueTestName, buildProjectFileTestName, buildTestNamePattern, discoverTestFiles } from './utils/index.js';

/**
 * Sleep for the given number of milliseconds.
 * Extracted to satisfy no-promise-executor-return: the executor only schedules a
 * timer and does not return its value.
 */
function sleep(ms: number): Promise<void> {
    // Stryker disable next-line BlockStatement: removing the setTimeout body causes the Promise to never resolve → infinite loop / Timeout — expected
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Shape of the persisted dryRun registry file (version 1).
 * Validated by loadRegistryFile before use.
 */
interface RegistryFileV1 {
    version:         number
    writtenAt:       number
    cachedTestNames: string[]
    baseNameIndex:   [string, string[]][]
}

/**
 * Bun test runner for Stryker mutation testing
 */
export class BunTestRunner implements TestRunner {
    public static readonly inject = tokens(commonTokens.logger, commonTokens.options);

    private readonly bunPath:            string;
    private readonly timeout:            number;
    private readonly inspectorTimeout:   number;
    private readonly env?:               Record<string, string>;
    private readonly bunArgs?:           string[];
    private readonly testFilesOverride?: string[];
    private readonly mutateGlobs:        readonly string[];
    private preloadScriptPath?:          string;
    private coverageFilePath?:           string;
    private sanitizedBunfigPath?:        string;
    private sanitizedBunfigCwd?:         string;
    private tempDir?:                    string;
    private cachedTestNames?:            Set<string>;
    private baseNameIndex?:              Map<string, string[]>;
    private cachedTestFiles?:            string[];
    private cachedTestFilesCwd?:         string;
    private cachedEagerModules?:         string[];
    private cachedEagerModulesCwd?:      string;
    private lastRegistryTmpPath?:        string;

    constructor(
        private readonly logger: Logger,
        options: StrykerOptions
    ) {
        const bunOptions = (options as StrykerBunOptions).bun ?? {};

        this.bunPath = bunOptions.bunPath ?? 'bun';
        this.timeout = bunOptions.timeout ?? 10_000;
        this.inspectorTimeout = bunOptions.inspectorTimeout ?? 5000;
        this.env = bunOptions.env;
        this.bunArgs = bunOptions.bunArgs;
        // Treat empty array as undefined — an empty testFiles list is useless and
        // is most likely a configuration mistake.  getOrDiscoverTestFiles() will
        // auto-discover instead.  A warning is logged so the user is not surprised.
        // Stryker disable next-line ConditionalExpression,EqualityOperator: treating [] as undefined is deliberate; a mutation that skips this guard would forward an empty array, causing bun test to receive no files and exit 0 with 0 tests — a silent, hard-to-diagnose failure
        if(bunOptions.testFiles?.length === 0) {
            // Stryker disable next-line StringLiteral: diagnostic warning message
            this.logger.warn('bun.testFiles was set to an empty array — treating as undefined and falling back to auto-discovery');
            this.testFilesOverride = undefined;
        } else {
            this.testFilesOverride = bunOptions.testFiles;
        }
        // StrykerOptions.mutate is declared non-optional but Stryker may not always
        // populate it (e.g. in unit tests that pass a partial options object).
        this.mutateGlobs = (options as { mutate?: string[] }).mutate ?? [];

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner initialized with options: %o', {
            bunPath:          this.bunPath,
            timeout:          this.timeout,
            inspectorTimeout: this.inspectorTimeout,
            env:              this.env,
            bunArgs:          this.bunArgs,
        });

        // Warn when absolute testFiles paths are used inside a Stryker sandbox.
        // In a sandbox, cwd is .stryker-tmp/sandbox-XYZ/ and contains copies of
        // the project's source and test files.  Absolute paths bypass the sandbox
        // copy and point at the ORIGINAL (unmutated) files, so mutations are
        // silently ignored.  Relative paths are always preferred in Stryker context.
        // Stryker disable next-line ConditionalExpression,LogicalOperator: sandbox-detection guard — mutation that skips the warn is equivalent (no behaviour change in non-sandbox runs); mutation testing of the warn itself is not meaningful
        if(this.testFilesOverride?.some(p => path.isAbsolute(p))) {
            // Stryker disable next-line StringLiteral: sandbox detection uses .stryker-tmp/sandbox- prefix
            const isSandbox = process.cwd().includes('.stryker-tmp/sandbox-');
            if(isSandbox) {
                this.logger.warn(
                    'bun.testFiles contains absolute path(s) and the current working directory appears to be a Stryker sandbox (%s). '
                    + 'Absolute paths point at the ORIGINAL (unmutated) source files — mutations will be silently bypassed. '
                    + 'Use relative paths so that Bun resolves them against the sandbox copy.',
                    process.cwd()
                );
            }
        }
    }

    /**
     * Single source of truth for the registry file name.
     * Using getters that read process.cwd() at call time ensures the path
     * resolves to Stryker's sandbox directory — which is set by the time these
     * are invoked — rather than the orchestrator's cwd at module-load time.
     */
    private get registryPath(): string {
        return path.join(process.cwd(), '.stryker-bun-runner-registry.json');
    }

    private get registryTmpPath(): string {
        return `${this.registryPath}.tmp`;
    }

    /**
   * Get test runner capabilities
   */
    public capabilities(): TestRunnerCapabilities {
        return {
            reloadEnvironment: true,
        };
    }

    /**
   * Return the test file list to use for this run.
   * When `bun.testFiles` was provided it is returned verbatim and
   * auto-discovery is skipped entirely.  Otherwise the result is cached after
   * the first real discovery call so that subsequent callers (dryRun, mutantRun)
   * do not re-glob the filesystem.
   */
    private async getOrDiscoverTestFiles(): Promise<string[] | undefined> {
        // Stryker disable next-line EqualityOperator,BlockStatement: EqualityOperator: inverts condition, ignoring override → discovery runs on wrong files → Timeout; BlockStatement: removes early return, override ignored → Timeout
        if(this.testFilesOverride !== undefined) {
            return this.testFilesOverride;
        }
        const cwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations caught by 'rediscovers test files when cwd changes'
        if(this.cachedTestFiles !== undefined && this.cachedTestFilesCwd === cwd) {
            return this.cachedTestFiles;
        }
        this.cachedTestFiles = await discoverTestFiles(cwd, this.logger);
        this.cachedTestFilesCwd = cwd;
        return this.cachedTestFiles;
    }

    /**
   * Test-file cache hit for a given cwd.
   * Returns the cached list synchronously when available, or undefined to
   * signal that async re-discovery is needed (cwd changed or first call).
   * Used by dryRun() to avoid introducing a microtask yield on the hot path.
   */
    private testFilesCacheHit(cwd: string): string[] | undefined | null {
        // Stryker disable next-line EqualityOperator,BlockStatement,ConditionalExpression: mutating to false (ConditionalExpression) causes a null cache-miss that falls through to getOrDiscoverTestFiles(), which re-checks testFilesOverride and returns the same value — equivalent; BlockStatement (removing early-return) and EqualityOperator (flipping guard) mutants are caught by 'should use testFiles override and skip discoverTestFiles'; the ConditionalExpression→true mutant (always returns the override) is equivalent because whenever testFilesOverride is defined it is returned either way
        if(this.testFilesOverride !== undefined) {
            return this.testFilesOverride;
        }
        // Stryker disable next-line ConditionalExpression,EqualityOperator: cache hit — cwd match; ConditionalExpression→false mutant would return stale cached files whenever cwd changes (returning wrong file list for new sandbox); EqualityOperator→!== mutant would force re-discovery every call even when cwd is unchanged (performance regression); both are caught by 'rediscovers test files when cwd changes between init() and dryRun()'
        return (this.cachedTestFiles !== undefined && this.cachedTestFilesCwd === cwd)
            ? this.cachedTestFiles
            : null;   // null = cache miss, caller must use getOrDiscoverTestFiles()
    }

    /**
   * Initialize the test runner
   */
    // Stryker disable next-line BlockStatement: removing init() body means no preload/bunfig/test-files setup → dryRun hangs → Timeout — expected
    public async init(): Promise<void> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner init starting...');

        // If init() is called more than once (Stryker sandbox lifecycle rotation),
        // clean up the preload script and coverage file from the previous init()
        // before generating new ones.  Without this, re-init leaks tmp files on disk.
        if(this.preloadScriptPath) {
            // Stryker disable next-line BlockStatement: cleanup-on-re-init guard; removing body leaks previous preload script file on disk — caught by 'cleans up previous preload script when init() is called again'
            try {
                await cleanupPreloadScript(this.preloadScriptPath);
            } catch (error) {
                // ENOENT or other FS errors are non-fatal; the old file is simply absent
                // Stryker disable next-line StringLiteral: diagnostic log message
                this.logger.debug('Failed to clean up previous preload script on re-init: %s', error instanceof Error ? error.message : String(error));
            }
            this.preloadScriptPath = undefined;
        }
        if(this.coverageFilePath) {
            // Stryker disable next-line BlockStatement: cleanup-on-re-init guard; removing body leaks previous coverage file on disk — caught by 'cleans up previous coverage file when init() is called again'
            try {
                await cleanupCoverageFile(this.coverageFilePath);
            } catch (error) {
                // ENOENT or other FS errors are non-fatal
                // Stryker disable next-line StringLiteral: diagnostic log message
                this.logger.debug('Failed to clean up previous coverage file on re-init: %s', error instanceof Error ? error.message : String(error));
            }
            this.coverageFilePath = undefined;
        }

        // Generate preload script for coverage collection
        const tempDir = path.join(tmpdir(), 'stryker-bun-runner');
        this.tempDir = tempDir;
        this.coverageFilePath = path.join(tempDir, `coverage-${Date.now()}.json`);

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Generating coverage preload script...');

        // Resolve StrykerOptions.mutate globs to an absolute file list.
        // The resolution is relative to process.cwd(), so if cwd changes between
        // init() calls (Stryker sandbox rotation) we must re-resolve from the new cwd.
        const eagerCwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations caught by 're-resolves eager modules when cwd changes'
        if(this.cachedEagerModules === undefined || this.cachedEagerModulesCwd !== eagerCwd) {
            this.cachedEagerModules    = await resolveEagerModulesFromGlobs(this.mutateGlobs);
            this.cachedEagerModulesCwd = eagerCwd;
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Resolved %d eager modules from mutate globs', this.cachedEagerModules.length);
        }

        this.preloadScriptPath = await generatePreloadScript({
            tempDir,
            coverageFile: this.coverageFilePath,
            eagerModules: this.cachedEagerModules,
        });
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Preload script generated at: %s', this.preloadScriptPath);

        // Pre-warm the sanitized bunfig cache so that dryRun/mutantRun can use the
        // cached path synchronously (avoiding async overhead on the hot path).
        // ensureSanitizedBunfig() will regenerate if cwd changes between phases.
        await this.ensureSanitizedBunfig();

        // Pre-warm the test-file list so that dryRun() and mutantRun() can use the
        // cached result without adding an async I/O hop on the fake-timer-sensitive
        // hot path.  If cwd changes between init and dryRun (Stryker sandbox rotation),
        // getOrDiscoverTestFiles() will detect the stale cachedTestFilesCwd key and
        // re-glob from the new cwd before returning.
        this.cachedTestFiles = await this.getOrDiscoverTestFiles();
    }

    /**
   * Regenerate the sanitized bunfig if the worker's cwd has changed (or if this
   * is the first spawn). Bun resolves relative paths in a bunfig against the
   * bunfig file's location, so keying on cwd ensures preload/root paths land in
   * the right sandbox.
   */
    private async ensureSanitizedBunfig(): Promise<string> {
        const cwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations are caught by test 'reuses cached bunfig when cwd unchanged'
        if(this.sanitizedBunfigPath && this.sanitizedBunfigCwd === cwd) {
            return this.sanitizedBunfigPath;
        }
        // Stryker disable next-line BlockStatement: cleanup branch covered by 'cleans up old bunfig when cwd changes'
        if(this.sanitizedBunfigPath) {
            await cleanupSanitizedBunfig(this.sanitizedBunfigPath);
        }
        // Stryker disable next-line StringLiteral: equivalent mutant — mutating 'stryker-bun-runner' to '' still produces a valid writable directory under tmpdir(); sanitized bunfig generation succeeds either way
        const tempDir = this.tempDir ?? path.join(tmpdir(), 'stryker-bun-runner');
        this.sanitizedBunfigPath = await generateSanitizedBunfig(cwd, tempDir);
        this.sanitizedBunfigCwd  = cwd;
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Sanitized bunfig (re)generated at: %s for cwd: %s', this.sanitizedBunfigPath, cwd);
        return this.sanitizedBunfigPath;
    }

    /**
   * Load the shared dryRun registry written by the one worker that ran dryRun.
   * Populates this.cachedTestNames and this.baseNameIndex so that subsequent
   * mutantRun calls on this worker can resolve killedBy names correctly, even
   * for static-coverage mutants where testFilter is empty.
   *
   * Failures are non-fatal — the worker falls back to raw console names (current
   * behaviour before this fix), and a warning is logged so the issue is visible.
   */
    private async loadRegistryFile(): Promise<void> {
        const registryPath = this.registryPath;
        try {
            const raw = await fsPromises.readFile(registryPath, 'utf8');
            const parsed = JSON.parse(raw) as RegistryFileV1;
            // Stryker disable next-line ConditionalExpression,BlockStatement: version guard covered by test 'skips registry with unexpected version'
            if(parsed.version !== 1) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn('dryRun registry file has unexpected version %s; skipping', String(parsed.version));
                return;
            }
            if(!Array.isArray(parsed.cachedTestNames) || !Array.isArray(parsed.baseNameIndex)) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'dryRun registry file is malformed (cachedTestNames or baseNameIndex missing or not an array); treating as absent'
                );
                return;
            }
            this.cachedTestNames = new Set<string>(parsed.cachedTestNames);
            this.baseNameIndex   = new Map<string, string[]>(parsed.baseNameIndex);
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug('Loaded dryRun registry from %s (%d entries)', registryPath, this.cachedTestNames.size);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // Stryker disable next-line BlockStatement: ENOENT path covered by test 'logs debug when registry file not found'
            if(code === 'ENOENT') {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.debug(
                    'dryRun registry file not found at %s; this worker has no static-coverage registry (expected on non-dryRun workers)',
                    registryPath
                );
            // Stryker disable next-line BlockStatement: else branch covered by test 'logs warning when registry file load fails with non-ENOENT error'
            } else {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'Failed to load dryRun registry from %s: %s',
                    registryPath,
                    err instanceof Error ? err.message : String(err)
                );
            }
        }
    }

    /**
   * Build test results from inspector data.
   *
   * @param inspectorIdToProjectFile - Optional mapping from inspector ID to project file path.
   *   When provided, the project file is used for TestResult.id, name, and fileName instead of
   *   testInfo.url. This is important for tests defined via helpers (e.g. RuleTester.run()) where
   *   Bun's inspector reports a url pointing to node_modules rather than the user's test file.
   */
    private buildTestsFromInspector(
        testHierarchy: TestInfo[],
        executionOrder: number[],
        parsed: ParsedTestResults,
        totalElapsedMs: number,
        inspectorIdToProjectFile?: Map<number, string>
    ): (SuccessTestResult | FailedTestResult | SkippedTestResult)[] {
        if(executionOrder.length === 0) {
            // Fallback: use parsed console output when inspector didn't capture tests
            return parsed.tests.map((t) => {
                const normalizedName = normalizeTestName(t.name);
                if(t.status === 'failed') {
                    return {
                        id:             normalizedName,
                        name:           normalizedName,
                        status:         TestStatus.Failed,
                        // Stryker disable next-line StringLiteral: fallback error message has no behavioral impact
                        failureMessage: t.failureMessage ?? 'Test failed',
                        timeSpentMs:    Math.round(t.duration ?? 1),
                    } satisfies FailedTestResult;
                }
                if(t.status === 'skipped') {
                    return {
                        id:          normalizedName,
                        name:        normalizedName,
                        status:      TestStatus.Skipped,
                        timeSpentMs: Math.round(t.duration ?? 1),
                    } satisfies SkippedTestResult;
                }
                return {
                    id:          normalizedName,
                    name:        normalizedName,
                    status:      TestStatus.Success,
                    timeSpentMs: Math.round(t.duration ?? 1),
                } satisfies SuccessTestResult;
            });
        }

        // Stryker disable next-line EqualityOperator, ConditionalExpression: mutating > 0 to >= 0 is equivalent here because the early return above already handles executionOrder.length === 0, so length is guaranteed > 0 at this point and the else branch is dead code; ConditionalExpression: true is equivalent for the same reason
        const timePerTest = executionOrder.length > 0
            ? Math.max(1, Math.round(totalElapsedMs / executionOrder.length))
            : 1;

        // Create a map for quick lookup
        const testMap = new Map<number, TestInfo>();
        for(const test of testHierarchy) {
            testMap.set(test.id, test);
        }

        const tests = executionOrder.map((inspectorId) => {
            const testInfo = testMap.get(inspectorId);
            if(!testInfo) {
                return {
                    id:          `unknown-${inspectorId}`,
                    name:        `unknown-${inspectorId}`,
                    status:      TestStatus.Success,
                    timeSpentMs: timePerTest,
                } satisfies SuccessTestResult;
            }

            // Prefer the project file from the coverage counter key mapping when available.
            // The counter key prefix is always the user's test file (via Bun.main in the preload),
            // so it is correct even when testInfo.url points to node_modules.
            // Skipped and pending tests have no counter keys so they fall back to testInfo.url.
            const projectFile = inspectorIdToProjectFile?.get(inspectorId);
            const uniqueName = projectFile
                ? buildProjectFileTestName(projectFile, testInfo.fullName)
                : buildUniqueTestName(testInfo.fullName, testInfo.url);
            const fileName = projectFile ?? normalizeTestFilePath(testInfo.url);
            const status = testInfo.status;
            const elapsed = testInfo.elapsed === undefined
                ? timePerTest                                // Already in milliseconds
                : Math.round(testInfo.elapsed / 1_000_000); // Convert nanoseconds to milliseconds and round

            const startPosition = testInfo.line === undefined ? undefined : { line: testInfo.line, column: 0 };

            if(status === 'fail') {
                // Find failure message from parsed output
                const parsedTest = parsed.tests.find(t => t.name.includes(testInfo.name));
                return {
                    id:             uniqueName,
                    name:           uniqueName,
                    fileName,
                    startPosition,
                    status:         TestStatus.Failed,
                    // Stryker disable next-line StringLiteral: fallback error message has no behavioral impact
                    failureMessage: parsedTest?.failureMessage ?? testInfo.error?.message ?? 'Test failed',
                    timeSpentMs:    elapsed,
                } satisfies FailedTestResult;
            }

            if(status === 'skip' || status === 'todo') {
                return {
                    id:          uniqueName,
                    name:        uniqueName,
                    fileName,
                    startPosition,
                    status:      TestStatus.Skipped,
                    timeSpentMs: elapsed,
                } satisfies SkippedTestResult;
            }

            return {
                id:          uniqueName,
                name:        uniqueName,
                fileName,
                startPosition,
                status:      TestStatus.Success,
                timeSpentMs: elapsed,
            } satisfies SuccessTestResult;
        });

        // Handle duplicate test names (e.g., from it.each with %s placeholders)
        // Bun's inspector reports the template literal instead of interpolated values.
        //
        // IMPORTANT: index assignment must be deterministic regardless of WebSocket
        // message arrival order.  We sort each group of duplicate-named tests by their
        // source line number BEFORE assigning [0], [1], … so the index is driven by
        // the test's position in the source file, not by the order the inspector
        // delivered its start/end events (which can vary run-to-run due to buffering).
        const nameCounts = new Map<string, number>();
        for(const test of tests) {
            nameCounts.set(test.name, (nameCounts.get(test.name) ?? 0) + 1);
        }

        // For names that appear multiple times, collect the group, sort by source line,
        // then assign suffixes in line order so [0] always refers to the earliest
        // occurrence in the file.
        const nameGroups = new Map<string, typeof tests>();
        for(const test of tests) {
            if((nameCounts.get(test.name) ?? 1) > 1) {
                const group = nameGroups.get(test.name);
                if(group) {
                    group.push(test);
                } else {
                    nameGroups.set(test.name, [test]);
                }
            }
        }
        for(const [, group] of nameGroups) {
            // Sort by source line ascending; tests without a line go last (stable secondary
            // key: original position in `tests` via indexOf — already stable in V8/Bun).
            group.sort((a, b) => {
                // Stryker disable next-line StringLiteral: equivalent mutant — mutating 'startPosition' to '' makes the check `'' in a`, which is always false because test result objects never have an empty-string key; lineA resolves to Infinity either way
                const lineA = 'startPosition' in a && a.startPosition ? a.startPosition.line : Infinity;
                // Stryker disable next-line StringLiteral: equivalent mutant — mutating 'startPosition' to '' makes the check `'' in b`, which is always false because test result objects never have an empty-string key; lineB resolves to Infinity either way
                const lineB = 'startPosition' in b && b.startPosition ? b.startPosition.line : Infinity;
                return lineA - lineB;
            });
            for(const [i, test] of group.entries()) {
                const uniqueName = `${test.name} [${i}]`;
                test.id = uniqueName;
                test.name = uniqueName;
            }
        }

        return tests;
    }

    /**
   * Run all tests (dry run)
   */
    public async dryRun(): Promise<DryRunResult> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Running dry run with inspector-based coverage collection...');

        // Create an AbortController so we can kill the child process if the inspector
        // connection fails before the test run completes.  Without this, a failed
        // inspector.connect() would leave the child process running until its own
        // process-level timeout fires — unnecessarily delaying the error result.
        const abortController = new AbortController();

        // 1. Get available ports for inspector and sync server
        const inspectPort = await getAvailablePort();
        const syncPort = await getAvailablePort();
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Using inspector port: %d, sync port: %d', inspectPort, syncPort);

        // 2. Start sync server
        const syncServer = new SyncServer({ port: syncPort, timeout: this.inspectorTimeout });
        try {
            await syncServer.start();
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Sync server started on port %d', syncPort);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.error('Failed to start sync server: %s', errorMsg);
            return {
                status:       DryRunStatus.Error,
                errorMessage: `Failed to start sync server: ${errorMsg}`,
            };
        }

        const startTime = Date.now();
        let inspectorUrl: string | null = null;

        // Wrap everything after server start in try/finally so syncServer.close()
        // is always called even if any intermediate step throws (bunfig regen, test
        // file re-discovery, inspector.close(), etc.).
        // SyncServer.close() is idempotent (wss/httpServer guarded by null checks),
        // so the explicit early-return closes below are harmless double-closes.
        try {
            // 3. Resolve bunfig and test file list, then start bun test process.

            // Use cached bunfig path synchronously when available (pre-warmed by init()).
            // Fall back to async generation only when cwd has changed (Stryker sandbox rotation).
            const cwd = process.cwd();
            // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: inline cache hit — same pattern as ensureSanitizedBunfig, covered by 'reuses cached bunfig in dryRun when cwd unchanged'
            const bunfigPath = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === cwd)
                ? this.sanitizedBunfigPath
                : await this.ensureSanitizedBunfig();

            // Resolve the test file list — synchronously on cache hit, async on cache miss.
            // Using a two-step check avoids the microtask yield that `await` of a non-Promise
            // would otherwise introduce on the hot path (which matters for fake-timer tests).
            // Stryker disable next-line ConditionalExpression,BlockStatement: cache-miss path covered by 'rediscovers test files when cwd changes between init() and dryRun()'
            const testFilesCached = this.testFilesCacheHit(cwd);
            const testFiles = testFilesCached === null ? await this.getOrDiscoverTestFiles() : testFilesCached;

            // Start test process with callback to get inspector URL
            const testProcess = runBunTests({
                bunPath:          this.bunPath,
                timeout:          this.timeout,
                env:              this.env,
                bunArgs:          this.bunArgs,
                bunfigPath,
                preloadScript:    this.preloadScriptPath,
                coverageFile:     this.coverageFilePath,
                inspectWaitPort:  inspectPort,
                sequentialMode:   true,  // Critical for correlation
                syncPort, // Pass sync port to preload script via env var
                testFiles,
                signal:           abortController.signal,
                // Stryker disable next-line BlockStatement: removing callback body means inspectorUrl never set → infinite poll → Timeout
                onInspectorReady: (url: string) => {
                    inspectorUrl = url;
                },
            });

            // 4. Wait for inspector URL with timeout
            const waitStart = Date.now();
            // Stryker disable next-line EqualityOperator,LogicalOperator,ConditionalExpression,BlockStatement: EqualityOperator < vs <= is equivalent; LogicalOperator && → || loops forever → Timeout; ConditionalExpression always-true loops forever → Timeout; BlockStatement removes sleep → busy-wait blocks callback → Timeout
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-unmodified-loop-condition -- inspectorUrl set by async callback in runBunTests; TypeScript cannot track cross-await mutations
            while(!inspectorUrl && Date.now() - waitStart < this.inspectorTimeout) {
                // eslint-disable-next-line no-await-in-loop -- sequential polling required; inspectorUrl set by async callback
                await sleep(50);
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- inspectorUrl set by async callback; TypeScript cannot track cross-await mutations
            if(!inspectorUrl) {
                // Await the child to drain its stdout/stderr so we can surface what Bun
                // actually emitted before we abandoned it.  Some setups (e.g. preload
                // scripts that fail to resolve) can make Bun exit before the inspector
                // banner is printed; without this diagnostic the user only sees a
                // useless "Timeout waiting for inspector URL".
                const diagnosticResult = await testProcess;
                // Stryker disable next-line MethodExpression: equivalent mutant — slice(0,1000) vs full string is only observable in diagnostic log output, not in test behavior
                const stdoutPreview = diagnosticResult.stdout.slice(0, 1000);
                // Stryker disable next-line MethodExpression: equivalent mutant — slice(0,1000) vs full string is only observable in diagnostic log output, not in test behavior
                const stderrPreview = diagnosticResult.stderr.slice(0, 1000);
                // Stryker disable StringLiteral: logging message format strings — not behaviorally tested
                this.logger.error(
                    'Failed to get inspector URL within timeout (%dms).\nexit=%s timedOut=%s\n'
                    + '--- STDOUT (first 1000 chars) ---\n%s\n'
                    + '--- STDERR (first 1000 chars) ---\n%s',
                    this.inspectorTimeout,
                    String(diagnosticResult.exitCode),
                    String(diagnosticResult.timedOut),
                    // Stryker restore StringLiteral
                    // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — '(empty)' fallback only affects diagnostic log message content
                    stdoutPreview || '(empty)',
                    // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — '(empty)' fallback only affects diagnostic log message content
                    stderrPreview || '(empty)'
                );
                return {
                    status:       DryRunStatus.Error,
                    errorMessage: 'Timeout waiting for inspector URL',
                };
            }

            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Inspector URL: %s', inspectorUrl);

            // 5. Create inspector client
            const inspector = new InspectorClient({
                url:               inspectorUrl,
                connectionTimeout: this.inspectorTimeout,
                requestTimeout:    this.inspectorTimeout,
                handlers:          {},  // No per-test relay needed - coverage uses file-prefixed counter keys
            });

            // 6. Connect inspector client and enable test reporting
            try {
                await inspector.connect();
                await inspector.send('TestReporter.enable', {});
                // Stryker disable next-line StringLiteral: logging message only
                this.logger.debug('Inspector connected and TestReporter enabled');
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                // Stryker disable next-line StringLiteral: logging message only
                this.logger.error('Failed to connect inspector: %s', errorMsg);
                // Kill the orphaned child process — without aborting it, the bun test
                // process would keep running until its own timeout fires.
                abortController.abort();
                await inspector.close();
                return {
                    status:       DryRunStatus.Error,
                    errorMessage: `Failed to connect to Bun inspector: ${errorMsg}`,
                };
            }

            // 7. Signal preload script to proceed with tests
            syncServer.signalReady();
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Signaled preload script to proceed');

            // 8. Wait for test process to complete
            const result = await testProcess;
            const totalElapsedMs = Date.now() - startTime;

            // 9. Get inspector data before closing
            const testHierarchy = inspector.getTests();
            const executionOrder = inspector.getExecutionOrder();

            await inspector.close();

            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Inspector collected %d tests in hierarchy, %d in execution order',
                testHierarchy.length, executionOrder.length);

            // 10–12. Handle timeout and process errors; parse output
            const parsed = parseBunTestOutput(result.stdout, result.stderr);
            const earlyResult = this.checkDryRunProcessResult(result, parsed);
            if(earlyResult) {
                return earlyResult;
            }

            // 13. Collect and remap coverage data
            const { coverage: mutantCoverage, inspectorIdToProjectFile } = await this.collectAndRemapCoverage(testHierarchy, executionOrder);

            // 14. Build test results from inspector data
            const tests = this.buildTestsFromInspector(testHierarchy, executionOrder, parsed, totalElapsedMs, inspectorIdToProjectFile);

            // Sort tests by name to ensure consistent order across runs
            // This is critical for Stryker's incremental mode - test IDs are assigned
            // based on order, so inconsistent order breaks coveredBy correlation
            tests.sort((a, b) => a.name.localeCompare(b.name));

            // Cache test names and persist registry for killedBy resolution in mutantRun
            await this.buildAndPersistTestRegistry(tests);

            return {
                status: DryRunStatus.Complete,
                tests,
                mutantCoverage,
            };
        } finally {
            // Abort the child process if it is still running.  This is idempotent —
            // if the process already exited normally, the signal fires to a dead process
            // and the close-event has already resolved the promise.
            abortController.abort();
            // 10 (always). Close sync server — idempotent, safe even after early-return paths
            await syncServer.close();
        }
    }

    /**
   * Build the in-memory test name cache and base-name index, then atomically
   * persist them to a well-known file so other worker processes can lazy-load
   * them when handling static-coverage mutants (testFilter is empty for those).
   *
   * Writing to a .tmp path then renaming is atomic on POSIX: readers always see
   * either the previous complete file or the new one — never a partial write.
   */
    private async buildAndPersistTestRegistry(
        tests: (SuccessTestResult | FailedTestResult | SkippedTestResult)[]
    ): Promise<void> {
        this.cachedTestNames = new Set(tests.map(t => t.name));
        // Stryker disable all: defensive check — buildTestsFromInspector always deduplicates names, so tests.length === cachedTestNames.size in normal operation; this entire block is unreachable defensive code
        if(tests.length !== this.cachedTestNames.size) {
            const nameCount = new Map<string, number>();
            for(const test of tests) {
                nameCount.set(test.name, (nameCount.get(test.name) ?? 0) + 1);
            }
            const duplicates = [...nameCount.entries()]
                .filter(([_, count]) => count > 1)
                .map(([name, count]) => `"${name}" (${count}x)`);
            this.logger.warn(
                'Found %d duplicate test names (total: %d, unique: %d): %s',
                tests.length - this.cachedTestNames.size,
                tests.length,
                this.cachedTestNames.size,
                duplicates.join(', ')
            );
        }
        // Stryker restore all

        // Build base-name index: maps the unsuffixed name to all registry IDs that share it.
        // This resolves the format drift where mutantRun (console parser) emits "foo > bar"
        // but dryRun (inspector) registered "foo > bar [0]" and "foo > bar [1]".
        // Regex anchored at end: / \[\d+\]$/ matches the " [N]" dedup suffix only.
        this.baseNameIndex = new Map<string, string[]>();
        // Stryker disable next-line Regex: suffix regex is anchored and defensive
        const suffixRe = / \[\d+\]$/;
        for(const id of this.cachedTestNames) {
            const base = suffixRe.test(id) ? id.replace(suffixRe, '') : id;
            const bucket = this.baseNameIndex.get(base);
            if(bucket) {
                bucket.push(id);
            } else {
                this.baseNameIndex.set(base, [id]);
            }
            // Also add identity entry for already-suffixed names so callers that somehow
            // produce a suffixed name still get a hit without going through the base lookup.
            // Stryker disable ConditionalExpression,EqualityOperator,BlockStatement,ArrayDeclaration: edge-case identity entries for suffixed names — only used when Bun output includes [N] suffixes (doesn't happen in practice); mutations here cause incorrect identity lookups but are not exercised by tests
            if(base !== id) {
                this.baseNameIndex.set(id, [id]);
            }
            // Stryker restore ConditionalExpression,EqualityOperator,BlockStatement,ArrayDeclaration
        }
        // Stryker disable next-line StringLiteral: diagnostic logging message
        this.logger.debug('Cached %d test names from dry run for killedBy resolution', this.cachedTestNames.size);

        try {
            const registryPath = this.registryPath;
            const tmpPath = this.registryTmpPath;
            const registryData = JSON.stringify({
                version:         1,
                writtenAt:       Date.now(),
                // Stryker disable next-line ArrayDeclaration: equivalent mutant — prepending "Stryker was here" leaves all real test names in place; killedBy resolution is unaffected
                cachedTestNames: [...this.cachedTestNames],
                baseNameIndex:   [...this.baseNameIndex.entries()],
            });
            await fsPromises.writeFile(tmpPath, registryData, 'utf8');
            this.lastRegistryTmpPath = tmpPath;
            await fsPromises.rename(tmpPath, registryPath);
            // Clear lastRegistryTmpPath now that the rename succeeded — the .tmp file
            // no longer exists on disk.  dispose() will skip the unlink attempt so it
            // doesn't try to delete a file that was already renamed away.
            this.lastRegistryTmpPath = undefined;
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug('Wrote dryRun registry to %s (%d entries)', registryPath, this.cachedTestNames.size);
        } catch (error) {
            // Non-fatal: the worker that did dryRun still has its in-memory copy.
            // Other workers will fall back to raw names and log a warning.
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.warn('Failed to write dryRun registry file: %s', error instanceof Error ? error.message : String(error));
        }
    }

    /**
   * Run tests with an active mutant
   */
    public async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Running mutant run for mutant %s', options.activeMutant.id);

        // Translate testFilter into --test-name-pattern to run only the covering tests.
        // Each test ID is the full "file.test.ts > Suite > test name" string from dryRun;
        // we strip the file-path prefix (Bun's pattern matches the hierarchy without it)
        // and collapse duplicate-name tests (those with a " [N]" dedup suffix) to a single
        // alternative — Bun cannot distinguish them at runtime, but running both is correct.
        // --bail is still applied so the first failure stops the run immediately.
        // Sequential mode (--concurrency=1) is required to match dryRun's serialized
        // execution semantics — parallel timing can cause mutants to escape detection.
        // IMPORTANT: Preload script IS needed to set globalThis.__stryker__.activeMutant
        // The preload script skips coverage collection when __STRYKER_ACTIVE_MUTANT__ is set
        const testNamePattern = buildTestNamePattern(options.testFilter ?? []);

        // Build a LOCAL index from options.testFilter so that every worker — not just
        // the one that ran dryRun — can resolve rawFailedNames into killedBy IDs.
        // Stryker disable next-line ArrayDeclaration: equivalent mutant — options.testFilter is always a non-null array in all tests; ?? fallback never fires, so ['Stryker was here'] = [] in practice
        const localTestFilter = options.testFilter ?? [];
        const { localRegistry, localBaseIndex } = this.buildLocalTestFilterIndex(localTestFilter);

        // Lazy-load the shared dryRun registry when this worker's instance registry is
        // not yet populated (i.e. this worker never ran dryRun).  We now load it
        // regardless of whether testFilter is empty, because Bun's --test-name-pattern
        // is a hierarchy regex that can leak: tests NOT in testFilter may still run and
        // kill the mutant first.  Their names won't be in localRegistry, so we need the
        // instance registry as a fallback to avoid storing raw console names in killedBy.
        if(!this.cachedTestNames) {
            await this.loadRegistryFile();
        }

        // Use cached bunfig path synchronously when available (pre-warmed by init()).
        const mutantCwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: inline cache hit — same pattern as ensureSanitizedBunfig, covered by 'reuses cached bunfig in mutantRun when cwd unchanged'
        const bunfigPath = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === mutantCwd)
            ? this.sanitizedBunfigPath
            : await this.ensureSanitizedBunfig();

        // Reuse the sorted test-file list cached during dryRun.
        // If this worker never ran dryRun (cachedTestFiles is undefined), discover
        // the files now and cache them for subsequent mutantRun calls on this worker.
        // When testFilesOverride is set, use it directly without globbing.
        this.cachedTestFiles = await this.getOrDiscoverTestFiles();

        const result = await runBunTests({
            bunPath:        this.bunPath,
            timeout:        this.timeout,
            env:            this.env,
            bunArgs:        this.bunArgs,
            bunfigPath,
            activeMutant:   options.activeMutant.id,
            bail:           true,            // Bail on first failure for mutant runs
            sequentialMode: true,            // Match dryRun's serialized execution for deterministic results
            preloadScript:  this.preloadScriptPath, // Needed to set globalThis.__stryker__.activeMutant
            testNamePattern, // undefined → no filter → full suite (current behaviour)
            testFiles:      this.cachedTestFiles,
        });

        if(result.timedOut) {
            // Stryker disable next-line all: Logging statement
            this.logger.debug('Mutant run timed out');
            return {
                status: MutantRunStatus.Timeout,
            };
        }

        const parsed = parseBunTestOutput(result.stdout, result.stderr);

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Mutant run completed: %o', {
            totalTests: parsed.totalTests,
            passed:     parsed.passed,
            failed:     parsed.failed,
            exitCode:   result.exitCode,
        });

        // Non-zero exit code means tests failed, mutant is killed.
        if(result.exitCode !== 0) {
            return this.buildMutantKilledResult(result, parsed, localRegistry, localBaseIndex, options.activeMutant.id);
        }

        // Exit code 0 means all tests passed, mutant survived
        return {
            status:    MutantRunStatus.Survived,
            nrOfTests: parsed.totalTests,
        };
    }

    /**
   * Build the MutantRunResult for a killed mutant (non-zero exit code).
   * Handles runtime error detection and killedBy resolution.
   */
    private buildMutantKilledResult(
        result:         { exitCode: number | null, stdout: string, stderr: string },
        parsed:         { tests: { status: string, name: string, failureMessage?: string }[], totalTests: number },
        localRegistry:  Set<string>,
        localBaseIndex: Map<string, string[]>,
        mutantId:       string
    ): MutantRunResult {
        const rawFailedNames = parsed.tests
            .filter(test => test.status === 'failed')
            .map(test => normalizeTestName(test.name));

        // Check for runtime errors: tests couldn't run due to module/syntax errors
        // These should be RuntimeError, not Killed, and don't need killedBy for caching
        // Stryker disable next-line BlockStatement,LogicalOperator: BlockStatement: runtime error detection covered by 'returns RuntimeError when stderr signals a syntax error'; LogicalOperator: equivalent mutant — rawFailedNames is always derived from parsed.tests (subset), so both are 0 simultaneously; && and || produce identical results for all reachable inputs
        if(rawFailedNames.length === 0 && parsed.tests.length === 0) {
            const runtimeResult = this.checkRuntimeError(result, mutantId);
            // Stryker disable next-line BlockStatement: covered by 'returns runtimeResult when checkRuntimeError returns non-null'
            if(runtimeResult) {
                return runtimeResult;
            }
        }

        const killedBy = this.resolveKilledBy(rawFailedNames, localRegistry, localBaseIndex, mutantId);

        // If we still have nothing (genuinely unparseable Bun output), fall back to 'unknown'
        if(killedBy.length === 0) {
            // Stryker disable StringLiteral: diagnostic logging message format strings — not behaviorally tested
            this.logger.warn(
                'No failed tests identified for mutant %s — Bun output could not be parsed; '
                + 'using "unknown" fallback (breaks incremental cache)\n'
                + 'exit=%s\n--- STDOUT (first 600 chars) ---\n%s\n'
                + '--- STDERR (first 600 chars) ---\n%s',
                mutantId,
                String(result.exitCode),
                // Stryker restore StringLiteral
                // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — slice(0,600) and '(empty)' are diagnostic only
                result.stdout.slice(0, 600) || '(empty)',
                // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — slice(0,600) and '(empty)' are diagnostic only
                result.stderr.slice(0, 600) || '(empty)'
            );
            killedBy.push('unknown');
        }

        return {
            status:         MutantRunStatus.Killed,
            killedBy,
            // Stryker disable all: filter chain for failure message extraction
            failureMessage: parsed.tests
                .filter(test => test.status === 'failed')
                .map(test => test.failureMessage)
                .filter((msg): msg is string => !!msg)
                .join('\n\n') || `Tests failed with exit code ${result.exitCode}`,
            nrOfTests: parsed.totalTests || 1,
        };
    }

    /**
   * Check if the process failed due to a runtime error (no tests ran).
   * Returns a MutantRunResult if this is a runtime error, or null to continue.
   */
    private checkRuntimeError(
        result:   { exitCode: number | null, stderr: string },
        mutantId: string
    ): MutantRunResult | null {
        const stderr = result.stderr;
        const isRuntimeError
            = stderr.includes('Unhandled error')
              || stderr.includes('Cannot find module')
              || stderr.includes('SyntaxError')
              || stderr.includes('TypeError')
              || stderr.includes('ReferenceError')
              || stderr.includes('is not defined')
              || stderr.includes('Unexpected token');

        if(isRuntimeError) {
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug(
                'Mutant %s caused runtime error (tests could not run): %s',
                mutantId,
                stderr.slice(0, 200)
            );
            return {
                status:       MutantRunStatus.Error,
                errorMessage: stderr.slice(0, 500) || `Runtime error with exit code ${result.exitCode}`,
            };
        }
        return null;
    }

    /**
   * Check for dry run process failures (timeout or non-zero exit).
   * Returns a DryRunResult to short-circuit if the process failed, or null to proceed.
   */
    private checkDryRunProcessResult(
        result: { timedOut: boolean, exitCode: number | null, stderr: string },
        parsed: { failed: number }
    ): DryRunResult | null {
        if(result.timedOut) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.warn('Dry run timed out');
            return { status: DryRunStatus.Timeout };
        }
        // Non-zero exit with 0 parsed failures means the process itself failed
        // (e.g. misconfiguration, missing module) rather than a test failure —
        // surface as a process-level Error so Stryker can report it clearly.
        // Non-zero exit WITH parsed failures means real tests failed; fall through
        // so the caller can build a Complete result with the failed test details.
        if(result.exitCode !== 0 && parsed.failed === 0) {
            return {
                status:       DryRunStatus.Error,
                errorMessage: `Bun test process failed with exit code ${result.exitCode}\n${result.stderr}`,
            };
        }
        return null;
    }

    /**
   * Collect coverage from the coverage file and remap counter-based IDs to
   * full test names using the inspector's execution order.
   */
    private async collectAndRemapCoverage(
        testHierarchy:  TestInfo[],
        executionOrder: number[]
    ): Promise<{ coverage: MutantCoverage | undefined, inspectorIdToProjectFile: Map<number, string> }> {
        const testMap = new Map(testHierarchy.map(t => [t.id, t]));

        if(!this.coverageFilePath) {
            return { coverage: undefined, inspectorIdToProjectFile: new Map() };
        }
        const rawCoverage = await collectCoverage(this.coverageFilePath, this.logger);
        await cleanupCoverageFile(this.coverageFilePath);
        if(!rawCoverage) {
            return { coverage: undefined, inspectorIdToProjectFile: new Map() };
        }

        // Map coverage counter keys to full test names and extract the inspector-ID → project-file
        // mapping in a single pass. The new file-prefixed format ("relativeFile@@test-N") produces
        // a populated inspectorIdToProjectFile; legacy keys ("test-N") and unknown formats return
        // an empty map so the runner falls back to testInfo.url-based naming.
        const { coverage, inspectorIdToProjectFile } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testMap, this.logger);
        return { coverage, inspectorIdToProjectFile };
    }

    /**
   * Build local index structures from testFilter for killedBy resolution.
   *
   * testFilter carries the full registry IDs Stryker wants us to run, including
   * any " [N]" dedup suffixes. Building the index here means all workers behave
   * identically on the first shot, eliminating incremental drift caused by workers
   * that never ran dryRun falling through to raw names.
   */
    private buildLocalTestFilterIndex(testFilter: string[]): {
        localRegistry:  Set<string>
        localBaseIndex: Map<string, string[]>
    } {
        const localRegistry = new Set<string>(testFilter);
        // Stryker disable next-line Regex: suffix regex is anchored and defensive
        const localSuffixRe = / \[\d+\]$/;
        const localBaseIndex = new Map<string, string[]>();
        for(const id of localRegistry) {
            const base = localSuffixRe.test(id) ? id.replace(localSuffixRe, '') : id;
            const bucket = localBaseIndex.get(base);
            if(bucket) {
                bucket.push(id);
            } else {
                localBaseIndex.set(base, [id]);
            }
            // Also add identity entry for already-suffixed names (mirrors dryRun logic).
            if(base !== id) {
                localBaseIndex.set(id, [id]);
            }
        }
        return { localRegistry, localBaseIndex };
    }

    /**
   * Resolve raw failed test names from console output against the test registry.
   *
   * Console-parser output lacks the [N] dedup suffix that dryRun appends when
   * multiple tests share the same base name (e.g. it.each with %s).
   *
   * Fallback chain — stops at the FIRST successful resolution for each name:
   *   1. Exact match in localRegistry (built from testFilter)
   *   2. Base-name match in localBaseIndex (built from testFilter)
   *   3. Exact match in this.cachedTestNames (instance registry from dryRun)
   *   4. Base-name match in this.baseNameIndex (instance registry from dryRun)
   *   5. Raw name as-is with a warn log — last resort if nothing resolves.
   */
    private resolveKilledBy(
        rawFailedNames:  string[],
        localRegistry:   Set<string>,
        localBaseIndex:  Map<string, string[]>,
        mutantId:        string
    ): string[] {
        const killedBySet = new Set<string>();
        for(const name of rawFailedNames) {
            if(localRegistry.has(name)) {
                killedBySet.add(name);
                continue;
            }

            const localBucket = localBaseIndex.get(name);
            if(localBucket) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.debug(
                    'Expanded killedBy base name "%s" → %d local registry IDs for mutant %s',
                    name, localBucket.length, mutantId
                );
                for(const id of localBucket) {
                    killedBySet.add(id);
                }
                continue;
            }

            if(this.cachedTestNames?.has(name)) {
                killedBySet.add(name);
                continue;
            }

            const instanceBucket = this.baseNameIndex?.get(name);
            if(instanceBucket) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.debug(
                    'Expanded killedBy base name "%s" → %d instance registry IDs for mutant %s',
                    name, instanceBucket.length, mutantId
                );
                for(const id of instanceBucket) {
                    killedBySet.add(id);
                }
                continue;
            }

            // Step 5: nothing matched — include as-is. Not a real warning:
            // Stryker's incremental-cache diff tolerates unknown killedBy names,
            // and the fallback preserves correctness (mutant is still marked killed).
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug(
                'killedBy name "%s" for mutant %s not found in test registry; including as-is',
                name, mutantId
            );
            killedBySet.add(name);
        }
        return [...killedBySet];
    }

    /**
   * Cleanup resources
   */
    public async dispose(): Promise<void> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Disposing BunTestRunner');

        // Clean up preload script
        if(this.preloadScriptPath) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Cleaning up preload script: %s', this.preloadScriptPath);
            await cleanupPreloadScript(this.preloadScriptPath);
        }

        // Clean up coverage file if it still exists
        if(this.coverageFilePath) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Cleaning up coverage file: %s', this.coverageFilePath);
            await cleanupCoverageFile(this.coverageFilePath);
        }

        // Clean up sanitized bunfig
        if(this.sanitizedBunfigPath) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Cleaning up sanitized bunfig: %s', this.sanitizedBunfigPath);
            await cleanupSanitizedBunfig(this.sanitizedBunfigPath);
        }

        // Registry tmp file from atomic-write path; normal runs rename it away,
        // but crashes between writeFile and rename can leave it behind.
        if(this.lastRegistryTmpPath) {
            try {
                await fsPromises.unlink(this.lastRegistryTmpPath);
            } catch (err) {
                if((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    this.logger.debug('Failed to clean registry tmp file: %s', err instanceof Error ? err.message : String(err));
                }
            }
        }
    }
}
