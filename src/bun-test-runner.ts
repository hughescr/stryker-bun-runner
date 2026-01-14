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
function normalizeTestFilePath(url: string | undefined): string | undefined {
    if(!url) {
        return undefined;
    }

    // Look for .stryker-tmp/sandbox-XXXXX/ pattern and extract path after it
    const sandboxMatch = /\.stryker-tmp\/sandbox-[^/]+\/(.+)$/.exec(url);
    if(sandboxMatch) {
        return sandboxMatch[1];
    }

    // If no sandbox pattern, return as-is (might already be relative or a different format)
    return url;
}

/**
 * Strip file prefix from test names for consistency with inspector format.
 * Console parser includes file prefixes like "tests/file.test.ts > Suite > Test"
 * but inspector provides "Suite > Test" without the file prefix.
 * This normalizes console parser output to match inspector format for killedBy.
 *
 * Input:  "tests/unit/something.test.ts > Suite > Test"
 * Output: "Suite > Test"
 */
function stripFilePrefix(testName: string): string {
    // Pattern: "path/to/file.test.ts > " or "path/to/file.spec.ts > " at the start
    // Strip everything up to and including the first " > " if it looks like a file path
    const match = /^[^\s>]+\.(?:test|spec)\.[jt]sx? > (.+)$/.exec(testName);
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
        this.logger.debug('BunTestRunner init starting...');

        // Generate preload script for coverage collection
        const tempDir = join(tmpdir(), 'stryker-bun-runner');
        this.coverageFilePath = join(tempDir, `coverage-${Date.now()}.json`);

        this.logger.debug('Generating coverage preload script...');
        this.preloadScriptPath = await generatePreloadScript({
            tempDir,
            coverageFile: this.coverageFilePath,
        });
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
                if(t.status === 'failed') {
                    return {
                        id:             t.name,
                        name:           t.name,
                        status:         TestStatus.Failed,
                        failureMessage: t.failureMessage ?? 'Test failed',
                        timeSpentMs:    t.duration ?? 1,
                    } satisfies FailedTestResult;
                }
                if(t.status === 'skipped') {
                    return {
                        id:          t.name,
                        name:        t.name,
                        status:      TestStatus.Skipped,
                        timeSpentMs: t.duration ?? 1,
                    } satisfies SkippedTestResult;
                }
                return {
                    id:          t.name,
                    name:        t.name,
                    status:      TestStatus.Success,
                    timeSpentMs: t.duration ?? 1,
                } satisfies SuccessTestResult;
            });
        }

        const timePerTest = executionOrder.length > 0
            ? Math.max(1, Math.floor(totalElapsedMs / executionOrder.length))
            : 1;

        // Create a map for quick lookup
        const testMap = new Map<number, TestInfo>();
        for(const test of testHierarchy) {
            testMap.set(test.id, test);
        }

        return executionOrder.map((inspectorId) => {
            const testInfo = testMap.get(inspectorId);
            if(!testInfo) {
                return {
                    id:          `unknown-${inspectorId}`,
                    name:        `unknown-${inspectorId}`,
                    status:      TestStatus.Success,
                    timeSpentMs: timePerTest,
                } satisfies SuccessTestResult;
            }

            const fullName = testInfo.fullName;
            const status = testInfo.status;
            const elapsed = testInfo.elapsed ?? timePerTest;

            if(status === 'fail') {
                // Find failure message from parsed output
                const parsedTest = parsed.tests.find(t => t.name.includes(testInfo.name));
                return {
                    id:             fullName,
                    name:           fullName,
                    fileName:       normalizeTestFilePath(testInfo.url),
                    startPosition:  undefined,
                    status:         TestStatus.Failed,
                    failureMessage: parsedTest?.failureMessage ?? testInfo.error?.message ?? 'Test failed',
                    timeSpentMs:    elapsed,
                } satisfies FailedTestResult;
            }

            if(status === 'skip' || status === 'todo') {
                return {
                    id:            fullName,
                    name:          fullName,
                    fileName:      normalizeTestFilePath(testInfo.url),
                    startPosition: undefined,
                    status:        TestStatus.Skipped,
                    timeSpentMs:   elapsed,
                } satisfies SkippedTestResult;
            }

            return {
                id:            fullName,
                name:          fullName,
                fileName:      normalizeTestFilePath(testInfo.url),
                startPosition: undefined,
                status:        TestStatus.Success,
                timeSpentMs:   elapsed,
            } satisfies SuccessTestResult;
        });
    }

    /**
   * Run all tests (dry run)
   */
    public async dryRun(): Promise<DryRunResult> {
        this.logger.debug('Running dry run with inspector-based coverage collection...');

        // 1. Get available ports for inspector and sync server
        const inspectPort = await getAvailablePort();
        const syncPort = await getAvailablePort();
        this.logger.debug('Using inspector port: %d, sync port: %d', inspectPort, syncPort);

        // 2. Start sync server
        const syncServer = new SyncServer({ port: syncPort, timeout: this.inspectorTimeout });
        try {
            await syncServer.start();
            this.logger.debug('Sync server started on port %d', syncPort);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
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
        // eslint-disable-next-line no-unmodified-loop-condition -- modified by async callback in runBunTests
        while(!inspectorUrl && Date.now() - waitStart < this.inspectorTimeout) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        if(!inspectorUrl) {
            this.logger.error('Failed to get inspector URL within timeout');
            await syncServer.close();
            return {
                status:       DryRunStatus.Error,
                errorMessage: 'Timeout waiting for inspector URL',
            };
        }

        this.logger.debug('Inspector URL: %s', inspectorUrl);

        // 5. Create inspector client with test start handler
        inspector = new InspectorClient({
            url:               inspectorUrl,
            connectionTimeout: this.inspectorTimeout,
            requestTimeout:    this.inspectorTimeout,
            handlers:          {
                onTestStart: (test) => {
                    // Relay test name to preload script via sync server
                    syncServer.sendTestStart(test.fullName);
                },
            },
        });

        // 6. Connect inspector client and enable test reporting
        try {
            await inspector.connect();
            await inspector.send('TestReporter.enable', {});
            this.logger.debug('Inspector connected and TestReporter enabled');
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
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

        this.logger.debug('Inspector collected %d tests in hierarchy, %d in execution order',
            testHierarchy.length, executionOrder.length);

        // 11. Handle timeout
        if(result.timedOut) {
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
        .map(test => stripFilePrefix(test.name));

            return {
                status:         MutantRunStatus.Killed,
                killedBy:       killedBy.length > 0 ? killedBy : ['unknown'],
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
        this.logger.debug('Disposing BunTestRunner');

        // Clean up preload script
        if(this.preloadScriptPath) {
            this.logger.debug('Cleaning up preload script: %s', this.preloadScriptPath);
            await cleanupPreloadScript(this.preloadScriptPath);
        }

        // Clean up coverage file if it still exists
        if(this.coverageFilePath) {
            this.logger.debug('Cleaning up coverage file: %s', this.coverageFilePath);
            await cleanupCoverageFile(this.coverageFilePath);
        }
    }
}
