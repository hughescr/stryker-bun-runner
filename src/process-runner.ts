/**
 * Bun process spawning utilities
 * Handles spawning and managing Bun test processes
 */

import { spawn } from 'node:child_process';

export interface BunTestRunOptions {
    /**
   * Path to the bun binary
   */
    bunPath: string

    /**
   * Timeout in milliseconds
   */
    timeout: number

    /**
   * Additional environment variables
   */
    env?: Record<string, string>

    /**
   * Additional bun test arguments
   */
    bunArgs?: string[]

    /**
   * Test name pattern to filter tests
   */
    testNamePattern?: string

    /**
   * Active mutant ID (set as __STRYKER_ACTIVE_MUTANT__ env var)
   */
    activeMutant?: string

    /**
   * Whether to bail on first failure
   */
    bail?: boolean

    /**
   * Path to preload script (will be passed to --preload flag)
   */
    preloadScript?: string

    /**
   * Path where coverage data should be written (set as __STRYKER_COVERAGE_FILE__ env var)
   */
    coverageFile?: string

    /**
   * Whether to disable coverage collection (overrides bunfig.toml)
   */
    noCoverage?: boolean

    /**
   * Port for --inspect flag
   * When provided, adds --inspect=<port> flag to enable debugging
   */
    inspectWaitPort?: number

    /**
   * Whether to force sequential test execution
   * When true, adds --concurrency=1 flag
   */
    sequentialMode?: boolean

    /**
   * Callback invoked when inspector WebSocket URL is detected in stderr
   * Only called when inspectWaitPort is set
   */
    onInspectorReady?: (url: string) => void

    /**
   * Port for WebSocket synchronization server
   * When provided, sets __STRYKER_SYNC_PORT__ env var for preload script
   */
    syncPort?: number
}

export interface BunProcessResult {
    stdout:   string
    stderr:   string
    exitCode: number | null
    timedOut: boolean
}

/**
 * Run bun test with the specified options
 */
export async function runBunTests(options: BunTestRunOptions): Promise<BunProcessResult> {
    const args = ['test'];

    // Add inspector debugging if specified
    // Note: We use --inspect (not --inspect-wait) because Bun doesn't support
    // Runtime.runIfWaitingForDebugger to resume after connection.
    // This means tests start immediately, so we must connect quickly.
    if(options.inspectWaitPort) {
        args.push(`--inspect=${options.inspectWaitPort}`);
    }

    // Add preload script if specified
    if(options.preloadScript) {
        args.push('--preload', options.preloadScript);
    }

    // Add test name pattern filter if specified
    if(options.testNamePattern) {
        args.push('--test-name-pattern', options.testNamePattern);
    }

    // Add bail flag if requested
    if(options.bail) {
        args.push('--bail');
    }

    // Disable coverage if requested (overrides bunfig.toml)
    if(options.noCoverage) {
        args.push('--no-coverage');
    }

    // Force sequential execution if requested
    if(options.sequentialMode) {
        args.push('--concurrency=1');
    }

    // Disable randomization to ensure consistent test ordering between dry run and mutant runs
    args.push('--no-randomize');

    // Add any additional bun args
    // Stryker disable next-line EqualityOperator,ConditionalExpression: length >= 0 is equivalent to length > 0 for empty arrays (spreading [] is a no-op); ConditionalExpression would cause spread of undefined
    if(options.bunArgs && options.bunArgs.length > 0) {
        args.push(...options.bunArgs);
    }

    // Prepare environment variables
    const env: Record<string, string | undefined> = {
        ...process.env,
        ...options.env,
    };

    // Set active mutant if specified
    if(options.activeMutant) {
        env.__STRYKER_ACTIVE_MUTANT__ = options.activeMutant;
    }

    // Set coverage file path if specified
    // Stryker disable next-line ConditionalExpression: mutating to always true would set env var to undefined
    if(options.coverageFile) {
        env.__STRYKER_COVERAGE_FILE__ = options.coverageFile;
    }

    // Set sync port if specified
    if(options.syncPort) {
        env.__STRYKER_SYNC_PORT__ = String(options.syncPort);
    }

    return new Promise((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let processKilled = false;

        const childProcess = spawn(options.bunPath, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd:   process.cwd(),
        });

        // Set up timeout
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            processKilled = true;
            childProcess.kill('SIGKILL');
        }, options.timeout);

        // Collect stdout silently - don't forward to parent to avoid interfering with Stryker's progress reporter
        if(childProcess.stdout) {
            childProcess.stdout.on('data', (data: Buffer) => {
                stdoutChunks.push(data);
            });
        }

        // Collect stderr and watch for inspector WebSocket URL
        let inspectorUrlExtracted = false;
        if(childProcess.stderr) {
            childProcess.stderr.on('data', (data: Buffer) => {
                stderrChunks.push(data);

                // If inspector is enabled, parse stderr for WebSocket URL
                if(options.inspectWaitPort && !inspectorUrlExtracted && options.onInspectorReady) {
                    const text = Buffer.concat(stderrChunks).toString();
                    // Look for pattern: "Listening:\n  ws://localhost:PORT/SESSION_ID"
                    // Stryker disable next-line Regex: character classes are defensive for whitespace normalization
                    const match = /Listening:[\t\v\f\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\n\s*(ws:\/\/\S+)/.exec(text);
                    if(match) {
                        inspectorUrlExtracted = true;
                        options.onInspectorReady(match[1]);
                    }
                }
            });
        }

        // Handle process exit
        childProcess.on('close', (code) => {
            clearTimeout(timeoutHandle);

            resolve({
                stdout:   Buffer.concat(stdoutChunks).toString(),
                stderr:   Buffer.concat(stderrChunks).toString(),
                exitCode: processKilled ? null : code,
                timedOut,
            });
        });

        // Handle process errors
        childProcess.on('error', (error) => {
            clearTimeout(timeoutHandle);
            const stderrOutput = Buffer.concat(stderrChunks).toString();

            resolve({
                stdout:   Buffer.concat(stdoutChunks).toString(),
                stderr:   `${stderrOutput}\nProcess error: ${error.message}`,
                exitCode: null,
                timedOut,
            });
        });
    });
}
