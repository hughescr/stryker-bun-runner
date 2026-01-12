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
  SkippedTestResult,
} from '@stryker-mutator/api/test-runner';
import {
  DryRunStatus,
  MutantRunStatus,
  TestStatus,
} from '@stryker-mutator/api/test-runner';
import { StrykerOptions } from '@stryker-mutator/api/core';
import { Logger } from '@stryker-mutator/api/logging';
import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import { StrykerBunOptions } from './options.js';
import { runBunTests } from './process-runner.js';
import { parseBunTestOutput } from './parsers/console-parser.js';
import {
  generatePreloadScript,
  cleanupPreloadScript,
  collectCoverage,
  cleanupCoverageFile,
} from './coverage/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { parseJunitXml, type JUnitTestResult } from './parsers/junit-parser.js';
import { readBunfig, getJunitOutputPath } from './config/bunfig-reader.js';

/**
 * Bun test runner for Stryker mutation testing
 */
export class BunTestRunner implements TestRunner {
  public static readonly inject = tokens(commonTokens.logger, commonTokens.options);

  private readonly bunPath: string;
  private readonly timeout: number;
  private readonly env?: Record<string, string>;
  private readonly bunArgs?: string[];
  private preloadScriptPath?: string;
  private coverageFilePath?: string;
  private junitOutputPath?: string;
  private junitFromBunfig: boolean = false;

