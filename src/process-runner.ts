/**
 * Bun process spawning utilities
 * Handles spawning and managing Bun test processes
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { killProcessGroup } from './utils/process-group.js';
import { getProcessRssBytes } from './utils/process-rss.js';

/**
 * Grace period (ms) between sending SIGTERM and escalating to SIGKILL if the
 * child hasn't exited. Shared by the timeout, AbortSignal, and memory-ceiling
 * kill paths so all three follow one consistent escalation policy.
 */
const KILL_GRACE_PERIOD_MS = 500;

/**
 * Environment variable carrying this runner's spawn nesting depth into every
 * `bun test` child, so a child can tell that it is itself running underneath a
 * runner-spawned process.
 *
 * A process that was not spawned by this runner has no such variable and is
 * therefore depth 0; the `bun test` it spawns is depth 1, and so on.
 */
export const SPAWN_DEPTH_ENV = '__STRYKER_BUN_RUNNER_DEPTH__';

/**
 * Default ceiling on `bun test` spawn nesting — see
 * {@link BunTestRunOptions.maxSpawnDepth}.
 */
export const DEFAULT_MAX_SPAWN_DEPTH = 1;

/**
 * Read the current process's spawn depth from an environment value.
 *
 * Anything that is not a positive integer — absent, empty, malformed, negative
 * — reads as depth 0. Depth is a safety ceiling, and the safe reading of a
 * corrupt value is "assume we are at the top", which keeps a legitimate
 * first-level spawn working rather than refusing everything.
 */
