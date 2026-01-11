/**
 * Bun process spawning utilities
 * Handles spawning and managing Bun test processes
 */

import { spawn, ChildProcess } from 'node:child_process';

export interface BunTestRunOptions {
  /**
   * Path to the bun binary
   */
  bunPath: string;

  /**
   * Timeout in milliseconds
   */
  timeout: number;

  /**
   * Additional environment variables
   */
  env?: Record<string, string>;

  /**
   * Additional bun test arguments
   */
  bunArgs?: string[];

  /**
   * Test name pattern to filter tests
   */
  testNamePattern?: string;

  /**
   * Active mutant ID (set as __STRYKER_ACTIVE_MUTANT__ env var)
   */
  activeMutant?: string;

  /**
   * Whether to bail on first failure
   */
  bail?: boolean;

  /**
   * Path to preload script (will be passed to --preload flag)
   */
  preloadScript?: string;

  /**
   * Path where coverage data should be written (set as __STRYKER_COVERAGE_FILE__ env var)
   */
  coverageFile?: string;

  /**
   * Whether to disable coverage collection (overrides bunfig.toml)
   */
  noCoverage?: boolean;
}

export interface BunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run bun test with the specified options
 */
export async function runBunTests(options: BunTestRunOptions): Promise<BunProcessResult> {
  const args = ['test'];

  // Add preload script if specified
  if (options.preloadScript) {
    args.push('--preload', options.preloadScript);
  }

  // Add test name pattern filter if specified
  if (options.testNamePattern) {
    args.push('--test-name-pattern', options.testNamePattern);
  }

  // Add bail flag if requested
  if (options.bail) {
    args.push('--bail');
  }

  // Disable coverage if requested (overrides bunfig.toml)
  if (options.noCoverage) {
    args.push('--no-coverage');
  }

  // Add any additional bun args
  if (options.bunArgs && options.bunArgs.length > 0) {
    args.push(...options.bunArgs);
  }

  // Prepare environment variables
  const env = {
    ...process.env,
    ...options.env,
  };

  // Set active mutant if specified
  if (options.activeMutant) {
    env['__STRYKER_ACTIVE_MUTANT__'] = options.activeMutant;
  }

  // Set coverage file path if specified
  if (options.coverageFile) {
    env['__STRYKER_COVERAGE_FILE__'] = options.coverageFile;
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let processKilled = false;

    const childProcess: ChildProcess = spawn(options.bunPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      processKilled = true;
      childProcess.kill('SIGKILL');
    }, options.timeout);

    // Collect stdout
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    // Collect stderr
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    // Handle process exit
    childProcess.on('close', (code) => {
      clearTimeout(timeoutHandle);

      resolve({
        stdout,
        stderr,
        exitCode: processKilled ? null : code,
        timedOut,
      });
    });

    // Handle process errors
    childProcess.on('error', (error) => {
      clearTimeout(timeoutHandle);

      resolve({
        stdout,
        stderr: stderr + '\nProcess error: ' + error.message,
        exitCode: null,
        timedOut,
      });
    });
  });
}
