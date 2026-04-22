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
   * Path to sanitized bunfig.toml (passed as --config to bun test)
   * Overrides the project's bunfig.toml for the child process.
   */
    bunfigPath?: string

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

    /**
   * Explicit list of test file paths to pass as positional arguments to bun test.
   * When provided, Bun runs only these files in the given order, eliminating
   * readdir-based non-determinism.  Paths must be relative to process.cwd().
   * When omitted, Bun performs its normal file discovery.
   */
    testFiles?: string[]
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

    // Override the project bunfig with a sanitized copy to prevent coverage
    // thresholds and onlyFailures from interfering with mutation testing.
    // NOTE: bun requires the equals form here; `--config PATH` is silently
    // ignored and PATH is then consumed as a positional test-file filter.
    if(options.bunfigPath) {
        args.push(`--config=${options.bunfigPath}`);
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

    // Force sequential execution if requested
    if(options.sequentialMode) {
        args.push('--concurrency=1');
    }

    // Add any additional bun args
    // Stryker disable next-line EqualityOperator,ConditionalExpression: length >= 0 is equivalent to length > 0 for empty arrays (spreading [] is a no-op); ConditionalExpression would cause spread of undefined
    if(options.bunArgs && options.bunArgs.length > 0) {
        args.push(...options.bunArgs);
    }

    // Append explicit test file paths as positional arguments.
    // Positional args to `bun test` tell it exactly which files to load and in
    // which order, removing reliance on readdir ordering (non-deterministic on
    // macOS APFS) so mutantCoverage.perTest is stable across runs.
    // Stryker disable next-line EqualityOperator,ConditionalExpression: length >= 0 equivalent to > 0 for empty arrays; spread of [] is a no-op
    if(options.testFiles && options.testFiles.length > 0) {
        args.push(...options.testFiles);
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