export function readSpawnDepth(raw: string | undefined): number {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

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
   * When provided, adds --inspect=127.0.0.1:<port> flag to enable debugging.
   * The host is pinned to 127.0.0.1 (not left bare) so bun's bind address and
   * InspectorClient's dial address are always the same literal string — see
   * the comment at the call site in runBunTests for why this matters.
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

    /**
   * Maximum `bun test` spawn nesting depth. A call made from a process already
   * at or beyond this depth refuses to spawn and resolves with a non-zero exit
   * code instead, which is what keeps runaway self-spawning finite — see the
   * README's "Recursion containment" section for the mechanism.
   *
   * @default 1
   */
    maxSpawnDepth?: number
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
 * Strip any bail flag the caller put in `bunArgs`, leaving every other entry
 * untouched and in its original order.
 *
 * Bail is fully runner-managed (see {@link BunTestRunOptions.bail}): mutant
 * runs bail unless Stryker's `disableBail` option is set, and dry runs never
 * bail (the full suite must run for coverage). A bail flag the user configured
 * in `bun.bunArgs` would silently re-enable or duplicate that decision if it
 * were merged in as-is, so it must be stripped rather than appended.
 *
 * Strips the bail spellings a user might plausibly write:
 *   - `--bail`     - bare flag (defaults to a threshold of 1)
 *   - `--bail=<N>` - the equals form, the only way to pass an explicit threshold
 *   - `--bail <N>` - a bare `--bail` followed by a purely-numeric token, as if
 *     `<N>` were a space-separated value
 *
 * Bun itself accepts only the first two forms. Passed the third, `<N>` is not
 * read as the flag's value but is misread as a stray positional test-file
 * filter (confirmed empirically: `bun test --bail 2` reports "did not match
 * any test files"), so if a user writes it anyway both tokens are dropped
 * together rather than leaving the numeric token behind as a broken filter.
 */
function stripBailArgs(bunArgs: readonly string[]): string[] {
    const sanitized: string[] = [];
    for(let i = 0; i < bunArgs.length; i++) {
        const arg = bunArgs[i];
        if(arg === '--bail' || arg.startsWith('--bail=')) {
            if(arg === '--bail' && /^\d+$/.test(bunArgs[i + 1])) {
                i += 1;
            }
            continue;
        }
        sanitized.push(arg);
    }
    return sanitized;
}

/**
 * Live children, so a signal arriving at this process can take them down with
 * it. Spawning `detached` removes them from this process's group, which means
 * they no longer die with it on Ctrl-C — see {@link ensureSignalCleanup}.
 */
const liveChildren = new Set<ChildProcess>();

/**
 * Kill every live child when this process is signalled, then re-raise so the
 * default disposition is preserved.
 *
 * Necessary because `detached: true` moves each child out of this process's
 * group, and therefore out of the terminal's foreground group. Stryker's own
 * UnexpectedExitHandler runs in its main process and does not tree-kill the
 * worker pool; workers die on Ctrl-C only because the terminal signals their
 * group directly. Without this, a detached child survives that and is
 * reparented to PID 1 — reintroducing the leak from the other direction.
 */
export function killAllLiveChildren(): void {
    for(const child of liveChildren) {
        killProcessTree(child, 'SIGKILL');
    }
    liveChildren.clear();
}

/** Signals worth reaping on. SIGKILL is absent because it cannot be trapped. */
const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Stryker disable next-line BlockStatement,ArrowFunction,CallExpression,MethodExpression: the body ends by re-raising the signal at this very process, which terminates it — it cannot run under test without killing the test runner. Its testable half is killAllLiveChildren(), which IS covered; what remains is deregistration and the re-raise.
const onCleanupSignal = (signal: NodeJS.Signals): void => {
    killAllLiveChildren();
    removeSignalCleanup();
    process.kill(process.pid, signal);
};

/**
 * Attach the signal cleanup handlers, once. Returns true when this call did the
 * attaching, false when they were already in place.
 *
 * Registration state is derived from the listener list rather than a module
 * flag, so it stays observable: a caller (or a test) can detach with
 * {@link removeSignalCleanup} and re-attach, and "did we already register"
 * never drifts from the truth.
 */
export function ensureSignalCleanup(): boolean {
    // Stryker disable next-line ConditionalExpression,BlockStatement: without this guard every spawn adds another listener; covered by 'attaches its signal listeners once and is idempotent thereafter'
    if(process.listeners(CLEANUP_SIGNALS[0]).includes(onCleanupSignal)) {
        return false;
    }
    for(const s of CLEANUP_SIGNALS) {
        process.on(s, onCleanupSignal);
    }
    return true;
}

/** Detach the handlers attached by {@link ensureSignalCleanup}. */
export function removeSignalCleanup(): void {
    for(const s of CLEANUP_SIGNALS) {
        process.off(s, onCleanupSignal);
    }
}

/**
 * Signal a spawned child and everything it spawned in turn.
 *
 * The child leads its own process group (spawned `detached`), so signalling the
 * group reaches processes the test suite itself spawned. Signalling only the
 * direct child — the plain `ChildProcess.kill()` this replaces — leaves those
 * grandchildren alive and reparented to PID 1, where nothing ever reaps them.
 *
 * Falls back to signalling the child directly when the group signal could not
 * be delivered, so this is never weaker than the call it replaced.
 */
function killProcessTree(childProcess: ChildProcess, signal: NodeJS.Signals): void {
    const pid = childProcess.pid;
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: pid is undefined only when spawn itself failed; both arms are covered by 'signals the process group' and 'falls back to the direct child when the group signal fails'
    if(pid === undefined || !killProcessGroup(pid, signal)) {
        childProcess.kill(signal);
    }
}

/**
 * Send SIGTERM to a child process, escalating to SIGKILL after a grace period
 * if it hasn't exited by then. `isClosed` is checked right before the SIGKILL
 * so an already-exited process (e.g. one that responded to SIGTERM promptly)
 * is never signalled again.
 *
 * Both signals go to the child's whole process group — see
 * {@link killProcessTree}.
 */
function killWithEscalation(childProcess: ChildProcess, isClosed: () => boolean, gracePeriodMs: number): void {
    killProcessTree(childProcess, 'SIGTERM');
    setTimeout(() => {
        // Stryker disable next-line ConditionalExpression,BlockStatement: escalation guard — skipping SIGKILL when the process already exited is covered by 'does not escalate to SIGKILL when the process exits within the grace period'; the escalation-fires case is covered by 'escalates to SIGKILL when the process ignores SIGTERM'
        if(!isClosed()) {
            killProcessTree(childProcess, 'SIGKILL');
        }
    }, gracePeriodMs);
}

/**
 * Run bun test with the specified options
 */
export async function runBunTests(options: BunTestRunOptions): Promise<BunProcessResult> {
    // Recursion ceiling, checked before anything else is built: refusing here is
    // what makes runaway self-spawning terminate, and nothing in spawnBunTests
    // is worth computing for a call that will not spawn.
    const spawnDepth = readSpawnDepth(process.env[SPAWN_DEPTH_ENV]);
    const maxSpawnDepth = options.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
    // Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: removing or inverting this guard restores the unbounded self-spawning it exists to stop; covered by 'refuses to spawn at the depth ceiling'
    if(spawnDepth >= maxSpawnDepth) {
        return {
            stdout:              '',
            stderr:              `stryker-bun-runner: refusing to spawn \`bun test\` at nesting depth ${spawnDepth} (maxSpawnDepth=${maxSpawnDepth}). A test run spawned by this runner tried to spawn another one; this is almost always runaway recursion. See the bun.maxSpawnDepth option.`,
            exitCode:            1,
            timedOut:            false,
            memoryLimitExceeded: false,
        };
    }

    return spawnBunTests(options, spawnDepth);
}

/**
 * Build the argv/env and run the child. Split from {@link runBunTests} so the
 * recursion ceiling is decided before any of this work happens.
 */
async function spawnBunTests(options: BunTestRunOptions, spawnDepth: number): Promise<BunProcessResult> {
    // Stryker disable next-line StringLiteral: mutating 'test' removes the bun test subcommand → bun exits immediately with no tests run → Timeout
    const args = ['test'];

    // Add inspector debugging if specified
    // Note: We use --inspect (not --inspect-wait) because Bun doesn't support
    // Runtime.runIfWaitingForDebugger to resume after connection.
    // This means tests start immediately, so we must connect quickly.
    // The host is pinned to 127.0.0.1 rather than left bare (`--inspect=<port>`):
    // bun binds a bare --inspect=<port> to ::1 only, but InspectorClient dials
    // whatever host bun echoes back in its "Listening:" banner (see the stderr
    // handler below) through Node's `net.connect`, which resolves the literal
    // string "localhost" to 127.0.0.1 via an internal fast path that ignores
    // /etc/hosts and --dns-result-order. On any host with that v4/v6 split
    // (observed in Docker Desktop for Mac) a bare port produces a deterministic
    // ECONNREFUSED. Pinning bind and dial to the same explicit 127.0.0.1
    // eliminates the mismatch. This is behavioral, not diagnostic, so unlike
    // the disables below it is intentionally left un-disabled and is covered by
    // the exact-arg assertion in process-runner.test.ts (inspector debugging).
    // Stryker disable next-line ConditionalExpression,BlockStatement: all mutations here remove required args, causing dryRun to never emit inspector URL → Timeout
    if(options.inspectWaitPort) {
        args.push(`--inspect=127.0.0.1:${options.inspectWaitPort}`);
    }

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

    // Add any additional bun args, with any user-supplied bail flag stripped out —
    // bail is fully runner-managed (see stripBailArgs above and options.bail),
    // so a bail flag configured here must never be merged into the spawned argv.
    // Stryker disable next-line EqualityOperator,ConditionalExpression: length >= 0 is equivalent to length > 0 for empty arrays (spreading [] is a no-op); ConditionalExpression would cause spread of undefined
    if(options.bunArgs && options.bunArgs.length > 0) {
        args.push(...stripBailArgs(options.bunArgs));
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

    // Stamp the child's nesting depth so that, if the suite it runs turns
    // around and drives this runner again, that nested call can see how deep it
    // already is — see maxSpawnDepth.
    env[SPAWN_DEPTH_ENV] = String(spawnDepth + 1);

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
        // `detached: true` makes the child the leader of a new process group, so
        // killWithEscalation can signal the whole group and reach anything the
        // test suite spawned. Without it a grandchild outlives every kill path
        // here and is reparented to PID 1. The child is deliberately not
        // unref()'d: the parent still owns it and must still await its exit.
        const spawnOpts: SpawnOptions = {
            env,
            stdio:    ['ignore', 'pipe', 'pipe'],
            cwd:      process.cwd(),
            detached: true,
        };
        const childProcess = spawn(options.bunPath, args, spawnOpts);

        // Track the child so a signal arriving here takes it down too — being
        // detached, it no longer dies with this process on its own.
        liveChildren.add(childProcess);
        ensureSignalCleanup();

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
                    // Look for pattern: "Listening:\n  ws://127.0.0.1:PORT/SESSION_ID"
                    // Bun echoes back whatever host we passed to --inspect (verified: bare
                    // port → "ws://localhost:...", "--inspect=127.0.0.1:P" → "ws://127.0.0.1:...").
                    // The capture group below is host-agnostic and passed to onInspectorReady
                    // (and from there straight into InspectorClient's dial URL) verbatim — so
                    // pinning the bind host to 127.0.0.1 above is sufficient to keep bind and
                    // dial identical; no host rewriting is needed here.
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
            liveChildren.delete(childProcess);
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
            liveChildren.delete(childProcess);
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