  constructor(
    private readonly logger: Logger,
    options: StrykerOptions
  ) {
    const bunOptions = (options as StrykerBunOptions).bun ?? {};

    this.bunPath = bunOptions.bunPath ?? 'bun';
    this.timeout = bunOptions.timeout ?? 10000;
    this.env = bunOptions.env;
    this.bunArgs = bunOptions.bunArgs;

    this.logger.debug('BunTestRunner initialized with options: %o', {
      bunPath: this.bunPath,
      timeout: this.timeout,
      env: this.env,
      bunArgs: this.bunArgs,
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

    // Skip bun validation for now - it might affect progress reporter
    // TODO: Re-enable validation once progress issue is resolved

    // Generate preload script for coverage collection
    const tempDir = join(tmpdir(), 'stryker-bun-runner');
    this.coverageFilePath = join(tempDir, `coverage-${Date.now()}.json`);

    this.logger.debug('Generating coverage preload script...');
    this.preloadScriptPath = await generatePreloadScript({
      tempDir,
      coverageFile: this.coverageFilePath,
    });
    this.logger.debug('Preload script generated at: %s', this.preloadScriptPath);

    // Check bunfig.toml for JUnit reporter configuration
    const bunfig = await readBunfig(process.cwd());
    const bunfigJunitPath = getJunitOutputPath(bunfig, process.cwd());

    if (bunfigJunitPath) {
      // Use user's configured JUnit output path
      this.junitOutputPath = bunfigJunitPath;
      this.junitFromBunfig = true;
      this.logger.debug('Using JUnit output from bunfig.toml: %s', this.junitOutputPath);
    } else {
      // Generate temp path for JUnit output
      this.junitOutputPath = join(tempDir, `junit-${Date.now()}.xml`);
      this.junitFromBunfig = false;
      this.logger.debug('JUnit output will be written to temp file: %s', this.junitOutputPath);
    }
  }

  /**
   * Run all tests (dry run)
   */
  public async dryRun(): Promise<DryRunResult> {
    this.logger.debug('Running dry run with coverage collection...');

    const startTime = Date.now();
    const result = await runBunTests({
      bunPath: this.bunPath,
      timeout: this.timeout,
      env: this.env,
      bunArgs: this.bunArgs,
      preloadScript: this.preloadScriptPath,
      coverageFile: this.coverageFilePath,
      // Only pass junitOutputFile if not already configured in bunfig.toml
      junitOutputFile: this.junitFromBunfig ? undefined : this.junitOutputPath,
    });
    const totalElapsedMs = Date.now() - startTime;

    if (result.timedOut) {
      // Stryker disable next-line all: Logging statement
      this.logger.warn('Dry run timed out');
      return {
        status: DryRunStatus.Timeout,
      };
    }

    // Log raw output for debugging
    // Stryker disable next-line all: Logging statement
    this.logger.debug('Bun test stdout (first 500 chars): %s', result.stdout.substring(0, 500));
    // Stryker disable next-line all: Logging statement
    this.logger.debug('Bun test stderr (first 500 chars): %s', result.stderr.substring(0, 500));
    // Stryker disable next-line all: Logging statement
    this.logger.debug('Bun test exit code: %d', result.exitCode);

    const parsed = parseBunTestOutput(result.stdout, result.stderr);

    this.logger.debug('Dry run completed: %o', {
      totalTests: parsed.totalTests,
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      parsedTestCount: parsed.tests.length,
    });

    // Check for errors
    if (result.exitCode !== 0 && parsed.failed === 0) {
      // Process error, not test failures
      return {
        status: DryRunStatus.Error,
        errorMessage: `Bun test process failed with exit code ${result.exitCode}\n${result.stderr}`,
      };
    }

    // Collect coverage data
    let mutantCoverage;
    if (this.coverageFilePath) {
      this.logger.debug('Collecting coverage data from: %s', this.coverageFilePath);
      mutantCoverage = await collectCoverage(this.coverageFilePath);

      if (mutantCoverage) {
        const perTestCount = Object.keys(mutantCoverage.perTest).length;
        const staticCount = Object.keys(mutantCoverage.static).length;
        // Stryker disable next-line all: Logging statement
        this.logger.debug('Coverage collected: %d tests with coverage, %d static mutants', perTestCount, staticCount);
      } else {
        // Stryker disable next-line all: Logging statement
        this.logger.debug('No coverage data collected');
      }

      // Clean up coverage file after reading
      await cleanupCoverageFile(this.coverageFilePath);
    }

    // Parse JUnit XML for test metadata (file names, line numbers)
    // This enables Stryker's incremental mode by providing stable test identifiers
    let junitTests: JUnitTestResult[] = [];
    if (this.junitOutputPath) {
      try {
        const junitXml = await readFile(this.junitOutputPath, 'utf-8');
        junitTests = parseJunitXml(junitXml);
        this.logger.debug('Parsed %d tests from JUnit XML', junitTests.length);
      } catch (error) {
        // Stryker disable next-line all: Logging statement
        this.logger.debug('Failed to read JUnit XML: %s', error);
      }

      // Clean up JUnit file if we created it (not from bunfig)
      if (!this.junitFromBunfig) {
        try {
          await unlink(this.junitOutputPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Build tests array
    // Use JUnit data for test metadata (enables Stryker incremental mode)
    // Fall back to counter-based IDs if JUnit parsing failed
    let tests: Array<SuccessTestResult | FailedTestResult | SkippedTestResult> = [];
    let finalMutantCoverage = mutantCoverage;

    if (mutantCoverage && Object.keys(mutantCoverage.perTest).length > 0 && junitTests.length > 0) {
      // Map coverage data (counter IDs) to JUnit tests (by execution order)
      // Coverage uses: test-1, test-2, ... (counter order)
      // JUnit is in execution order (guaranteed by --no-randomize)
      const coverageTestIds = Object.keys(mutantCoverage.perTest).sort(
        (a, b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1])
      );

      if (coverageTestIds.length === junitTests.length) {
        // Stryker disable next-line all: Logging statement
        this.logger.debug('Mapping %d coverage IDs to JUnit tests', coverageTestIds.length);

        // Build tests with JUnit metadata
        tests = junitTests.map((junit) => {
          if (!junit.passed) {
            return {
              id: junit.fullName,
              name: junit.fullName,
              fileName: junit.fileName,
              startPosition: { line: junit.line, column: 0 },
              status: TestStatus.Failed,
              failureMessage: junit.failureMessage ?? 'Test failed',
              timeSpentMs: Math.round(junit.time * 1000),
            } satisfies FailedTestResult;
          }

          return {
            id: junit.fullName,
            name: junit.fullName,
            fileName: junit.fileName,
            startPosition: { line: junit.line, column: 0 },
            status: TestStatus.Success,
            timeSpentMs: Math.round(junit.time * 1000),
          } satisfies SuccessTestResult;
        });

        // Re-key coverage data with JUnit test IDs
        finalMutantCoverage = {
          static: mutantCoverage.static,
          perTest: Object.fromEntries(
            coverageTestIds.map((oldId, index) => [
              junitTests[index].fullName,
              mutantCoverage.perTest[oldId],
            ])
          ),
        };
      } else {
        // Count mismatch - fall back to existing logic
        // Stryker disable next-line all: Logging statement
        this.logger.debug('Coverage/JUnit count mismatch (%d vs %d), using counter-based IDs',
          coverageTestIds.length, junitTests.length);

        const testNames = Object.keys(mutantCoverage.perTest);
        const failedTestNames = new Set(
          parsed.tests.filter(t => t.status === 'failed').map(t => t.name)
        );
        const timePerTest = testNames.length > 0 ? Math.max(1, Math.floor(totalElapsedMs / testNames.length)) : 1;

        tests = testNames.map(testName => {
          const isFailed = failedTestNames.has(testName);
          const parsedTest = parsed.tests.find(t => t.name === testName);

          if (isFailed && parsedTest) {
            return {
              id: testName,
              name: testName,
              status: TestStatus.Failed,
              failureMessage: parsedTest.failureMessage ?? 'Test failed',
              timeSpentMs: parsedTest.duration ?? timePerTest,
            } satisfies FailedTestResult;
          }

          return {
            id: testName,
            name: testName,
            status: TestStatus.Success,
            timeSpentMs: timePerTest,
          } satisfies SuccessTestResult;
        });
      }
    } else if (mutantCoverage && Object.keys(mutantCoverage.perTest).length > 0) {
      // Coverage data but no JUnit - use counter-based IDs (existing fallback)
      const testNames = Object.keys(mutantCoverage.perTest);
      const failedTestNames = new Set(
        parsed.tests.filter(t => t.status === 'failed').map(t => t.name)
      );

      // Stryker disable next-line all: Logging statement
      this.logger.debug('No JUnit data, using counter-based IDs for %d tests', testNames.length);

      const timePerTest = testNames.length > 0 ? Math.max(1, Math.floor(totalElapsedMs / testNames.length)) : 1;

      tests = testNames.map(testName => {
        const isFailed = failedTestNames.has(testName);
        const parsedTest = parsed.tests.find(t => t.name === testName);

        if (isFailed && parsedTest) {
          return {
            id: testName,
            name: testName,
            status: TestStatus.Failed,
            failureMessage: parsedTest.failureMessage ?? 'Test failed',
            timeSpentMs: parsedTest.duration ?? timePerTest,
          } satisfies FailedTestResult;
        }

        return {
          id: testName,
          name: testName,
          status: TestStatus.Success,
          timeSpentMs: timePerTest,
        } satisfies SuccessTestResult;
      });
    } else {
      // Fallback: use parsed tests from console output when no coverage data
      // Stryker disable next-line all: Logging statement
      this.logger.debug('No coverage data available, using parsed test output');

      const fallbackTimePerTest = parsed.tests.length > 0
        ? Math.max(1, Math.floor(totalElapsedMs / parsed.tests.length))
        : Math.max(1, totalElapsedMs);

      tests = parsed.tests.map(t => {
        const id = t.name;
        const name = t.name;
        const timeSpentMs = t.duration ?? fallbackTimePerTest;

        switch (t.status) {
          case 'passed':
            return {
              id,
              name,
              status: TestStatus.Success,
              timeSpentMs,
            } satisfies SuccessTestResult;
          case 'failed':
            return {
              id,
              name,
              status: TestStatus.Failed,
              failureMessage: t.failureMessage ?? 'Test failed',
              timeSpentMs,
            } satisfies FailedTestResult;
          case 'skipped':
            return {
              id,
              name,
              status: TestStatus.Skipped,
              timeSpentMs,
            } satisfies SkippedTestResult;
        }
      });

      // If no tests were parsed from output, create synthetic tests from summary counts
      if (tests.length === 0 && parsed.passed > 0) {
        // Stryker disable next-line all: Logging statement
        this.logger.debug('No individual tests parsed, creating synthetic tests from summary');
        const syntheticTimePerTest = Math.max(1, Math.floor(totalElapsedMs / parsed.passed));
        for (let i = 0; i < parsed.passed; i++) {
          tests.push({
            id: `test-${i}`,
            name: `test-${i}`,
            status: TestStatus.Success,
            timeSpentMs: syntheticTimePerTest,
          } satisfies SuccessTestResult);
        }
      }
    }

    return {
      status: DryRunStatus.Complete,
      tests,
      mutantCoverage: finalMutantCoverage,
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
      bunPath: this.bunPath,
      timeout: this.timeout,
      env: this.env,
      bunArgs: this.bunArgs,
      activeMutant: options.activeMutant.id,
      bail: true, // Bail on first failure for mutant runs
      noCoverage: true, // Disable coverage for mutant runs - we only need pass/fail
      preloadScript: this.preloadScriptPath, // Needed to set globalThis.__stryker__.activeMutant
    });

    if (result.timedOut) {
      // Stryker disable next-line all: Logging statement
      this.logger.debug('Mutant run timed out');
      return {
        status: MutantRunStatus.Timeout,
      };
    }

    const parsed = parseBunTestOutput(result.stdout, result.stderr);

    this.logger.debug('Mutant run completed: %o', {
      totalTests: parsed.totalTests,
      passed: parsed.passed,
      failed: parsed.failed,
      exitCode: result.exitCode,
    });

    // Non-zero exit code means tests failed, mutant is killed
    // Trust exit code over parsed output since bunfig.toml may hide passing tests
    if (result.exitCode !== 0) {
      const killedBy = parsed.tests
        .filter((test) => test.status === 'failed')
        .map((test) => test.name);

      return {
        status: MutantRunStatus.Killed,
        killedBy: killedBy.length > 0 ? killedBy : ['unknown'],
        failureMessage: parsed.tests
          .filter((test) => test.status === 'failed')
          .map((test) => test.failureMessage)
          .filter((msg): msg is string => !!msg)
          .join('\n\n') || `Tests failed with exit code ${result.exitCode}`,
        nrOfTests: parsed.totalTests || 1,
      };
    }

    // Exit code 0 means all tests passed, mutant survived
    return {
      status: MutantRunStatus.Survived,
      nrOfTests: parsed.totalTests,
    };
  }

  /**
   * Cleanup resources
   */
  public async dispose(): Promise<void> {
    this.logger.debug('Disposing BunTestRunner');

    // Clean up preload script
    if (this.preloadScriptPath) {
      this.logger.debug('Cleaning up preload script: %s', this.preloadScriptPath);
      await cleanupPreloadScript(this.preloadScriptPath);
    }

    // Clean up coverage file if it still exists
    if (this.coverageFilePath) {
      this.logger.debug('Cleaning up coverage file: %s', this.coverageFilePath);
      await cleanupCoverageFile(this.coverageFilePath);
    }

    // Clean up JUnit file if we created it (not from bunfig)
    if (this.junitOutputPath && !this.junitFromBunfig) {
      try {
        await unlink(this.junitOutputPath);
      } catch {
        // Ignore - file might already be deleted
      }
    }
  }
}
