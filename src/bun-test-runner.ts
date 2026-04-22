/**
 * Main TestRunner implementation for Bun
 * Implements the Stryker TestRunner API
 */

import type {
    TestRunner,
    DryRunResult,
    MutantRunOptions,
    MutantRunResult,
    TestRunnerCapabilities,
    SuccessTestResult,
    FailedTestResult,
    SkippedTestResult
} from '@stryker-mutator/api/test-runner';
import {
    DryRunStatus,
    MutantRunStatus,
    TestStatus
} from '@stryker-mutator/api/test-runner';
import { StrykerOptions } from '@stryker-mutator/api/core';
import { Logger } from '@stryker-mutator/api/logging';
import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import { StrykerBunOptions } from './options.js';
import { runBunTests } from './process-runner.js';
import { parseBunTestOutput, type ParsedTestResults } from './parsers/console-parser.js';
import {
    generatePreloadScript,
    cleanupPreloadScript,
    collectCoverage,
    cleanupCoverageFile,
    resolveEagerModulesFromGlobs,
    mapCoverageToInspectorIds
} from './coverage/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { InspectorClient } from './inspector/index.js';
import { getAvailablePort, SyncServer, generateSanitizedBunfig, cleanupSanitizedBunfig, normalizeTestFilePath, normalizeTestName, buildUniqueTestName, buildTestNamePattern, discoverTestFiles } from './utils/index.js';
import type { TestInfo } from './inspector/types.js';

/**
 * Bun test runner for Stryker mutation testing
 */
export class BunTestRunner implements TestRunner {
    public static readonly inject = tokens(commonTokens.logger, commonTokens.options);

    private readonly bunPath:          string;
    private readonly timeout:          number;
    private readonly inspectorTimeout: number;
    private readonly env?:             Record<string, string>;
    private readonly bunArgs?:         string[];
    private readonly mutateGlobs:      readonly string[];
    private preloadScriptPath?:        string;
    private coverageFilePath?:         string;
    private sanitizedBunfigPath?:      string;
    private sanitizedBunfigCwd?:       string;
    private tempDir?:                  string;
    private cachedTestNames?:          Set<string>;
    private baseNameIndex?:            Map<string, string[]>;
    private cachedTestFiles?:          string[];
    private cachedEagerModules?:       string[];
    private lastRegistryTmpPath?:      string;

