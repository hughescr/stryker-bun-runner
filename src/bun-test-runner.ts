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
    this.logger.debug('Validating bun installation...');

    // Validate that bun is available
    const result = await runBunTests({
      bunPath: this.bunPath,
      timeout: 5000,
      bunArgs: ['--version'],
    });

    if (result.exitCode !== 0 && !result.stdout.includes('bun')) {
      throw new Error(
        `Failed to execute bun at "${this.bunPath}". ` +
        `Please ensure bun is installed and the bunPath is correct.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }

    this.logger.debug('Bun installation validated successfully');

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
   * Run all tests (dry run)
   */
  public async dryRun(): Promise<DryRunResult> {
    this.logger.debug('Running dry run with coverage collection...');

    const result = await runBunTests({
      bunPath: this.bunPath,
      timeout: this.timeout,
      env: this.env,
      bunArgs: this.bunArgs,
      preloadScript: this.preloadScriptPath,
      coverageFile: this.coverageFilePath,
    });

    if (result.timedOut) {
      this.logger.warn('Dry run timed out');
      return {
        status: DryRunStatus.Timeout,
      };
    }

    // Log raw output for debugging
    this.logger.debug('Bun test stdout (first 500 chars): %s', result.stdout.substring(0, 500));
    this.logger.debug('Bun test stderr (first 500 chars): %s', result.stderr.substring(0, 500));
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
        this.logger.debug('Coverage collected: %d tests with coverage, %d static mutants', perTestCount, staticCount);
      } else {
        this.logger.debug('No coverage data collected');
      }

      // Clean up coverage file after reading
      await cleanupCoverageFile(this.coverageFilePath);
    }

    // Build tests array from coverage data instead of parsed output
    // This is necessary because Bun's onlyFailures=true hides passing tests from console output
    let tests: Array<SuccessTestResult | FailedTestResult | SkippedTestResult> = [];

    if (mutantCoverage && Object.keys(mutantCoverage.perTest).length > 0) {
      // Get test names from coverage data (these are all the tests that actually ran)
      const testNames = Object.keys(mutantCoverage.perTest);

      // Cross-reference with parsed results to find failures
      const failedTestNames = new Set(
        parsed.tests.filter(t => t.status === 'failed').map(t => t.name)
      );

      this.logger.debug('Building test list: %d tests from coverage, %d failed from output',
        testNames.length, failedTestNames.size);

      tests = testNames.map(testName => {
        const isFailed = failedTestNames.has(testName);
        const parsedTest = parsed.tests.find(t => t.name === testName);

        if (isFailed && parsedTest) {
          return {
            id: testName,
            name: testName,
            status: TestStatus.Failed,
            failureMessage: parsedTest.failureMessage ?? 'Test failed',
            timeSpentMs: parsedTest.duration ?? 0,
          } satisfies FailedTestResult;
        }

        return {
          id: testName,
          name: testName,
          status: TestStatus.Success,
          timeSpentMs: 0,
        } satisfies SuccessTestResult;
      });
    } else {
      // Fallback: use parsed tests from console output when no coverage data
      // This happens when: bunfig.toml doesn't have onlyFailures, or coverage preload failed
      this.logger.debug('No coverage data available, using parsed test output');

      tests = parsed.tests.map(t => {
        const id = t.name;
        const name = t.name;
        const timeSpentMs = t.duration ?? 0;

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

      // If no tests were parsed from output (e.g., all passing with onlyFailures=true),
      // create synthetic tests from summary counts
      if (tests.length === 0 && parsed.passed > 0) {
        this.logger.debug('No individual tests parsed, creating synthetic tests from summary');
        for (let i = 0; i < parsed.passed; i++) {
          tests.push({
            id: `test-${i}`,
            name: `test-${i}`,
            status: TestStatus.Success,
            timeSpentMs: 0,
          } satisfies SuccessTestResult);
        }
      }
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
    this.logger.debug('Running mutant run for mutant %s', options.activeMutant.id);

    // Build test name pattern from testFilter if provided
    let testNamePattern: string | undefined;
    if (options.testFilter && options.testFilter.length > 0) {
      // Create a regex pattern that matches any of the test IDs
      // Escape special regex characters in test names
      const escapedNames = options.testFilter.map((testId) =>
        testId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      );
      testNamePattern = escapedNames.join('|');
    }

    const result = await runBunTests({
      bunPath: this.bunPath,
      timeout: this.timeout,
      env: this.env,
      bunArgs: this.bunArgs,
      testNamePattern,
      activeMutant: options.activeMutant.id,
      bail: true, // Bail on first failure for mutant runs
    });

    if (result.timedOut) {
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

    // Check for errors (process failure, not test failures)
    if (result.exitCode !== 0 && parsed.failed === 0) {
      return {
        status: MutantRunStatus.Error,
        errorMessage: `Bun test process failed with exit code ${result.exitCode}\n${result.stderr}`,
      };
    }

    // If any test failed, the mutant was killed
    if (parsed.failed > 0) {
      const killedBy = parsed.tests
        .filter((test) => test.status === 'failed')
        .map((test) => test.name);

      return {
        status: MutantRunStatus.Killed,
        killedBy,
        failureMessage: parsed.tests
          .filter((test) => test.status === 'failed')
          .map((test) => test.failureMessage)
          .filter((msg): msg is string => !!msg)
          .join('\n\n'),
        nrOfTests: parsed.totalTests,
      };
    }

    // All tests passed, mutant survived
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
  }
}
