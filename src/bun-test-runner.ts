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
    cleanupCoverageFile
} from './coverage/index.js';
import { mapCoverageToInspectorIds } from './coverage/coverage-mapper.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InspectorClient } from './inspector/index.js';
import { getAvailablePort, SyncServer } from './utils/index.js';
import type { TestInfo } from './inspector/types.js';

/**
 * Normalize a sandbox file path to a relative path.
 * Stryker runs tests in a sandbox directory, but the incremental file
 * uses relative paths. We need to strip the sandbox prefix to enable caching.
 *
 * Input:  /path/to/project/.stryker-tmp/sandbox-ABC123/tests/unit/foo.test.ts
 * Output: tests/unit/foo.test.ts
 */
export function normalizeTestFilePath(url: string | undefined): string | undefined {
    if(!url) {
        return undefined;
    }

    // Look for .stryker-tmp/sandbox-XXXXX/ pattern and extract path after it
    // Stryker disable next-line Regex: character classes are defensive for path extraction
    const sandboxMatch = /\.stryker-tmp\/sandbox-[^/]+\/(.+)$/.exec(url);
    if(sandboxMatch) {
        return sandboxMatch[1];
    }

    // If no sandbox pattern, return as-is (might already be relative or a different format)
    return url;
}

/**
 * Normalize test names by replacing non-printable ASCII characters with underscores.
 * This ensures consistent test name matching between dry run (inspector) and mutant run (console parser).
 *
 * Safe characters: ASCII 32-126 (printable ASCII: space through tilde)
 * Unsafe characters: Control chars, newlines, tabs, non-ASCII → replaced with underscore 1:1
 *
 * Note: The ' > ' sequence is used as a hierarchy delimiter by Bun. If a test name
 * literally contains ' > ', it will cause parsing ambiguity. This is a known limitation.
 *
 * @param testName - The test name to normalize
 * @returns Normalized test name with unsafe characters replaced by underscores
 */
export function normalizeTestName(testName: string): string {
    // Replace any character outside printable ASCII range (32-126) with underscore
    // This handles newlines, tabs, control chars, and non-ASCII characters
    // Each unsafe character is replaced with exactly one underscore to preserve uniqueness
    // Also trim whitespace to handle cases like "should %s" where %s is empty string
    // Stryker disable next-line Regex: character class defines safe ASCII range
    return testName.replace(/[^\x20-\x7E]/g, '_').trim();
}

/**
 * Builds a unique test identifier by combining file path and test hierarchy.
 * This prevents test name collisions when multiple files have identical describe blocks.
 *
 * Format: "path/to/file.test.ts > describe > test name"
 *
 * If no URL is provided, returns just the normalized test name without path prefix.
 *
 * @param fullName - The full hierarchical test name from inspector (e.g., "Suite > test")
 * @param url - The file URL from inspector (e.g., "file:///path/.stryker-tmp/sandbox-ABC/tests/foo.test.ts")
 * @returns Unique test identifier with file path prefix, or just normalized name if no URL
 *
 * @example
 * ```typescript
 * buildUniqueTestName("Suite > test", "file:///path/.stryker-tmp/sandbox-ABC/tests/foo.test.ts")
 * // Returns: "tests/foo.test.ts > Suite > test"
 *
 * buildUniqueTestName("Suite > test", undefined)
 * // Returns: "Suite > test"
 * ```
 */
export function buildUniqueTestName(fullName: string, url: string | undefined): string {
    const normalizedPath = normalizeTestFilePath(url);
    if(normalizedPath) {
        return normalizeTestName(`${normalizedPath} > ${fullName}`);
    }
    return normalizeTestName(fullName);
}

/**
 * Strip file prefix from test names for consistency with inspector format.
 * Console parser includes file prefixes like "tests/file.test.ts > Suite > Test"
 * but inspector provides "Suite > Test" without the file prefix.
 * This normalizes console parser output to match inspector format for killedBy.
 *
 * Input:  "tests/unit/something.test.ts > Suite > Test"
 * Output: "Suite > Test"
 *
 * @param testName - The test name potentially with file prefix
 * @param logger - Optional logger for diagnostic output when regex doesn't match
 */
