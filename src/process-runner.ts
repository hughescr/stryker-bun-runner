/**
 * Bun process spawning utilities
 * Handles spawning and managing Bun test processes
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { getProcessRssBytes } from './utils/process-rss.js';

/**
 * Grace period (ms) between sending SIGTERM and escalating to SIGKILL if the
 * child hasn't exited. Shared by the timeout, AbortSignal, and memory-ceiling
 * kill paths so all three follow one consistent escalation policy.
 */
const KILL_GRACE_PERIOD_MS = 500;

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
   * Optional AbortSignal to kill the child process early.
   * When the signal fires, the child is sent SIGTERM (with a short grace period
   * followed by SIGKILL if still running).  The promise resolves with
   * { timedOut: true } to indicate it was aborted rather than completing normally.
   */
    signal?: AbortSignal

    /**
   * Explicit list of test file paths to pass as positional arguments to bun test.
   * When provided, Bun runs only these files in the given order, eliminating
   * readdir-based non-determinism.  Both absolute and relative paths are
   * accepted; relative paths resolve against the bun subprocess's cwd.
   * When omitted, Bun performs its normal file discovery.
   */
    testFiles?: string[]

    /**
   * When true, adds Bun's `--smol` flag, which trades some speed for a
   * significantly smaller JavaScriptCore heap footprint. Recommended on
   * memory-constrained machines, especially at higher Stryker `concurrency`
   * (peak memory = concurrency × per-run suite footprint).
   */
    smol?: boolean

    /**
   * Soft memory ceiling in bytes for the child process's resident set size
   * (RSS). When set, the child's RSS is polled periodically (see
   * {@link rssCheckIntervalMs}); if it exceeds this value the child is killed
   * (SIGTERM, escalating to SIGKILL) and the run resolves with
   * `timedOut: true` and `memoryLimitExceeded: true` — a clean, attributable
   * failure for that one run rather than system-wide swap exhaustion.
   *
   * This is a polled userspace check, not a kernel-enforced limit: it can
   * overshoot the threshold between polls, and it is only as reliable as the
   * underlying RSS probe (see {@link getProcessRssBytes}). Omit to disable.
   */
    maxChildRss?: number

    /**
   * Poll interval in milliseconds for the {@link maxChildRss} check.
   * @default 1000
   */
    rssCheckIntervalMs?: number

    /**
   * Callback invoked once, at the moment {@link maxChildRss} is exceeded and
   * the kill has been initiated. Receives the observed RSS in bytes. Intended
   * for the caller to log a diagnostic warning.
   */
    onMemoryLimitExceeded?: (rssBytes: number) => void
}

export interface BunProcessResult {
    stdout:   string
    stderr:   string
    exitCode: number | null
    timedOut: boolean

    /**
   * True when the child was killed because it exceeded {@link BunTestRunOptions.maxChildRss}.
   * Always false when `maxChildRss` was not set.
   */
    memoryLimitExceeded: boolean
}

/**
 * Send SIGTERM to a child process, escalating to SIGKILL after a grace period
 * if it hasn't exited by then. `isClosed` is checked right before the SIGKILL
 * so an already-exited process (e.g. one that responded to SIGTERM promptly)
 * is never signalled again.
 */
function killWithEscalation(childProcess: ChildProcess, isClosed: () => boolean, gracePeriodMs: number): void {
    childProcess.kill('SIGTERM');
    setTimeout(() => {
        // Stryker disable next-line ConditionalExpression,BlockStatement: escalation guard — skipping SIGKILL when the process already exited is covered by 'does not escalate to SIGKILL when the process exits within the grace period'; the escalation-fires case is covered by 'escalates to SIGKILL when the process ignores SIGTERM'
        if(!isClosed()) {
            childProcess.kill('SIGKILL');
        }
    }, gracePeriodMs);
}

/**
 * Run bun test with the specified options
 */