    constructor(
        private readonly logger: Logger,
        options: StrykerOptions
    ) {
        const bunOptions = (options as StrykerBunOptions).bun ?? {};

        this.bunPath = bunOptions.bunPath ?? 'bun';
        this.timeout = bunOptions.timeout ?? 10000;
        this.inspectorTimeout = bunOptions.inspectorTimeout ?? 5000;
        this.env = bunOptions.env;
        this.bunArgs = bunOptions.bunArgs;
        this.mutateGlobs = options.mutate ?? [];

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner initialized with options: %o', {
            bunPath:          this.bunPath,
            timeout:          this.timeout,
            inspectorTimeout: this.inspectorTimeout,
            env:              this.env,
            bunArgs:          this.bunArgs,
        });
    }

    /**
     * Single source of truth for the registry file name.
     * Using getters that read process.cwd() at call time ensures the path
     * resolves to Stryker's sandbox directory — which is set by the time these
     * are invoked — rather than the orchestrator's cwd at module-load time.
     */
    private get registryPath(): string {
        return join(process.cwd(), '.stryker-bun-runner-registry.json');
    }

    private get registryTmpPath(): string {
        return this.registryPath + '.tmp';
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
   * Initialize the test runner
   */
    public async init(): Promise<void> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner init starting...');

        // Generate preload script for coverage collection
        const tempDir = join(tmpdir(), 'stryker-bun-runner');
        this.tempDir = tempDir;
        this.coverageFilePath = join(tempDir, `coverage-${Date.now()}.json`);

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Generating coverage preload script...');

        // Resolve StrykerOptions.mutate globs to an absolute file list once per run.
        // Cached here so multiple worker instances (each with their own BunTestRunner) only
        // pay the I/O cost on their own init(); the list is stable for a given Stryker run.
        if(!this.cachedEagerModules) {
            this.cachedEagerModules = await resolveEagerModulesFromGlobs(this.mutateGlobs);
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Resolved %d eager modules from mutate globs', this.cachedEagerModules.length);
        }

        this.preloadScriptPath = await generatePreloadScript({
            tempDir,
            coverageFile:  this.coverageFilePath,
            eagerModules:  this.cachedEagerModules,
        });
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Preload script generated at: %s', this.preloadScriptPath);

        // Pre-warm the sanitized bunfig cache so that dryRun/mutantRun can use the
        // cached path synchronously (avoiding async overhead on the hot path).
        // ensureSanitizedBunfig() will regenerate if cwd changes between phases.
        await this.ensureSanitizedBunfig();

        // Pre-warm the test-file list so that dryRun() and mutantRun() can use the
        // cached result without adding an async I/O hop on the fake-timer-sensitive
        // hot path.  If cwd changes between init and dryRun (Stryker sandbox rotation)
        // the cache check in dryRun/mutantRun will still re-glob as needed.
        this.cachedTestFiles = await discoverTestFiles(process.cwd(), this.logger);
    }

    /**
   * Regenerate the sanitized bunfig if the worker's cwd has changed (or if this
   * is the first spawn). Bun resolves relative paths in a bunfig against the
   * bunfig file's location, so keying on cwd ensures preload/root paths land in
   * the right sandbox.
   */
    private async ensureSanitizedBunfig(): Promise<string> {
        const cwd = process.cwd();
        if(this.sanitizedBunfigPath && this.sanitizedBunfigCwd === cwd) {
            return this.sanitizedBunfigPath;
        }
        if(this.sanitizedBunfigPath) {
            await cleanupSanitizedBunfig(this.sanitizedBunfigPath);
        }
        const tempDir = this.tempDir ?? join(tmpdir(), 'stryker-bun-runner');
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
            const raw = await fsPromises.readFile(registryPath, 'utf-8');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic JSON parse
            const parsed = JSON.parse(raw) as any;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- dynamic JSON
            if(parsed.version !== 1) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn('dryRun registry file has unexpected version %s; skipping', String(parsed.version));
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- dynamic JSON shape check
            if(!Array.isArray(parsed.cachedTestNames) || !Array.isArray(parsed.baseNameIndex)) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'dryRun registry file is malformed (cachedTestNames or baseNameIndex missing or not an array); treating as absent'
                );
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- loading serialised registry
            this.cachedTestNames = new Set<string>(parsed.cachedTestNames as string[]);
            this.baseNameIndex   = new Map<string, string[]>(
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- loading serialised registry
                parsed.baseNameIndex as [string, string[]][]
            );
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug('Loaded dryRun registry from %s (%d entries)', registryPath, this.cachedTestNames.size);
        } catch (err) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type narrowing on unknown error
            const code = (err as any)?.code as string | undefined;
            if(code === 'ENOENT') {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'dryRun registry file not found at %s; killedBy names for static-coverage mutants may be unresolved',
                    registryPath
                );
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
   * Build test results from inspector data
   */
    private buildTestsFromInspector(
        testHierarchy: TestInfo[],
        executionOrder: number[],
        parsed: ParsedTestResults,
        totalElapsedMs: number
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

        // Stryker disable next-line EqualityOperator, ConditionalExpression: >= 0 is equivalent to .length check; true is equivalent when array has elements
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

            const uniqueName = buildUniqueTestName(testInfo.fullName, testInfo.url);
            const status = testInfo.status;
            const elapsed = testInfo.elapsed !== undefined
                ? Math.round(testInfo.elapsed / 1_000_000)  // Convert nanoseconds to milliseconds and round
                : timePerTest;                               // Already in milliseconds

            if(status === 'fail') {
                // Find failure message from parsed output
                const parsedTest = parsed.tests.find(t => t.name.includes(testInfo.name));
                return {
                    id:             uniqueName,
                    name:           uniqueName,
                    fileName:       normalizeTestFilePath(testInfo.url),
                    startPosition:  testInfo.line !== undefined ? { line: testInfo.line, column: 0 } : undefined,
                    status:         TestStatus.Failed,
                    // Stryker disable next-line StringLiteral: fallback error message has no behavioral impact
                    failureMessage: parsedTest?.failureMessage ?? testInfo.error?.message ?? 'Test failed',
                    timeSpentMs:    elapsed,
                } satisfies FailedTestResult;
            }

            if(status === 'skip' || status === 'todo') {
                return {
                    id:            uniqueName,
                    name:          uniqueName,
                    fileName:      normalizeTestFilePath(testInfo.url),
                    startPosition: testInfo.line !== undefined ? { line: testInfo.line, column: 0 } : undefined,
                    status:        TestStatus.Skipped,
                    timeSpentMs:   elapsed,
                } satisfies SkippedTestResult;
            }

            return {
                id:            uniqueName,
                name:          uniqueName,
                fileName:      normalizeTestFilePath(testInfo.url),
                startPosition: testInfo.line !== undefined ? { line: testInfo.line, column: 0 } : undefined,
                status:        TestStatus.Success,
                timeSpentMs:   elapsed,
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
                const lineA = 'startPosition' in a && a.startPosition ? a.startPosition.line : Infinity;
                const lineB = 'startPosition' in b && b.startPosition ? b.startPosition.line : Infinity;
                return lineA - lineB;
            });
            for(let i = 0; i < group.length; i++) {
                const test = group[i];
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

        // 3. Start bun test with --inspect (process will start immediately)
        const startTime = Date.now();
        let inspector: InspectorClient | null = null;
        let inspectorUrl: string | null = null;

        // Use cached bunfig path synchronously when available (pre-warmed by init()).
        // Fall back to async generation only when cwd has changed (Stryker sandbox rotation).
        const cwd = process.cwd();
        const bunfigPath = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === cwd)
            ? this.sanitizedBunfigPath
            : await this.ensureSanitizedBunfig();

        // Discover test files in a deterministic sorted order.
        // This eliminates APFS readdir non-determinism that causes perTest coverage drift.
        // Cache the result so mutantRun workers can reuse it without re-globbing.
        if(!this.cachedTestFiles) {
            this.cachedTestFiles = await discoverTestFiles(process.cwd(), this.logger);
        }

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
            testFiles:        this.cachedTestFiles,
            onInspectorReady: (url: string) => {
                inspectorUrl = url;
            },
        });

        // 4. Wait for inspector URL with timeout
        const waitStart = Date.now();
        // Stryker disable next-line EqualityOperator: timing boundary < vs <= is non-deterministic and equivalent
        // eslint-disable-next-line no-unmodified-loop-condition -- modified by async callback in runBunTests
        while(!inspectorUrl && Date.now() - waitStart < this.inspectorTimeout) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        if(!inspectorUrl) {
            // Await the child to drain its stdout/stderr so we can surface what Bun
            // actually emitted before we abandoned it.  Some setups (e.g. preload
            // scripts that fail to resolve) can make Bun exit before the inspector
            // banner is printed; without this diagnostic the user only sees a
            // useless "Timeout waiting for inspector URL".
            const diagnosticResult = await testProcess;
            const stdoutPreview = (diagnosticResult.stdout ?? '').slice(0, 1000);
            const stderrPreview = (diagnosticResult.stderr ?? '').slice(0, 1000);
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.error(
                'Failed to get inspector URL within timeout (%dms).\nexit=%s timedOut=%s\n'
                + '--- STDOUT (first 1000 chars) ---\n%s\n'
                + '--- STDERR (first 1000 chars) ---\n%s',
                this.inspectorTimeout,
                String(diagnosticResult.exitCode),
                String(diagnosticResult.timedOut),
                stdoutPreview || '(empty)',
                stderrPreview || '(empty)'
            );
            await syncServer.close();
            return {
                status:       DryRunStatus.Error,
                errorMessage: 'Timeout waiting for inspector URL',
            };
        }

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Inspector URL: %s', inspectorUrl);

        // 5. Create inspector client
        inspector = new InspectorClient({
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
            await inspector.close();
            await syncServer.close();
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

        // 10. Close sync server
        await syncServer.close();

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Inspector collected %d tests in hierarchy, %d in execution order',
            testHierarchy.length, executionOrder.length);

        // 11. Handle timeout
        if(result.timedOut) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.warn('Dry run timed out');
            return { status: DryRunStatus.Timeout };
        }

        // 12. Parse console output for failure details (still useful)
        const parsed = parseBunTestOutput(result.stdout, result.stderr);

        // 13. Check for process errors
        if(result.exitCode !== 0 && parsed.failed === 0) {
            return {
                status:       DryRunStatus.Error,
                errorMessage: `Bun test process failed with exit code ${result.exitCode}\n${result.stderr}`,
            };
        }

        // 14. Collect coverage data
        let mutantCoverage;
        if(this.coverageFilePath) {
            mutantCoverage = await collectCoverage(this.coverageFilePath, this.logger);
            await cleanupCoverageFile(this.coverageFilePath);
        }

        // 14a. Remap coverage from counter-based IDs (test-1, test-2) to full test names
        if(mutantCoverage) {
            const testMap = new Map(testHierarchy.map(t => [t.id, t]));
            mutantCoverage = mapCoverageToInspectorIds(mutantCoverage, executionOrder, testMap, this.logger);
        }

        // 15. Build test results from inspector data
        const tests = this.buildTestsFromInspector(testHierarchy, executionOrder, parsed, totalElapsedMs);

        // Sort tests by name to ensure consistent order across runs
        // This is critical for Stryker's incremental mode - test IDs are assigned
        // based on order, so inconsistent order breaks coveredBy correlation
        tests.sort((a, b) => a.name.localeCompare(b.name));

        // Cache test names for killedBy resolution in mutantRun
        this.cachedTestNames = new Set(tests.map(t => t.name));
        if(tests.length !== this.cachedTestNames.size) {
            const nameCount = new Map<string, number>();
            for(const test of tests) {
                nameCount.set(test.name, (nameCount.get(test.name) ?? 0) + 1);
            }
            const duplicates = Array.from(nameCount.entries())
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
            if(base !== id) {
                this.baseNameIndex.set(id, [id]);
            }
        }
        // Stryker disable next-line StringLiteral: diagnostic logging message
        this.logger.debug('Cached %d test names from dry run for killedBy resolution', this.cachedTestNames.size);

        // Persist the registry to a well-known file so other worker processes (which
        // never run dryRun) can lazy-load it when handling static-coverage mutants
        // (testFilter is empty for those, so the local index can't help them).
        // We write to a .tmp path first and then rename: on POSIX, fs.rename is
        // atomic, so readers always see either the previous complete file or the new
        // complete file — never a partial write.  A leftover .tmp file after a crash
        // mid-rename is harmless (it will be overwritten on the next dryRun).
        try {
            const registryPath = this.registryPath;
            const tmpPath = this.registryTmpPath;
            const registryData = JSON.stringify({
                version:        1,
                writtenAt:      Date.now(),
                cachedTestNames: Array.from(this.cachedTestNames),
                baseNameIndex:   Array.from(this.baseNameIndex.entries()),
            });
            await fsPromises.writeFile(tmpPath, registryData, 'utf-8');
            this.lastRegistryTmpPath = tmpPath;
            await fsPromises.rename(tmpPath, registryPath);
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug('Wrote dryRun registry to %s (%d entries)', registryPath, this.cachedTestNames.size);
        } catch (registryErr) {
            // Non-fatal: the worker that did dryRun still has its in-memory copy.
            // Other workers will fall back to raw names and log a warning.
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.warn('Failed to write dryRun registry file: %s', registryErr instanceof Error ? registryErr.message : String(registryErr));
        }

        return {
            status: DryRunStatus.Complete,
            tests,
            mutantCoverage,
        };
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
        // testFilter carries the full registry IDs Stryker wants us to run, including
        // any " [N]" dedup suffixes. Building the index here means all 12 mutantRun
        // workers behave identically on the first shot, eliminating incremental drift
        // caused by workers that never ran dryRun falling through to raw names.
        // Note: this.baseNameIndex only exists on the single worker that ran dryRun.
        const localTestFilter = options.testFilter ?? [];
        const localRegistry = new Set<string>(localTestFilter);
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
        const bunfigPath = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === mutantCwd)
            ? this.sanitizedBunfigPath
            : await this.ensureSanitizedBunfig();

        // Reuse the sorted test-file list cached during dryRun.
        // If this worker never ran dryRun (cachedTestFiles is undefined), discover
        // the files now and cache them for subsequent mutantRun calls on this worker.
        if(!this.cachedTestFiles) {
            this.cachedTestFiles = await discoverTestFiles(process.cwd(), this.logger);
        }

        const result = await runBunTests({
            bunPath:         this.bunPath,
            timeout:         this.timeout,
            env:             this.env,
            bunArgs:         this.bunArgs,
            bunfigPath,
            activeMutant:    options.activeMutant.id,
            bail:            true,            // Bail on first failure for mutant runs
            sequentialMode:  true,            // Match dryRun's serialized execution for deterministic results
            preloadScript:   this.preloadScriptPath, // Needed to set globalThis.__stryker__.activeMutant
            testNamePattern, // undefined → no filter → full suite (current behaviour)
            testFiles:       this.cachedTestFiles,
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
        // The sanitised bunfig we pass via --config disables coverage/coverageThreshold/
        // onlyFailures, so exit != 0 here should be a genuine test failure or a runtime
        // error — never a bunfig-induced threshold miss.
        if(result.exitCode !== 0) {
            const rawFailedNames = parsed.tests
                .filter(test => test.status === 'failed')
                .map(test => normalizeTestName(test.name));

            // Check for runtime errors: tests couldn't run due to module/syntax errors
            // These should be RuntimeError, not Killed, and don't need killedBy for caching
            if(rawFailedNames.length === 0 && parsed.tests.length === 0) {
                const stderr = result.stderr ?? '';
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
                        options.activeMutant.id,
                        stderr.slice(0, 200)
                    );
                    return {
                        status:       MutantRunStatus.Error,
                        errorMessage: stderr.slice(0, 500) || `Runtime error with exit code ${result.exitCode}`,
                    };
                }
            }

            // Resolve each normalised failed test name against the test registry.
            // Console-parser output lacks the [N] dedup suffix that dryRun appends when
            // multiple tests share the same base name (e.g. it.each with %s).
            //
            // Fallback chain — stops at the FIRST successful resolution for each name:
            //   1. Exact match in localRegistry (built from testFilter)
            //   2. Base-name match in localBaseIndex (built from testFilter)
            //   3. Exact match in this.cachedTestNames (instance registry from dryRun)
            //   4. Base-name match in this.baseNameIndex (instance registry from dryRun)
            //   5. Raw name as-is with a warn log — last resort if nothing resolves.
            //
            // Steps 1–2 use the local index (cheapest, smallest, always present when
            // testFilter is non-empty).  Steps 3–4 cover leaked tests: Bun's
            // --test-name-pattern is a hierarchy regex and may run tests that are NOT in
            // testFilter; those names won't be in localRegistry so we fall through to the
            // instance registry loaded from the dryRun worker's persisted JSON.
            const killedBySet = new Set<string>();
            for(const name of rawFailedNames) {
                // Step 1: exact match in local index
                if(localRegistry.has(name)) {
                    killedBySet.add(name);
                    continue;
                }

                // Step 2: base-name match in local index
                const localBucket = localBaseIndex.get(name);
                if(localBucket) {
                    // Stryker disable next-line StringLiteral: diagnostic logging message
                    this.logger.debug(
                        'Expanded killedBy base name "%s" → %d local registry IDs for mutant %s',
                        name,
                        localBucket.length,
                        options.activeMutant.id
                    );
                    for(const id of localBucket) {
                        killedBySet.add(id);
                    }
                    continue;
                }

                // Step 3: exact match in instance registry (dryRun worker or loaded from file)
                if(this.cachedTestNames?.has(name)) {
                    killedBySet.add(name);
                    continue;
                }

                // Step 4: base-name match in instance registry
                const instanceBucket = this.baseNameIndex?.get(name);
                if(instanceBucket) {
                    // Stryker disable next-line StringLiteral: diagnostic logging message
                    this.logger.debug(
                        'Expanded killedBy base name "%s" → %d instance registry IDs for mutant %s',
                        name,
                        instanceBucket.length,
                        options.activeMutant.id
                    );
                    for(const id of instanceBucket) {
                        killedBySet.add(id);
                    }
                    continue;
                }

                // Step 5: nothing matched — include as-is and warn
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'killedBy name "%s" for mutant %s not found in test registry; '
                    + 'including as-is (may break incremental cache)',
                    name,
                    options.activeMutant.id
                );
                killedBySet.add(name);
            }

            const killedBy = Array.from(killedBySet);

            // If we still have nothing (genuinely unparseable Bun output), fall back to 'unknown'
            // and log a stderr preview so the underlying cause can be diagnosed.
            if(killedBy.length === 0) {
                const stdoutPreview = (result.stdout ?? '').slice(0, 600);
                const stderrPreview = (result.stderr ?? '').slice(0, 600);
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'No failed tests identified for mutant %s — Bun output could not be parsed; '
                    + 'using "unknown" fallback (breaks incremental cache)\n'
                    + 'exit=%s\n--- STDOUT (first 600 chars) ---\n%s\n'
                    + '--- STDERR (first 600 chars) ---\n%s',
                    options.activeMutant.id,
                    String(result.exitCode),
                    stdoutPreview || '(empty)',
                    stderrPreview || '(empty)'
                );
                killedBy.push('unknown');
            }

            return {
                status:   MutantRunStatus.Killed,
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

        // Exit code 0 means all tests passed, mutant survived
        return {
            status:    MutantRunStatus.Survived,
            nrOfTests: parsed.totalTests,
        };
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