export function stripFilePrefix(testName: string, logger?: Logger): string {
    // Pattern: "path/to/file.test.ts > " or "path/to/file.spec.ts > " at the start
    // Strip everything up to and including the first " > " if it looks like a file path
    // Stryker disable next-line Regex: character classes are defensive for test name parsing
    const match = /^[^\s>]+\.(?:test|spec)\.[jt]sx? > (.+)$/.exec(testName);
    if(!match && logger) {
        // Stryker disable next-line StringLiteral: diagnostic logging message
        logger.debug('stripFilePrefix: regex did not match for input: "%s"', testName);
    }
    return match ? match[1] : testName;
}

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
    private preloadScriptPath?:        string;
    private coverageFilePath?:         string;
    private cachedTestNames?:          Set<string>;

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
        this.coverageFilePath = join(tempDir, `coverage-${Date.now()}.json`);

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Generating coverage preload script...');
        this.preloadScriptPath = await generatePreloadScript({
            tempDir,
            coverageFile: this.coverageFilePath,
        });
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Preload script generated at: %s', this.preloadScriptPath);
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
        // Bun's inspector reports the template literal instead of interpolated values
        const nameCounts = new Map<string, number>();
        for(const test of tests) {
            nameCounts.set(test.name, (nameCounts.get(test.name) ?? 0) + 1);
        }

        // For names that appear multiple times, append index suffix [0], [1], etc.
        const nameIndexes = new Map<string, number>();
        for(const test of tests) {
            const originalName = test.name;
            const count = nameCounts.get(originalName) ?? 1;
            if(count > 1) {
                const index = nameIndexes.get(originalName) ?? 0;
                const uniqueName = `${originalName} [${index}]`;
                test.id = uniqueName;
                test.name = uniqueName;
                nameIndexes.set(originalName, index + 1);
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

        // Start test process with callback to get inspector URL
        const testProcess = runBunTests({
            bunPath:          this.bunPath,
            timeout:          this.timeout,
            env:              this.env,
            bunArgs:          this.bunArgs,
            preloadScript:    this.preloadScriptPath,
            coverageFile:     this.coverageFilePath,
            inspectWaitPort:  inspectPort,
            sequentialMode:   true,  // Critical for correlation
            syncPort, // Pass sync port to preload script via env var
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
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.error('Failed to get inspector URL within timeout');
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
            handlers:          {},  // No longer relaying test names - coverage uses counter-based IDs
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
            mutantCoverage = await collectCoverage(this.coverageFilePath);
            await cleanupCoverageFile(this.coverageFilePath);
        }

        // 14a. Remap coverage from counter-based IDs (test-1, test-2) to full test names
        if(mutantCoverage) {
            const testMap = new Map(testHierarchy.map(t => [t.id, t]));
            mutantCoverage = mapCoverageToInspectorIds(mutantCoverage, executionOrder, testMap);
        }

        // 15. Build test results from inspector data
        const tests = this.buildTestsFromInspector(testHierarchy, executionOrder, parsed, totalElapsedMs);

        // Sort tests by name to ensure consistent order across runs
        // This is critical for Stryker's incremental mode - test IDs are assigned
        // based on order, so inconsistent order breaks coveredBy correlation
        tests.sort((a, b) => a.name.localeCompare(b.name));

        // Cache test names for diagnostic validation in mutantRun
        this.cachedTestNames = new Set(tests.map(t => t.name));
        // Diagnostic: find duplicate test names
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
        // Stryker disable next-line StringLiteral: diagnostic logging message
        this.logger.debug('Cached %d test names from dry run for killedBy validation', this.cachedTestNames.size);

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

        // Run all tests with bail on first failure
        // We don't filter by testFilter because:
        // 1. Test IDs from dry run don't match Bun's test name patterns (counter may differ)
        // 2. Coverage data still helps Stryker optimize which mutants to run
        // 3. Bail on first failure provides efficiency
        // IMPORTANT: Preload script IS needed to set globalThis.__stryker__.activeMutant
        // The preload script skips coverage collection when __STRYKER_ACTIVE_MUTANT__ is set
        const result = await runBunTests({
            bunPath:       this.bunPath,
            timeout:       this.timeout,
            env:           this.env,
            bunArgs:       this.bunArgs,
            activeMutant:  options.activeMutant.id,
            bail:          true, // Bail on first failure for mutant runs
            noCoverage:    true, // Disable coverage for mutant runs - we only need pass/fail
            preloadScript: this.preloadScriptPath, // Needed to set globalThis.__stryker__.activeMutant
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

        // Non-zero exit code means tests failed, mutant is killed
        // Trust exit code over parsed output since bunfig.toml may hide passing tests
        if(result.exitCode !== 0) {
            const killedBy = parsed.tests
        .filter(test => test.status === 'failed')
        .map(test => normalizeTestName(test.name));

            // Check for runtime errors: tests couldn't run due to module/syntax errors
            // These should be RuntimeError, not Killed, and don't need killedBy for caching
            if(killedBy.length === 0 && parsed.tests.length === 0) {
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

            // Diagnostic: Log when no failed tests identified by console parser
            // This results in killedBy: ['unknown'] which breaks Stryker's incremental cache
            if(killedBy.length === 0) {
                // Stryker disable all: diagnostic logging block
                this.logger.debug(
                    'CACHE WARNING: No failed tests identified for mutant %s (will use "unknown" fallback). '
                    + 'Exit code: %d, Parser found: %d total / %d passed / %d failed. '
                    + 'Parsed tests: %o',
                    options.activeMutant.id,
                    result.exitCode,
                    parsed.totalTests,
                    parsed.passed,
                    parsed.failed,
                    parsed.tests.map(t => ({ name: t.name, status: t.status }))
                );
                // Log first 500 chars of stdout/stderr to help diagnose parsing issues
                if(result.stdout || result.stderr) {
                    const stdoutPreview = result.stdout?.slice(0, 500) || '(empty)';
                    const stderrPreview = result.stderr?.slice(0, 500) || '(empty)';
                    this.logger.debug(
                        'CACHE WARNING: Raw output for mutant %s - stdout: %s%s - stderr: %s%s',
                        options.activeMutant.id,
                        stdoutPreview,
                        result.stdout && result.stdout.length > 500 ? '...(truncated)' : '',
                        stderrPreview,
                        result.stderr && result.stderr.length > 500 ? '...(truncated)' : ''
                    );
                }
                // Stryker restore all
            }

            // Diagnostic: Validate killedBy entries exist in test registry from dry run
            if(killedBy.length > 0 && this.cachedTestNames) {
                const unknownKillers = killedBy.filter(k => !this.cachedTestNames!.has(k));
                if(unknownKillers.length > 0) {
                    // Stryker disable all: diagnostic logging block
                    this.logger.debug(
                        'CACHE WARNING: killedBy for mutant %s contains %d test name(s) not in registry '
                        + '(will break incremental cache): %s',
                        options.activeMutant.id,
                        unknownKillers.length,
                        unknownKillers.join(', ')
                    );
                    // Log a sample of known test names for comparison
                    const sampleKnown = Array.from(this.cachedTestNames).slice(0, 5);
                    this.logger.debug(
                        'CACHE WARNING: Sample of known test names from registry (first 5 of %d): %s',
                        this.cachedTestNames.size,
                        sampleKnown.join(', ')
                    );
                    // Stryker restore all
                }
            }

            return {
                status:         MutantRunStatus.Killed,
                // Stryker disable next-line ConditionalExpression: killedBy.length > 0 check provides fallback when no failed tests identified
                killedBy:       killedBy.length > 0 ? killedBy : ['unknown'],
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
    }
}