export async function runBunTests(options: BunTestRunOptions): Promise<BunProcessResult> {
    // Stryker disable next-line StringLiteral: mutating 'test' removes the bun test subcommand → bun exits immediately with no tests run → Timeout
    const args = ['test'];

    // Add inspector debugging if specified
    // Note: We use --inspect (not --inspect-wait) because Bun doesn't support
    // Runtime.runIfWaitingForDebugger to resume after connection.
    // This means tests start immediately, so we must connect quickly.
    // Stryker disable ConditionalExpression,BlockStatement,StringLiteral: all mutations here remove required args, causing dryRun to never emit inspector URL → Timeout
    if(options.inspectWaitPort) {
        args.push(`--inspect=${options.inspectWaitPort}`);
    }
    // Stryker restore ConditionalExpression,BlockStatement,StringLiteral

    // Override the project bunfig with a sanitized copy to prevent coverage
    // thresholds and onlyFailures from interfering with mutation testing.
    // NOTE: bun requires the equals form here; `--config PATH` is silently
    // ignored and PATH is then consumed as a positional test-file filter.
    // Stryker disable StringLiteral: mutating --config=/--preload/--test-name-pattern/--concurrency removes required flags → coverage/filter broken → Timeout
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
    // Stryker restore StringLiteral

    // Reduce Bun's JavaScriptCore heap growth at the cost of some speed.
    // Useful on memory-constrained machines, especially at higher Stryker
    // `concurrency` — see README "Memory containment" section.
    if(options.smol) {
        args.push('--smol');
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
    // Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: length >= 0 equivalent to > 0 for empty arrays; spread of [] is a no-op; BlockStatement: removing body means bun runs all tests instead of targeted subset → coverage non-determinism → Timeout
    if(options.testFiles && options.testFiles.length > 0) {
        args.push(...options.testFiles);
    }

    // Prepare environment variables
    // Stryker disable next-line ObjectLiteral: removing env spreads means bun runs with empty env → no PATH/HOME → bun cannot initialize → Timeout
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

    // Stryker disable next-line BlockStatement: removing entire Promise body means resolve() never called → Timeout
    return new Promise((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let processKilled = false;
        let memoryLimitExceeded = false;
        let hasClosed = false;
        let rssIntervalHandle: ReturnType<typeof setInterval> | undefined;

        // If an AbortSignal was provided and is already aborted, resolve immediately
        // Stryker disable next-line ConditionalExpression,BlockStatement: abort-before-spawn guard; mutation caught by 'aborts child process when signal fires'
        if(options.signal?.aborted) {
            resolve({ stdout: '', stderr: '', exitCode: null, timedOut: true, memoryLimitExceeded: false });
            return;
        }

        // Typed as SpawnOptions (not a tuple) so TypeScript preserves stdout/stderr as
        // Readable | null — the conditional guards below are then genuinely necessary.
        // In practice these are always non-null with stdio:'pipe', but mocks and edge-case
        // spawn failures can produce null streams.
        const spawnOpts: SpawnOptions = {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd:   process.cwd(),
        };
        const childProcess = spawn(options.bunPath, args, spawnOpts);

        // Set up timeout — escalate SIGTERM→SIGKILL via the shared helper so a
        // process that responds promptly to SIGTERM isn't needlessly SIGKILLed.
        // Stryker disable next-line BlockStatement: removing timeout kill body means child process runs forever → Timeout on the Stryker test for this mutation
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            processKilled = true;
            killWithEscalation(childProcess, () => hasClosed, KILL_GRACE_PERIOD_MS);
        }, options.timeout);

        // Wire up the AbortSignal if provided.
        // On abort: send SIGTERM for a graceful shutdown; if the process is still
        // alive after the grace period, escalate to SIGKILL.  The promise resolves
        // with timedOut:true to signal the caller that we stopped early.
        // Stryker disable next-line ConditionalExpression,BlockStatement: abort-signal wiring; mutation caught by 'aborts child process when signal fires'
        if(options.signal) {
            const onAbort = (): void => {
                clearTimeout(timeoutHandle);
                processKilled = true;
                timedOut = true;
                killWithEscalation(childProcess, () => hasClosed, KILL_GRACE_PERIOD_MS);
            };
            // Stryker disable next-line ObjectLiteral,BooleanLiteral: AbortSignal 'abort' fires at most once per controller (spec guarantee — WHATWG DOM §9.1), so { once: true } is semantically redundant; mutating to {} or { once: false } is equivalent
            options.signal.addEventListener('abort', onAbort, { once: true });
        }

        // Wire up the soft memory ceiling if requested. Polls the child's RSS
        // and kills it (with the same SIGTERM→SIGKILL escalation) if it's
        // exceeded, converting a runaway run into a clean, attributable
        // failure instead of unbounded growth. See BunTestRunOptions.maxChildRss.
        if(options.maxChildRss !== undefined) {
            const rssLimit = options.maxChildRss;
            const checkMemoryCeiling = async (): Promise<void> => {
                // Defensive re-entrancy guard: setInterval ticks are fire-and-forget
                // (not awaited), so in principle a new tick could start while an
                // earlier tick's RSS probe is still pending. In practice, Node/Bun
                // drain the microtask queue between timer macrotasks, so by the time
                // a later tick's synchronous prefix runs, an already-settled earlier
                // tick has already flipped hasClosed/memoryLimitExceeded and cleared
                // the interval — this guard is not reachable under real timer
                // semantics, only defensive against a future change to that ordering.
                // Stryker disable next-line all: unreachable under real timer semantics; see comment above — not exercised by tests
                if(hasClosed || memoryLimitExceeded) {
                    return;
                }
                const pid = childProcess.pid;
                // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: pid can be undefined for a spawn that failed before assignment; covered by 'does not probe RSS when the child has no pid'
                if(pid === undefined) {
                    return;
                }
                const rssBytes = await getProcessRssBytes(pid);
                // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,LogicalOperator: null probe result (unknown RSS) must not be treated as exceeding the ceiling; covered by 'does not kill when the RSS probe returns null'; the hasClosed re-check guards against the process closing while the probe awaited
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hasClosed is set by the 'close'/'error' handlers, a different closure; TypeScript cannot track that cross-await mutation
                if(rssBytes === null || hasClosed) {
                    return;
                }
                if(rssBytes > rssLimit) {
                    // eslint-disable-next-line require-atomic-updates -- single-threaded reentrancy guarded by the hasClosed/memoryLimitExceeded check at function entry; no concurrent writer can race this assignment
                    memoryLimitExceeded = true;
                    timedOut = true;
                    processKilled = true;
                    // Stryker disable next-line ConditionalExpression: equivalent mutant — rssIntervalHandle is always defined at this point (assigned synchronously right after this whole maxChildRss block starts, before any tick can run); mutating the guard to `true` only changes clearInterval's argument from a real handle to itself, never to undefined
                    if(rssIntervalHandle) {
                        clearInterval(rssIntervalHandle);
                    }
                    options.onMemoryLimitExceeded?.(rssBytes);
                    killWithEscalation(childProcess, () => hasClosed, KILL_GRACE_PERIOD_MS);
                }
            };
            rssIntervalHandle = setInterval(() => {
                // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget poll tick; errors are already swallowed inside getProcessRssBytes
                checkMemoryCeiling();
            }, options.rssCheckIntervalMs ?? 1000);
            // Don't let the poller keep the event loop alive on its own.
            rssIntervalHandle.unref();
        }

        // Collect stdout silently - don't forward to parent to avoid interfering with Stryker's progress reporter
        if(childProcess.stdout) {
            // Stryker disable next-line BlockStatement: removing this data handler means stdout is never collected; all tests that check result.stdout would fail
            childProcess.stdout.on('data', (data: Buffer) => {
                stdoutChunks.push(data);
            });
        }

        // Collect stderr and watch for inspector WebSocket URL
        // Stryker disable BooleanLiteral,BlockStatement,StringLiteral: all mutations here either prevent stderr collection or inspector URL delivery → dryRun never resolves → Timeout
        let inspectorUrlExtracted = false;
        if(childProcess.stderr) {
            childProcess.stderr.on('data', (data: Buffer) => {
                stderrChunks.push(data);

                // If inspector is enabled, parse stderr for WebSocket URL
                if(options.inspectWaitPort && !inspectorUrlExtracted && options.onInspectorReady) {
                    const text = Buffer.concat(stderrChunks).toString();
                    // Look for pattern: "Listening:\n  ws://localhost:PORT/SESSION_ID"
                    // Stryker disable next-line Regex: character classes are defensive for whitespace normalization
                    const match = /Listening:[\t\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*(ws:\/\/\S+)/.exec(text);
                    if(match) {
                        inspectorUrlExtracted = true;
                        options.onInspectorReady(match[1]);
                    }
                }
            });
        }
        // Stryker restore BooleanLiteral,BlockStatement,StringLiteral

        // Handle process exit
        // Stryker disable next-line BlockStatement,StringLiteral: Promise.resolve never called without 'close' handler → Timeout
        childProcess.on('close', (code) => {
            hasClosed = true;
            clearTimeout(timeoutHandle);
            // Stryker disable next-line ConditionalExpression: equivalent mutant — when rssIntervalHandle is undefined (maxChildRss not set), clearInterval(undefined) is a silent no-op in Node/Bun; mutating the guard to `true` cannot introduce an observable difference
            if(rssIntervalHandle) {
                clearInterval(rssIntervalHandle);
            }

            resolve({
                stdout:   Buffer.concat(stdoutChunks).toString(),
                stderr:   Buffer.concat(stderrChunks).toString(),
                exitCode: processKilled ? null : code,
                timedOut,
                memoryLimitExceeded,
            });
        });

        // Handle process errors
        // Stryker disable next-line BlockStatement: emptying this handler means resolve() is never called on a spawn/child error → Timeout — expected, mirrors the 'close' handler's disable comment above
        childProcess.on('error', (error) => {
            hasClosed = true;
            clearTimeout(timeoutHandle);
            // Stryker disable next-line ConditionalExpression: equivalent mutant — when rssIntervalHandle is undefined (maxChildRss not set), clearInterval(undefined) is a silent no-op in Node/Bun; mutating the guard to `true` cannot introduce an observable difference
            if(rssIntervalHandle) {
                clearInterval(rssIntervalHandle);
            }
            const stderrOutput = Buffer.concat(stderrChunks).toString();

            resolve({
                stdout:   Buffer.concat(stdoutChunks).toString(),
                stderr:   `${stderrOutput}\nProcess error: ${error.message}`,
                exitCode: null,
                timedOut,
                memoryLimitExceeded,
            });
        });
    });
}
