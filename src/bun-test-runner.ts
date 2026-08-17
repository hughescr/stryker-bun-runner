/**
 * Main TestRunner implementation for Bun
 * Implements the Stryker TestRunner API
 */

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MutantCoverage, StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import {
    DryRunStatus,
    MutantRunStatus,
    TestStatus,
    type TestRunner,
    type DryRunResult,
    type MutantRunOptions,
    type MutantRunResult,
    type TestRunnerCapabilities,
    type SuccessTestResult,
    type FailedTestResult,
    type SkippedTestResult
} from '@stryker-mutator/api/test-runner';
import {
    generatePreloadScript,
    cleanupPreloadScript,
    collectCoverage,
    collectLateHits,
    cleanupCoverageFile,
    resolveEagerModulesFromGlobs,
    mapCoverageToInspectorIds,
    type LateHitEntry
} from './coverage/index.js';
import { InspectorClient, type InspectorCloseInfo } from './inspector/index.js';
import type { TestInfo } from './inspector/types.js';
import type { StrykerBunOptions } from './options.js';
import { parseBunTestOutput, type ParsedTestResults } from './parsers/console-parser.js';
import { runBunTests } from './process-runner.js';
import { getAvailablePort, SyncServer, generateSanitizedBunfig, cleanupSanitizedBunfig, normalizeTestFilePath, normalizeTestName, buildUniqueTestName, buildProjectFileTestName, buildTestNamePattern, discoverTestFiles, buildDiscoveryOrderIndex, sortDuplicateGroupByLineThenDiscovery } from './utils/index.js';

/**
 * Sleep for the given number of milliseconds.
 * Extracted to satisfy no-promise-executor-return: the executor only schedules a
 * timer and does not return its value.
 */
function sleep(ms: number): Promise<void> {
    // Stryker disable next-line BlockStatement: removing the setTimeout body causes the Promise to never resolve → infinite loop / Timeout — expected
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Give up the drain handler's wait after this much TRUE silence — no frames of
 * any kind received on the inspector connection (see
 * InspectorClient.getMsSinceLastFrame). Deliberately equal to the old fixed
 * round-trip bound this replaces: a genuinely dead stream never waits longer
 * than it did before, while a stream still making progress is not bounded by
 * this value at all, only by DRAIN_ACK_ABSOLUTE_CEILING_MS.
 */
const DRAIN_ACK_SILENCE_TIMEOUT_MS = 4000;
/**
 * Hard backstop on the drain handler's TOTAL wait regardless of ongoing
 * progress — pure hang prevention, not the primary bound. Must stay BELOW the
 * preload's DRAIN_ACK_TIMEOUT_MS (40000ms, src/templates/coverage-preload.ts),
 * which is the true outermost backstop, and is added to the dry-run child's
 * kill timeout (see the runBunTests call in dryRun) so the whole-process kill
 * timer cannot fire before this ceiling can matter.
 */
const DRAIN_ACK_ABSOLUTE_CEILING_MS = 30_000;
/** Poll cadence of raceAgainstSilence's progress check. */
const DRAIN_SILENCE_POLL_INTERVAL_MS = 250;
/** Cap on individually listed found-id gaps in drain diagnostic log lines. */
const MAX_GAP_IDS_LISTED = 20;

/** Rejection type for raceAgainstSilence, carrying WHICH bound fired. */
class DrainWaitTimeoutError extends Error {
    readonly reason: 'silence' | 'ceiling';
    constructor(message: string, reason: 'silence' | 'ceiling') {
        super(message);
        // Stryker disable next-line StringLiteral: this.name is never read anywhere in this codebase — only .reason drives behavior (via drainSettleReason, see raceAgainstSilence's callers) — cosmetic Error API surface only, not functionally observable
        this.name = 'DrainWaitTimeoutError';
        this.reason = reason;
    }
}

/**
 * A promise that rejects once EITHER `absoluteCeilingMs` total has elapsed
 * since the call, OR at least `silenceMs` has elapsed since the call AND the
 * inspector connection has received no frames at all for `silenceMs` —
 * whichever a poll tick observes first. Polls on an interval instead of a
 * fixed timer so ongoing frame arrival (proof a backlog is still draining)
 * keeps deferring the give-up — §3a.
 *
 * The silence check is deliberately anchored to THIS CALL's elapsed time, not
 * only to {@link InspectorClient.getMsSinceLastFrame}'s connection-wide clock:
 * that clock can already be stale the instant this function is invoked (e.g.
 * the final test ran for several seconds with no inspector traffic in
 * flight), and using it alone would let the very first poll tick give up
 * before the ack this call is racing against ever got a real window to
 * arrive — silently reproducing the race this replaces `rejectAfterMs` to
 * fix. Requiring elapsed-since-call to also clear `silenceMs` guarantees this
 * call always waits at least `silenceMs` from its own start before silence
 * can be the reason it gives up, matching the old fixed-timeout's minimum
 * wait. The ceiling is checked first so that if both bounds are satisfied on
 * the same tick (e.g. the event loop stalls and resumes well past the
 * ceiling), the more severe bound is the one reported.
 *
 * `cancel()` MUST be called once the caller's race is decided: an uncleared
 * interval keeps the event loop alive indefinitely.
 */
function raceAgainstSilence(
    inspector: InspectorClient,
    silenceMs: number,
    absoluteCeilingMs: number,
    message: string
): { promise: Promise<never>, cancel: () => void } {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setInterval>;
    const promise = new Promise<never>((_resolve, reject) => {
        timer = setInterval(() => {
            const sinceLastFrame = inspector.getMsSinceLastFrame();
            const totalElapsed = Date.now() - startedAt;
            if(totalElapsed >= absoluteCeilingMs) {
                clearInterval(timer);
                // Stryker disable next-line StringLiteral: the message TEMPLATE (not the 'ceiling' literal, which is separately defended by the reason: 'silence'|'ceiling' type — an invalid string here is a TypeScript compile error, killed by the checker) is never read anywhere; only DrainWaitTimeoutError.reason (via drainSettleReason) drives behavior — .message content is not functionally observable
                reject(new DrainWaitTimeoutError(`${message}: ${absoluteCeilingMs}ms absolute ceiling reached`, 'ceiling'));
            } else if(totalElapsed >= silenceMs && sinceLastFrame >= silenceMs) {
                clearInterval(timer);
                // Stryker disable next-line StringLiteral: same reasoning as the ceiling branch above — message TEMPLATE only, not the type-defended 'silence' literal
                reject(new DrainWaitTimeoutError(`${message}: ${sinceLastFrame}ms of inspector silence (limit ${silenceMs}ms)`, 'silence'));
            }
        }, DRAIN_SILENCE_POLL_INTERVAL_MS);
    });
    return { promise, cancel: () => clearInterval(timer) };
}

/** ' [1,2,3]' / ' [first 20,…]' suffix for gap log lines; '' when no gaps. */
function formatGapIdList(gaps: readonly number[]): string {
    if(gaps.length === 0) {
        return '';
    }
    const shown = gaps.slice(0, MAX_GAP_IDS_LISTED).join(',');
    return gaps.length > MAX_GAP_IDS_LISTED ? ` [${shown},…]` : ` [${shown}]`;
}

/**
 * 'never requested' / 'settled via <reason>' for the step-9 post-drain summary
 * log — extracted (rather than an inline ternary in {@link BunTestRunner.dryRun})
 * purely to keep dryRun's own cyclomatic complexity under the lint threshold.
 */
function formatDrainSettleReason(reason: 'ack' | 'silence' | 'ceiling' | 'send-rejected' | undefined): string {
    return reason === undefined ? 'never requested' : `settled via ${reason}`;
}

/**
 * Shape of the persisted dryRun registry file (version 2).
 * Version 2 adds testNameIndex: the FINAL test id (dedup ' [N]' suffix
 * included) → Bun's exact internal matching name (TestInfo.bunName), used by
 * buildTestNamePattern's exact-name fast path. Version-1 files are rejected
 * by loadRegistryFile — they can only be stale data from a prior plugin
 * version, and the reader safely degrades to the lossy pattern path.
 */
interface RegistryFileV2 {
    version:         number
    writtenAt:       number
    cachedTestNames: string[]
    baseNameIndex:   [string, string[]][]
    testNameIndex:   [string, string][]
}

/** Union of the per-test result shapes the runner produces for Stryker. */
type RunnerTestResult = SuccessTestResult | FailedTestResult | SkippedTestResult;

/**
 * Zip per-execution-order bun names onto FINAL test ids.
 *
 * Must run AFTER buildTestsFromInspector's duplicate-name dedup loop: that loop
 * mutates test.id/test.name in place and never reorders the array, so tests[i]
 * still corresponds to bunNames[i]. Keys are the FINAL test.id (' [N]' dedup
 * suffix included) — the exact strings Stryker later echoes back in
 * options.testFilter. Entries whose bunName is undefined (unknown-inspectorId
 * placeholders, TestInfo without bunName) are omitted so those ids stay on the
 * lossy pattern path.
 */
function buildTestNameIndex(
    tests: readonly RunnerTestResult[],
    bunNames: readonly (string | undefined)[]
): Map<string, string> {
    const testNameIndex = new Map<string, string>();
    for(const [i, test] of tests.entries()) {
        const bunName = bunNames[i];
        if(bunName !== undefined) {
            testNameIndex.set(test.id, bunName);
        }
    }
    return testNameIndex;
}

/**
 * Contiguous plain-text fragment of bun's zero-match --test-name-pattern stderr
 * (byte-verified, bun 1.3.14, including under FORCE_COLOR=3): bun ANSI-colors
 * "error:" and the quoted pattern even when piped, but never this fragment.
 * Emitted only when matches across the WHOLE run are 0 — a partial pattern
 * miss exits 0 with no error text (verified live), so this can never fire on
 * a partial miss, only a total one.
 */
// Stryker disable next-line Regex: version-coupled to bun's exact wording; see the doc comment above and mutantRun/checkRuntimeError's behavioral tests
const ZERO_MATCH_TEST_PATTERN_RE = /matched 0 tests\./;

/**
 * Cap on how many failed-test entries formatInspectorFailureDetails lists
 * individually before collapsing the remainder into a "...and N more" line.
 * Keeps the dry-run error message bounded when a whole suite fails.
 */
const MAX_DRY_RUN_FAILURE_TESTS_LISTED = 20;

/**
 * Cap on how many coverage-bleed warnings emitCoverageBleedWarnings logs
 * individually before collapsing the remainder into a "...and N more" line.
 * Keeps dry-run log output bounded when many tests leak fire-and-forget work.
 */
const MAX_COVERAGE_BLEED_WARNINGS = 25;

/**
 * Dry-run completeness gate thresholds, guarding against a silently truncated
 * inspector event stream (e.g. a whole test file dropped under CI runner
 * contention) — see {@link BunTestRunner.checkCompletenessGate}. Conservative relative to the
 * incident magnitude (executionOrder truncated ~35%, thousands of orphaned
 * coverage keys) but not validated against production-scale healthy runs; a
 * quick pass over real CI dry-run logs is worth doing before relying on these
 * in a very high-volume environment. Signal A (execution/console shortfall):
 * a shortfall must clear BOTH the absolute floor and the ratio floor to fire —
 * this two-part rule protects small suites (where a handful of tests is a
 * huge ratio) and huge suites (where a huge ratio would take a huge absolute
 * count) symmetrically.
 */
const EXECUTION_SHORTFALL_ABS_FLOOR = 10;
/** See {@link EXECUTION_SHORTFALL_ABS_FLOOR}. */
const EXECUTION_SHORTFALL_RATIO_THRESHOLD = 0.05;
/**
 * Signal B (orphaned coverage keys) threshold — see
 * {@link BunTestRunner.checkCompletenessGate}. A whole file dropped from the
 * inspector stream orphans every one of that file's coverage keys at once, so
 * this floor is deliberately much lower than Signal A's: even a small file
 * (more than a handful of tests) dropped entirely should trip the gate.
 */
const ORPHANED_KEY_ABS_FLOOR = 5;

/**
 * How long the completeness gate waits, after {@link InspectorClient.expectClose}
 * is called, for the WebSocket to actually finish closing before snapshotting
 * inspector data — see the drain step in {@link BunTestRunner.dryRun}. This only
 * needs to cover the gap between child-process exit and the WS's own teardown
 * of an already-idle socket (not a real network round-trip), so it is kept short.
 */
const INSPECTOR_DRAIN_TIMEOUT_MS = 1000;

/**
 * Bun test runner for Stryker mutation testing
 */
export class BunTestRunner implements TestRunner {
    public static readonly inject = tokens(commonTokens.logger, commonTokens.options);

    private readonly bunPath:             string;
    private readonly timeout:             number;
    private readonly inspectorTimeout:    number;
    private readonly env?:                Record<string, string>;
    private readonly bunArgs?:            string[];
    private readonly testFilesOverride?:  string[];
    private readonly mutateGlobs:         readonly string[];
    private readonly smol:                boolean;
    private readonly maxChildRss?:        number;
    private readonly rssCheckIntervalMs?: number;
    private readonly maxSpawnDepth?:      number;
    private preloadScriptPath?:           string;
    private coverageFilePath?:            string;
    private sanitizedBunfigPath?:         string;
    private sanitizedBunfigCwd?:          string;
    private tempDir?:                     string;
    private cachedTestNames?:             Set<string>;
    private baseNameIndex?:               Map<string, string[]>;
    private testNameIndex?:               Map<string, string>;
    private cachedTestFiles?:             string[];
    private cachedTestFilesCwd?:          string;
    private cachedEagerModules?:          string[];
    private cachedEagerModulesCwd?:       string;
    private lastRegistryTmpPath?:         string;

    /**
   * AbortController for whichever `dryRun`/`mutantRun` child process is
   * currently in flight, if any. Lets {@link dispose} kill an orphaned child
   * if Stryker disposes this runner while a run hasn't finished — see README
   * "Orphan prevention".
   */
    private currentAbortController?: AbortController;

    constructor(
        private readonly logger: Logger,
        options: StrykerOptions
    ) {
        const bunOptions = (options as StrykerBunOptions).bun ?? {};

        this.bunPath = bunOptions.bunPath ?? 'bun';
        this.timeout = bunOptions.timeout ?? 10_000;
        this.inspectorTimeout = bunOptions.inspectorTimeout ?? 5000;
        this.env = bunOptions.env;
        this.bunArgs = bunOptions.bunArgs;
        this.smol = bunOptions.smol ?? false;
        this.maxChildRss = bunOptions.maxChildRss;
        this.rssCheckIntervalMs = bunOptions.rssCheckIntervalMs;
        this.maxSpawnDepth = bunOptions.maxSpawnDepth;
        // Treat empty array as undefined — an empty testFiles list is useless and
        // is most likely a configuration mistake.  getOrDiscoverTestFiles() will
        // auto-discover instead.  A warning is logged so the user is not surprised.
        // Stryker disable next-line ConditionalExpression,EqualityOperator: treating [] as undefined is deliberate; a mutation that skips this guard would forward an empty array, causing bun test to receive no files and exit 0 with 0 tests — a silent, hard-to-diagnose failure
        if(bunOptions.testFiles?.length === 0) {
            // Stryker disable next-line StringLiteral: diagnostic warning message
            this.logger.warn('bun.testFiles was set to an empty array — treating as undefined and falling back to auto-discovery');
            this.testFilesOverride = undefined;
        } else {
            this.testFilesOverride = bunOptions.testFiles;
        }
        // StrykerOptions.mutate is declared non-optional but Stryker may not always
        // populate it (e.g. in unit tests that pass a partial options object).
        this.mutateGlobs = (options as { mutate?: string[] }).mutate ?? [];

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner initialized with options: %o', {
            bunPath:            this.bunPath,
            timeout:            this.timeout,
            inspectorTimeout:   this.inspectorTimeout,
            env:                this.env,
            bunArgs:            this.bunArgs,
            smol:               this.smol,
            maxChildRss:        this.maxChildRss,
            rssCheckIntervalMs: this.rssCheckIntervalMs,
            maxSpawnDepth:      this.maxSpawnDepth,
        });

        // Warn when absolute testFiles paths are used inside a Stryker sandbox.
        // In a sandbox, cwd is .stryker-tmp/sandbox-XYZ/ and contains copies of
        // the project's source and test files.  Absolute paths bypass the sandbox
        // copy and point at the ORIGINAL (unmutated) files, so mutations are
        // silently ignored.  Relative paths are always preferred in Stryker context.
        // Stryker disable next-line ConditionalExpression,LogicalOperator: sandbox-detection guard — mutation that skips the warn is equivalent (no behaviour change in non-sandbox runs); mutation testing of the warn itself is not meaningful
        if(this.testFilesOverride?.some(p => path.isAbsolute(p))) {
            // Stryker disable next-line StringLiteral: sandbox detection uses .stryker-tmp/sandbox- prefix
            const isSandbox = process.cwd().includes('.stryker-tmp/sandbox-');
            if(isSandbox) {
                this.logger.warn(
                    'bun.testFiles contains absolute path(s) and the current working directory appears to be a Stryker sandbox (%s). '
                    + 'Absolute paths point at the ORIGINAL (unmutated) source files — mutations will be silently bypassed. '
                    + 'Use relative paths so that Bun resolves them against the sandbox copy.',
                    process.cwd()
                );
            }
        }
    }

    /**
     * Single source of truth for the registry file name.
     *
     * Lives in the OS temp directory, not cwd: under Stryker's --inPlace mode
     * cwd IS the user's real project root, and writing there would both
     * pollute the user's project and never get cleaned up (dispose()
     * deliberately never unlinks the registry itself — see its doc comment).
     * The temp directory is OS-managed instead.
     *
     * Keyed by sha256(cwd + ':' + ppid): every worker process Stryker spawns
     * for one run is a direct child of that run's single Stryker main
     * process, so all of them share BOTH process.cwd() (the sandbox
     * directory) AND process.ppid (the main process's pid) — and therefore
     * independently derive this SAME path with no coordination required. A
     * worker recycled mid-run is still a child of the same main process, so
     * it re-derives the same path too (README documents recycled instances
     * lazily loading the registry). This is the entire sharing contract:
     * writer (buildAndPersistTestRegistry) and reader (loadRegistryFile) both
     * go through this one getter rather than reimplementing the formula, so
     * they can never disagree by construction.
     *
     * process.ppid is what makes this safe for this repo's own dogfooding:
     * this plugin's own unit/integration tests run INSIDE a Stryker sandbox as
     * the system under test, as children of the sandbox WORKER process, not
     * of the Stryker main process — so those inner test processes hash a
     * different ppid and land on a different file, and can never clobber the
     * outer run's registry. A worker-unique key (e.g. the STRYKER_MUTATOR_WORKER
     * env var Stryker injects per forked worker) was considered and rejected
     * for the same reason it would break the cross-worker sharing above: it
     * uniquely identifies each worker, not the run.
     *
     * process.cwd() is read directly (not resolved via fs.realpathSync):
     * Stryker's child-process-proxy-worker computes every worker's chdir
     * target via a pure path.resolve() of an identical IPC string, so all
     * workers of a run already get a byte-identical process.cwd() with no
     * symlink divergence to guard against — realpath would only add a
     * syscall (and a new ENOENT failure mode if the sandbox dir is mid-
     * teardown) for no benefit.
     *
     * Using a getter that reads process.cwd()/process.ppid at call time
     * (rather than caching at construction) ensures the path resolves against
     * Stryker's sandbox directory — which is set by the time these are
     * invoked — rather than the orchestrator's cwd at module-load time.
     */
    private get registryPath(): string {
        const key = `${process.cwd()}:${process.ppid}`;
        const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
        return path.join(tmpdir(), 'stryker-bun-runner', `registry-${hash}.json`);
    }

    private get registryTmpPath(): string {
        return `${this.registryPath}.tmp`;
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
   * Return the test file list to use for this run.
   * When `bun.testFiles` was provided it is returned verbatim and
   * auto-discovery is skipped entirely.  Otherwise the result is cached after
   * the first real discovery call so that subsequent callers (dryRun, mutantRun)
   * do not re-glob the filesystem.
   */
    private async getOrDiscoverTestFiles(): Promise<string[] | undefined> {
        // Stryker disable next-line EqualityOperator,BlockStatement: EqualityOperator: inverts condition, ignoring override → discovery runs on wrong files → Timeout; BlockStatement: removes early return, override ignored → Timeout
        if(this.testFilesOverride !== undefined) {
            return this.testFilesOverride;
        }
        const cwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations caught by 'rediscovers test files when cwd changes'
        if(this.cachedTestFiles !== undefined && this.cachedTestFilesCwd === cwd) {
            return this.cachedTestFiles;
        }
        this.cachedTestFiles = await discoverTestFiles(cwd, this.logger);
        this.cachedTestFilesCwd = cwd;
        return this.cachedTestFiles;
    }

    /**
   * Test-file cache hit for a given cwd.
   * Returns the cached list synchronously when available, or undefined to
   * signal that async re-discovery is needed (cwd changed or first call).
   * Used by dryRun() to avoid introducing a microtask yield on the hot path.
   */
    private testFilesCacheHit(cwd: string): string[] | undefined | null {
        // Stryker disable next-line EqualityOperator,BlockStatement,ConditionalExpression: mutating to false (ConditionalExpression) causes a null cache-miss that falls through to getOrDiscoverTestFiles(), which re-checks testFilesOverride and returns the same value — equivalent; BlockStatement (removing early-return) and EqualityOperator (flipping guard) mutants are caught by 'should use testFiles override and skip discoverTestFiles'; the ConditionalExpression→true mutant (always returns the override) is equivalent because whenever testFilesOverride is defined it is returned either way
        if(this.testFilesOverride !== undefined) {
            return this.testFilesOverride;
        }
        // Stryker disable next-line ConditionalExpression,EqualityOperator: cache hit — cwd match; ConditionalExpression→false mutant would return stale cached files whenever cwd changes (returning wrong file list for new sandbox); EqualityOperator→!== mutant would force re-discovery every call even when cwd is unchanged (performance regression); both are caught by 'rediscovers test files when cwd changes between init() and dryRun()'
        return (this.cachedTestFiles !== undefined && this.cachedTestFilesCwd === cwd)
            ? this.cachedTestFiles
            : null;   // null = cache miss, caller must use getOrDiscoverTestFiles()
    }

    /**
   * Initialize the test runner
   */
    // Stryker disable next-line BlockStatement: removing init() body means no preload/bunfig/test-files setup → dryRun hangs → Timeout — expected
    public async init(): Promise<void> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner init starting...');

        // If init() is called more than once (Stryker sandbox lifecycle rotation),
        // clean up the preload script and coverage file from the previous init()
        // before generating new ones.  Without this, re-init leaks tmp files on disk.
        if(this.preloadScriptPath) {
            // Stryker disable next-line BlockStatement: cleanup-on-re-init guard; removing body leaks previous preload script file on disk — caught by 'cleans up previous preload script when init() is called again'
            try {
                await cleanupPreloadScript(this.preloadScriptPath);
            } catch (error) {
                // ENOENT or other FS errors are non-fatal; the old file is simply absent
                // Stryker disable next-line StringLiteral: diagnostic log message
                this.logger.debug('Failed to clean up previous preload script on re-init: %s', error instanceof Error ? error.message : String(error));
            }
            this.preloadScriptPath = undefined;
        }
        if(this.coverageFilePath) {
            // Stryker disable next-line BlockStatement: cleanup-on-re-init guard; removing body leaks previous coverage file on disk — caught by 'cleans up previous coverage file when init() is called again'
            try {
                await cleanupCoverageFile(this.coverageFilePath);
            } catch (error) {
                // ENOENT or other FS errors are non-fatal
                // Stryker disable next-line StringLiteral: diagnostic log message
                this.logger.debug('Failed to clean up previous coverage file on re-init: %s', error instanceof Error ? error.message : String(error));
            }
            this.coverageFilePath = undefined;
        }

        // Generate preload script for coverage collection
        const tempDir = path.join(tmpdir(), 'stryker-bun-runner');
        this.tempDir = tempDir;
        this.coverageFilePath = path.join(tempDir, `coverage-${Date.now()}.json`);

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Generating coverage preload script...');

        // Resolve StrykerOptions.mutate globs to an absolute file list.
        // The resolution is relative to process.cwd(), so if cwd changes between
        // init() calls (Stryker sandbox rotation) we must re-resolve from the new cwd.
        const eagerCwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations caught by 're-resolves eager modules when cwd changes'
        if(this.cachedEagerModules === undefined || this.cachedEagerModulesCwd !== eagerCwd) {
            this.cachedEagerModules    = await resolveEagerModulesFromGlobs(this.mutateGlobs);
            this.cachedEagerModulesCwd = eagerCwd;
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Resolved %d eager modules from mutate globs', this.cachedEagerModules.length);
        }

        this.preloadScriptPath = await generatePreloadScript({
            tempDir,
            coverageFile: this.coverageFilePath,
            eagerModules: this.cachedEagerModules,
        });
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Preload script generated at: %s', this.preloadScriptPath);

        // Pre-warm the sanitized bunfig cache so that dryRun/mutantRun can use the
        // cached path synchronously (avoiding async overhead on the hot path).
        // ensureSanitizedBunfig() will regenerate if cwd changes between phases.
        await this.ensureSanitizedBunfig();

        // Pre-warm the test-file list so that dryRun() and mutantRun() can use the
        // cached result without adding an async I/O hop on the fake-timer-sensitive
        // hot path.  If cwd changes between init and dryRun (Stryker sandbox rotation),
        // getOrDiscoverTestFiles() will detect the stale cachedTestFilesCwd key and
        // re-glob from the new cwd before returning.
        this.cachedTestFiles = await this.getOrDiscoverTestFiles();
    }

    /**
   * Regenerate the sanitized bunfig if the worker's cwd has changed (or if this
   * is the first spawn). Bun resolves relative paths in a bunfig against the
   * bunfig file's location, so keying on cwd ensures preload/root paths land in
   * the right sandbox.
   */
    private async ensureSanitizedBunfig(): Promise<string> {
        const cwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations are caught by test 'reuses cached bunfig when cwd unchanged'
        if(this.sanitizedBunfigPath && this.sanitizedBunfigCwd === cwd) {
            return this.sanitizedBunfigPath;
        }
        // Stryker disable next-line BlockStatement: cleanup branch covered by 'cleans up old bunfig when cwd changes'
        if(this.sanitizedBunfigPath) {
            await cleanupSanitizedBunfig(this.sanitizedBunfigPath);
        }
        // Stryker disable next-line StringLiteral: equivalent mutant — mutating 'stryker-bun-runner' to '' still produces a valid writable directory under tmpdir(); sanitized bunfig generation succeeds either way
        const tempDir = this.tempDir ?? path.join(tmpdir(), 'stryker-bun-runner');
        this.sanitizedBunfigPath = await generateSanitizedBunfig(cwd, tempDir);
        this.sanitizedBunfigCwd  = cwd;
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Sanitized bunfig (re)generated at: %s for cwd: %s', this.sanitizedBunfigPath, cwd);
        return this.sanitizedBunfigPath;
    }

    /**
   * Load the shared dryRun registry written by the one worker that ran dryRun.
   * Populates this.cachedTestNames, this.baseNameIndex, and this.testNameIndex
   * so that subsequent mutantRun calls on this worker can resolve killedBy names
   * and build exact --test-name-pattern alternatives, even for static-coverage
   * mutants where testFilter is empty.
   *
   * Loading is all-or-nothing: a wrong version or a malformed field rejects the
   * whole file (never a half-initialised registry). Failures are non-fatal — the
   * worker falls back to raw console names and the lossy pattern reconstruction,
   * and a warning is logged so the issue is visible.
   */
    private async loadRegistryFile(): Promise<void> {
        const registryPath = this.registryPath;
        try {
            const raw = await fsPromises.readFile(registryPath, 'utf8');
            const parsed = JSON.parse(raw) as RegistryFileV2;
            if(parsed.version !== 2) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn('dryRun registry file has unexpected version %s; skipping', String(parsed.version));
                return;
            }
            if(!Array.isArray(parsed.cachedTestNames) || !Array.isArray(parsed.baseNameIndex) || !Array.isArray(parsed.testNameIndex)) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'dryRun registry file is malformed (cachedTestNames, baseNameIndex, or testNameIndex missing or not an array); treating as absent'
                );
                return;
            }
            // Per-entry validation is limited to testNameIndex: its values feed
            // escapeRegex() on the exact-name fast path, where a non-string would
            // throw mid-mutantRun. cachedTestNames/baseNameIndex flow only into
            // Set/Map lookups, where malformed entries are inert, so they keep
            // the shape-level-only guard above.
            if(!parsed.testNameIndex.every((entry: unknown) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string')) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'dryRun registry file is malformed (testNameIndex entry is not a [string, string] pair); treating as absent'
                );
                return;
            }
            this.cachedTestNames = new Set<string>(parsed.cachedTestNames);
            this.baseNameIndex   = new Map<string, string[]>(parsed.baseNameIndex);
            this.testNameIndex   = new Map<string, string>(parsed.testNameIndex);
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug('Loaded dryRun registry from %s (%d entries)', registryPath, this.cachedTestNames.size);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // Stryker disable next-line BlockStatement: ENOENT path covered by test 'logs debug when registry file not found'
            if(code === 'ENOENT') {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.debug(
                    'dryRun registry file not found at %s; this worker has no static-coverage registry (expected on non-dryRun workers)',
                    registryPath
                );
            // Stryker disable next-line BlockStatement: else branch covered by test 'logs warning when registry file load fails with non-ENOENT error'
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
   * Build the failureMessage for a single failed test in the Complete-path result.
   *
   * Base message prefers the parsed-console failure message, then the inspector's
   * error.message, then falls back to a generic string. Stryker core's
   * logFailedTestsInInitialRun prints exactly name+failureMessage for each failed
   * test in the ConfigError initial-run path, so the inspector's error.stack (when
   * present and not already part of the base message) is appended — that's what
   * makes that path actionable instead of a bare one-liner.
   *
   * NOTE this is a genuine, intentional change to the content of the returned
   * DryRunResult (a failed test's failureMessage is longer / carries a stack it
   * didn't before) — not a diagnostic-only, log-line-only change like the two
   * warn helpers below. Test statuses, ids, coverage, and mutantRun behavior
   * are all unaffected; only failureMessage content is enriched.
   */
    private buildFailureMessage(testInfo: TestInfo, parsed: ParsedTestResults): string {
        const parsedTest = parsed.tests.find(t => t.name.includes(testInfo.name));
        // Stryker disable next-line StringLiteral: fallback error message has no behavioral impact
        const baseFailureMessage = parsedTest?.failureMessage ?? testInfo.error?.message ?? 'Test failed';
        const stack = testInfo.error?.stack;
        return stack && !baseFailureMessage.includes(stack)
            ? `${baseFailureMessage}\n${stack}`
            : baseFailureMessage;
    }

    /**
   * Build test results from inspector data.
   *
   * Also returns a testNameIndex mapping each FINAL test id (dedup ' [N]'
   * suffix included) to Bun's exact internal matching name (TestInfo.bunName)
   * for --test-name-pattern generation. Tests without a bunName — console-
   * fallback results and unknown-inspectorId placeholders — get no index entry
   * and stay on the lossy pattern reconstruction path (never worse than before).
   *
   * @param inspectorIdToProjectFile - Optional mapping from inspector ID to project file path.
   *   When provided, the project file is used for TestResult.id, name, and fileName instead of
   *   testInfo.url. This is important for tests defined via helpers (e.g. RuleTester.run()) where
   *   Bun's inspector reports a url pointing to node_modules rather than the user's test file.
   */
    private buildTestsFromInspector(
        testHierarchy: TestInfo[],
        executionOrder: number[],
        parsed: ParsedTestResults,
        totalElapsedMs: number,
        inspectorIdToProjectFile?: Map<number, string>
    ): { tests: RunnerTestResult[], testNameIndex: Map<string, string> } {
        if(executionOrder.length === 0) {
            // Fallback: use parsed console output when inspector didn't capture tests.
            // No TestInfo is available here, so no exact bun names either — the
            // returned index is empty and these ids stay on the lossy pattern path.
            const fallbackTests = parsed.tests.map((t) => {
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
            return { tests: fallbackTests, testNameIndex: new Map<string, string>() };
        }

        // Stryker disable next-line EqualityOperator, ConditionalExpression: mutating > 0 to >= 0 is equivalent here because the early return above already handles executionOrder.length === 0, so length is guaranteed > 0 at this point and the else branch is dead code; ConditionalExpression: true is equivalent for the same reason
        const timePerTest = executionOrder.length > 0
            ? Math.max(1, Math.round(totalElapsedMs / executionOrder.length))
            : 1;

        // Create a map for quick lookup
        const testMap = new Map<number, TestInfo>();
        for(const test of testHierarchy) {
            testMap.set(test.id, test);
        }

        // Bun's exact matching names, index-aligned with executionOrder (and thus
        // with `tests` below). Unknown inspector ids yield undefined → no index entry.
        const bunNames = executionOrder.map(inspectorId => testMap.get(inspectorId)?.bunName);

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

            // Prefer the project file from the coverage counter key mapping when available.
            // The counter key prefix is always the user's test file (via Bun.main in the preload),
            // so it is correct even when testInfo.url points to node_modules.
            // Skipped and pending tests have no counter keys so they fall back to testInfo.url.
            const projectFile = inspectorIdToProjectFile?.get(inspectorId);
            const uniqueName = projectFile
                ? buildProjectFileTestName(projectFile, testInfo.fullName)
                : buildUniqueTestName(testInfo.fullName, testInfo.url);
            const fileName = projectFile ?? normalizeTestFilePath(testInfo.url);
            const status = testInfo.status;
            const elapsed = testInfo.elapsed === undefined
                ? timePerTest                                // Already in milliseconds
                : Math.round(testInfo.elapsed / 1_000_000); // Convert nanoseconds to milliseconds and round

            const startPosition = testInfo.line === undefined ? undefined : { line: testInfo.line, column: 0 };

            if(status === 'fail') {
                return {
                    id:             uniqueName,
                    name:           uniqueName,
                    fileName,
                    startPosition,
                    status:         TestStatus.Failed,
                    failureMessage: this.buildFailureMessage(testInfo, parsed),
                    timeSpentMs:    elapsed,
                } satisfies FailedTestResult;
            }

            if(status === 'skip' || status === 'todo') {
                return {
                    id:          uniqueName,
                    name:        uniqueName,
                    fileName,
                    startPosition,
                    status:      TestStatus.Skipped,
                    timeSpentMs: elapsed,
                } satisfies SkippedTestResult;
            }

            return {
                id:          uniqueName,
                name:        uniqueName,
                fileName,
                startPosition,
                status:      TestStatus.Success,
                timeSpentMs: elapsed,
            } satisfies SuccessTestResult;
        });

        // Handle duplicate test names — the same title registered more than once,
        // e.g. two it('same name') calls in one describe, or it.each on older Bun
        // versions. Bun >=1.3.x reports interpolated it.each names (verified live
        // on 1.3.14), so %s template literals no longer collide here; the dedup
        // machinery is retained for genuinely-duplicate titles and older Bun.
        //
        // IMPORTANT: index assignment must be deterministic regardless of WebSocket
        // message arrival order, AND must agree with coverage-mapper.ts's
        // buildDuplicateNameIndex (same physical test → same '[N]' suffix in both the
        // registry and mutantCoverage.perTest). Both sites sort each group of duplicate-named tests by
        // (source line ascending, then TestReporter.found discovery order) BEFORE
        // assigning [0], [1], … — see src/utils/duplicate-suffix.ts for why discovery
        // order (not execution/start order, which bun's --seed can shuffle) is the
        // tie-break that keeps the two call sites in agreement.
        const discoveryOrderIndex = buildDiscoveryOrderIndex(testHierarchy.map(t => t.id));
        const nameCounts = new Map<string, number>();
        for(const test of tests) {
            nameCounts.set(test.name, (nameCounts.get(test.name) ?? 0) + 1);
        }

        // For names that appear multiple times, collect the group (test result paired
        // with its inspector id for the discovery-order tie-break), sort, then assign
        // suffixes in that order so [0] always refers to the earliest occurrence.
        interface DupEntry { test: RunnerTestResult, inspectorId: number }
        const nameGroups = new Map<string, DupEntry[]>();
        for(const [i, test] of tests.entries()) {
            if((nameCounts.get(test.name) ?? 1) > 1) {
                const entry: DupEntry = { test, inspectorId: executionOrder[i] };
                const group = nameGroups.get(test.name);
                if(group) {
                    group.push(entry);
                } else {
                    nameGroups.set(test.name, [entry]);
                }
            }
        }
        for(const [, group] of nameGroups) {
            const sorted = sortDuplicateGroupByLineThenDiscovery(
                group,
                // Stryker disable next-line StringLiteral: equivalent mutant — mutating 'startPosition' to '' makes the check `'' in e.test`, which is always false because test result objects never have an empty-string key; the extracted line resolves to undefined (→ Infinity in the shared sort helper) either way
                e => (('startPosition' in e.test && e.test.startPosition) ? e.test.startPosition.line : undefined),
                e => e.inspectorId,
                discoveryOrderIndex
            );
            for(const [i, { test }] of sorted.entries()) {
                const uniqueName = `${test.name} [${i}]`;
                test.id = uniqueName;
                test.name = uniqueName;
            }
        }

        // Zip by index AFTER the dedup loop above — see buildTestNameIndex.
        return { tests, testNameIndex: buildTestNameIndex(tests, bunNames) };
    }

    /**
   * Run all tests (dry run)
   */
    public async dryRun(): Promise<DryRunResult> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Running dry run with inspector-based coverage collection...');

        // Create an AbortController so we can kill the child process if the inspector
        // connection fails before the test run completes.  Without this, a failed
        // inspector.connect() would leave the child process running until its own
        // process-level timeout fires — unnecessarily delaying the error result.
        // Also tracked on `this` so dispose() can kill an orphaned child if this
        // runner is disposed while the run is still in flight.
        const abortController = new AbortController();
        this.currentAbortController = abortController;

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

        const startTime = Date.now();
        let inspectorUrl: string | null = null;

        // Wrap everything after server start in try/finally so syncServer.close()
        // is always called even if any intermediate step throws (bunfig regen, test
        // file re-discovery, inspector.close(), etc.).
        // SyncServer.close() is idempotent (wss/httpServer guarded by null checks),
        // so the explicit early-return closes below are harmless double-closes.
        try {
            // 3. Resolve bunfig and test file list, then start bun test process.

            // Use cached bunfig path synchronously when available (pre-warmed by init()).
            // Fall back to async generation only when cwd has changed (Stryker sandbox rotation).
            const cwd = process.cwd();
            // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: inline cache hit — same pattern as ensureSanitizedBunfig, covered by 'reuses cached bunfig in dryRun when cwd unchanged'
            const bunfigPath = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === cwd)
                ? this.sanitizedBunfigPath
                : await this.ensureSanitizedBunfig();

            // Resolve the test file list — synchronously on cache hit, async on cache miss.
            // Using a two-step check avoids the microtask yield that `await` of a non-Promise
            // would otherwise introduce on the hot path (which matters for fake-timer tests).
            // Stryker disable next-line ConditionalExpression,BlockStatement: cache-miss path covered by 'rediscovers test files when cwd changes between init() and dryRun()'
            const testFilesCached = this.testFilesCacheHit(cwd);
            const testFiles = testFilesCached === null ? await this.getOrDiscoverTestFiles() : testFilesCached;

            // Start test process with callback to get inspector URL
            const testProcess = runBunTests({
                bunPath:               this.bunPath,
                // The dry-run child's lifetime legitimately includes the post-test drain
                // handshake; without this headroom the whole-process kill timer
                // (process-runner.ts, default bun.timeout=10000) would SIGTERM the child
                // before the drain ceiling could ever matter. This is a single watchdog
                // covering the child's ENTIRE lifetime, test execution included — it is
                // NOT phase-specific, so a dry run whose tests themselves hang (never
                // reaching the drain phase at all) is also, as a side effect, only
                // detected/killed after this.timeout + the ceiling rather than
                // this.timeout alone. Accepted: this only affects the single dry-run
                // child (not the per-mutant hot loop below, which still uses
                // this.timeout unmodified), and a genuinely hung dry run is already a
                // rare, one-time cost.
                timeout:               this.timeout + DRAIN_ACK_ABSOLUTE_CEILING_MS,
                env:                   this.env,
                bunArgs:               this.bunArgs,
                bunfigPath,
                preloadScript:         this.preloadScriptPath,
                coverageFile:          this.coverageFilePath,
                inspectWaitPort:       inspectPort,
                sequentialMode:        true,  // Critical for correlation
                syncPort, // Pass sync port to preload script via env var
                testFiles,
                signal:                abortController.signal,
                smol:                  this.smol,
                maxChildRss:           this.maxChildRss,
                rssCheckIntervalMs:    this.rssCheckIntervalMs,
                maxSpawnDepth:         this.maxSpawnDepth,
                onMemoryLimitExceeded: (rssBytes: number) => {
                    this.logger.warn(
                        'bun test child exceeded maxChildRss (%d bytes observed) during dryRun — killing and reporting as a timeout for this run',
                        rssBytes
                    );
                },
                // Stryker disable next-line BlockStatement: removing callback body means inspectorUrl never set → infinite poll → Timeout
                onInspectorReady: (url: string) => {
                    inspectorUrl = url;
                },
            });

            // 4. Wait for inspector URL with timeout
            const waitStart = Date.now();
            // Stryker disable next-line EqualityOperator,LogicalOperator,ConditionalExpression,BlockStatement: EqualityOperator < vs <= is equivalent; LogicalOperator && → || loops forever → Timeout; ConditionalExpression always-true loops forever → Timeout; BlockStatement removes sleep → busy-wait blocks callback → Timeout
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-unmodified-loop-condition -- inspectorUrl set by async callback in runBunTests; TypeScript cannot track cross-await mutations
            while(!inspectorUrl && Date.now() - waitStart < this.inspectorTimeout) {
                // eslint-disable-next-line no-await-in-loop -- sequential polling required; inspectorUrl set by async callback
                await sleep(50);
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- inspectorUrl set by async callback; TypeScript cannot track cross-await mutations
            if(!inspectorUrl) {
                // Await the child to drain its stdout/stderr so we can surface what Bun
                // actually emitted before we abandoned it.  Some setups (e.g. preload
                // scripts that fail to resolve) can make Bun exit before the inspector
                // banner is printed; without this diagnostic the user only sees a
                // useless "Timeout waiting for inspector URL".
                const diagnosticResult = await testProcess;
                // Stryker disable next-line MethodExpression: equivalent mutant — slice(0,1000) vs full string is only observable in diagnostic log output, not in test behavior
                const stdoutPreview = diagnosticResult.stdout.slice(0, 1000);
                // Stryker disable next-line MethodExpression: equivalent mutant — slice(0,1000) vs full string is only observable in diagnostic log output, not in test behavior
                const stderrPreview = diagnosticResult.stderr.slice(0, 1000);
                // Stryker disable StringLiteral: logging message format strings — not behaviorally tested
                this.logger.error(
                    'Failed to get inspector URL within timeout (%dms).\nexit=%s timedOut=%s\n'
                    + '--- STDOUT (first 1000 chars) ---\n%s\n'
                    + '--- STDERR (first 1000 chars) ---\n%s',
                    this.inspectorTimeout,
                    String(diagnosticResult.exitCode),
                    String(diagnosticResult.timedOut),
                    // Stryker restore StringLiteral
                    // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — '(empty)' fallback only affects diagnostic log message content
                    stdoutPreview || '(empty)',
                    // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — '(empty)' fallback only affects diagnostic log message content
                    stderrPreview || '(empty)'
                );
                return {
                    status:       DryRunStatus.Error,
                    errorMessage: 'Timeout waiting for inspector URL',
                };
            }

            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Inspector URL: %s', inspectorUrl);

            // 5. Create inspector client
            const inspector = new InspectorClient({
                url:               inspectorUrl,
                connectionTimeout: this.inspectorTimeout,
                requestTimeout:    this.inspectorTimeout,
                // No per-test relay needed - coverage uses file-prefixed counter keys.
                // onError IS wired up — previously
                // `handlers: {}` silently discarded every inspector error (malformed
                // messages, "Test start/end event for unknown test ID", circular hierarchy
                // references, WS error events); a live-suite baseline check (16 files, 925
                // tests, 2 runs) found zero such events on a healthy run, so nothing here
                // warrants a quieter log level.
                handlers:          {
                    onError: (error: Error) => {
                        // Stryker disable next-line StringLiteral: logging message only
                        this.logger.warn('Inspector error: %s', error.message);
                    },
                    // debug, not warn: on the healthy path the child closes its own
                    // inspector socket right after receiving 'drained', which routinely
                    // wins the race against our own expectClose() call (only reached
                    // after `await testProcess` resolves, i.e. after OS-level process
                    // exit) — see the integration test covering this exact scenario. So
                    // this fires on a nontrivial fraction of clean runs and is NOT itself
                    // evidence of anything wrong; it is diagnostic context only, folded
                    // into the completeness gate's error message (never a standalone
                    // trigger — see checkCompletenessGate's doc comment).
                    onUnexpectedClose: (context) => {
                        this.logger.debug(
                            'Inspector WebSocket closed while the run was still thought to be in progress (wsClosed=%s closeExpected=%s isClosing=%s closeCode=%s closeReason=%s closeWasClean=%s msFromLastFrameToClose=%s) — often benign; see checkCompletenessGate',
                            context.wsClosed, context.closeExpected, context.isClosing,
                            String(context.closeCode), String(context.closeReason), String(context.closeWasClean), String(context.msFromLastFrameToClose)
                        );
                    },
                    // Diagnostic-only, distinct from raceAgainstSilence's total-silence give-up:
                    // proves the connection is still receiving SOMETHING while one specific
                    // request (e.g. TestReporter.enable) goes unanswered — see
                    // InspectorEventHandlers.onRequestStall's doc comment.
                    onRequestStall: (info) => {
                        this.logger.warn(
                            'Inspector request unanswered after %dms even though other frames are still arriving (last frame %dms ago): %s (id=%d) — possible protocol-level stall distinct from total silence',
                            info.msUnanswered, info.msSinceLastFrame, info.method, info.id
                        );
                    },
                },
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
                // Kill the orphaned child process — without aborting it, the bun test
                // process would keep running until its own timeout fires.
                abortController.abort();
                await inspector.close();
                return {
                    status:       DryRunStatus.Error,
                    errorMessage: `Failed to connect to Bun inspector: ${errorMsg}`,
                };
            }

            // undefined = drain-request never arrived (step 9 reports this distinctly).
            let drainSettleReason: 'ack' | 'silence' | 'ceiling' | 'send-rejected' | undefined;

            // 6.5 Register a drain handler: the preload's final afterAll blocks on a
            // 'drained' acknowledgment from the runner before closing its sync socket
            // and exiting. This handler is what PROVES drain —
            // an inspector-protocol round-trip on the SAME ordered connection that
            // TestReporter events arrive on. Because InspectorClient.handleMessage
            // processes every frame synchronously and in order (no internal queue), and
            // TCP preserves per-connection ordering, receiving this round-trip's reply
            // guarantees every TestReporter frame sent before it has already been
            // received AND processed. TestReporter.enable is idempotent and already
            // proven responsive (it just succeeded above), making it a safe no-op ping.
            //
            // The wait is now progress-based rather than a fixed deadline: it gives up
            // only after DRAIN_ACK_SILENCE_TIMEOUT_MS of TRUE inspector silence (no
            // frames of any kind — proof the backlog has stopped draining), with a hard
            // DRAIN_ACK_ABSOLUTE_CEILING_MS backstop regardless of ongoing progress. The
            // inspector.send() call itself carries a per-call timeout set ABOVE the
            // absolute ceiling so the silence/ceiling race always governs, never send()'s
            // own internal timer. Giving up now RESOLVES (never rejects) so the drain
            // handler ALWAYS results in 'drained' being sent once it settles — this
            // releases the child immediately instead of letting it idle out its own
            // (now 40s) backstop in the preload.
            syncServer.setDrainHandler(async () => {
                const drainRequestReceivedAt = Date.now();
                const countsAtRequest = inspector.getEventCounts();
                const gapsAtRequest = inspector.getFoundIdGaps();
                this.logger.warn(
                    'Drain-request received: %d/%d/%d found/start/end events received so far; %d found-id gap(s)%s',
                    countsAtRequest.found, countsAtRequest.start, countsAtRequest.end,
                    gapsAtRequest.length, formatGapIdList(gapsAtRequest)
                );

                const { promise: silencePromise, cancel: cancelSilence } = raceAgainstSilence(
                    inspector, DRAIN_ACK_SILENCE_TIMEOUT_MS, DRAIN_ACK_ABSOLUTE_CEILING_MS,
                    'Inspector drain wait gave up'
                );
                try {
                    // silencePromise is Promise<never> — it only ever rejects, so a
                    // non-throwing race can only mean inspector.send() resolved first.
                    await Promise.race([
                        // Per-call timeout deliberately ABOVE the absolute ceiling so the
                        // silence/ceiling race always governs this wait, never send()'s own
                        // fixed per-request timer (default 5000ms).
                        inspector.send('TestReporter.enable', {}, DRAIN_ACK_ABSOLUTE_CEILING_MS + 1000),
                        silencePromise,
                    ]);
                    drainSettleReason = 'ack';
                } catch (error) {
                    drainSettleReason = error instanceof DrainWaitTimeoutError ? error.reason : 'send-rejected';
                    if(drainSettleReason === 'send-rejected') {
                        this.logger.warn('Inspector drain round-trip rejected before any wait bound was hit: %s',
                            error instanceof Error ? error.message : String(error));
                    }
                    // Swallowed on purpose: resolving makes SyncServer send 'drained' even on
                    // give-up, releasing the child immediately — otherwise the child would
                    // idle out its own (now 40s) backstop on every failed handshake.
                } finally {
                    cancelSilence();
                    const elapsedMs = Date.now() - drainRequestReceivedAt;
                    const countsAtSettle = inspector.getEventCounts();
                    const gapsAtSettle = inspector.getFoundIdGaps();
                    this.logger.warn(
                        'Drain handler settled via %s after %dms; events during wait +%d/+%d/+%d found/start/end; found-id gaps %d -> %d%s',
                        drainSettleReason, elapsedMs,
                        countsAtSettle.found - countsAtRequest.found,
                        countsAtSettle.start - countsAtRequest.start,
                        countsAtSettle.end - countsAtRequest.end,
                        gapsAtRequest.length, gapsAtSettle.length,
                        drainSettleReason === 'ack' && gapsAtSettle.length > 0
                            ? ' — ack resolved but gaps remain: the ack may under-prove drain'
                            : ''
                    );
                }
            });

            // 7. Signal preload script to proceed with tests
            syncServer.signalReady();
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Signaled preload script to proceed');

            // 8. Wait for test process to complete
            const result = await testProcess;
            const totalElapsedMs = Date.now() - startTime;

            // 9. Drain the inspector socket, then get inspector data before closing.
            // expectClose() is called the instant we know the run is over — same tick,
            // before any await — so it always wins the race against the WebSocket's own
            // OS-driven 'close' event (a same-tick synchronous set beats a queued
            // event-listener callback). waitForClose() then gives an already-idle socket
            // a bounded window to actually finish closing before we snapshot, closing the
            // race that let a truncated inspector stream go undetected in production.
            inspector.expectClose();
            await inspector.waitForClose(INSPECTOR_DRAIN_TIMEOUT_MS);
            const testHierarchy = inspector.getTests();
            const executionOrder = inspector.getExecutionOrder();
            const wasClosedUnexpectedly = inspector.wasClosedUnexpectedly;

            await inspector.close();

            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Inspector collected %d tests in hierarchy, %d in execution order',
                testHierarchy.length, executionOrder.length);

            const finalGaps = inspector.getFoundIdGaps();
            this.logger.warn(
                'Post-drain inspector snapshot: %d found-id gap(s) remaining%s; drain handshake %s',
                finalGaps.length, formatGapIdList(finalGaps),
                formatDrainSettleReason(drainSettleReason)
            );

            // Closes the two evidence gaps identified in INSPECTOR-PRODUCER-LOSS.md: (1) the
            // WebSocket close code/reason/wasClean — confirms or kills the suspected Bun
            // idleTimeout:0 ping-cycle bug (ERR_WEBSOCKET_TIMEOUT) on the next incident; (2) raw
            // vs. unique found-id counts — the gap count above is density-only and cannot detect
            // the confirmed Bun TestReporter id-collision bug (two interleaved id sequences),
            // which keeps ids dense while silently merging distinct tests under one shared id.
            const closeInfo = inspector.getCloseInfo();
            const collisionStats = inspector.getFoundIdCollisionStats();
            this.logger.warn(
                'Post-drain inspector close/collision diagnostics: WS close code=%s reason=%s wasClean=%s msFromLastFrameToClose=%s; '
                + 'found events %d raw / %d unique id(s) / %d duplicate id event(s) (nonzero duplicates = direct evidence of the Bun '
                + 'TestReporter id-collision bug; the found-id-gap count above is density-only — it does NOT prove losslessness under collisions)',
                String(closeInfo.code), String(closeInfo.reason), String(closeInfo.wasClean), String(closeInfo.msFromLastFrameToClose),
                collisionStats.rawFoundCount, collisionStats.uniqueFoundIdCount, collisionStats.duplicateFoundIdCount
            );

            // 10–12. Handle timeout and process errors; parse output
            const parsed = parseBunTestOutput(result.stdout, result.stderr);
            const earlyResult = this.checkDryRunProcessResult(result, parsed, testHierarchy);
            if(earlyResult) {
                return earlyResult;
            }

            // 13–16. Collect/remap coverage, build tests, run the completeness gate, and
            // (if it passes) persist the registry — extracted to keep dryRun()'s own
            // complexity under the lint threshold; see buildGatedDryRunResult's doc comment.
            return await this.buildGatedDryRunResult(result, parsed, testHierarchy, executionOrder, totalElapsedMs, wasClosedUnexpectedly, closeInfo);
        } finally {
            // Abort the child process if it is still running.  This is idempotent —
            // if the process already exited normally, the signal fires to a dead process
            // and the close-event has already resolved the promise.
            abortController.abort();
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: clears the in-flight tracking so dispose() doesn't abort a stale/already-finished controller; covered by 'clears currentAbortController after dryRun completes'
            if(this.currentAbortController === abortController) {
                this.currentAbortController = undefined;
            }
            // 10 (always). Close sync server — idempotent, safe even after early-return paths
            await syncServer.close();
        }
    }

    /**
   * Post-child-exit dry-run pipeline: collect/remap coverage, build tests
   * from inspector data, sort them for incremental-mode determinism, run the
   * completeness gate, and — only if the gate passes — persist the test
   * registry. Returns the gate's Error result when it fires, otherwise the
   * Complete result.
   *
   * Extracted from dryRun() purely to keep dryRun()'s own cyclomatic
   * complexity under the lint threshold; this is a pure code move — same call
   * order and same early-return-on-gate-failure semantics as before.
   */
    private async buildGatedDryRunResult(
        result:                { exitCode: number | null, stderr: string },
        parsed:                ParsedTestResults,
        testHierarchy:         TestInfo[],
        executionOrder:        number[],
        totalElapsedMs:        number,
        wasClosedUnexpectedly: boolean,
        closeInfo:              InspectorCloseInfo
    ): Promise<DryRunResult> {
        // 13. Collect and remap coverage data
        const { coverage: mutantCoverage, inspectorIdToProjectFile, rawKeyCount, orphanedKeyCount } = await this.collectAndRemapCoverage(testHierarchy, executionOrder);

        // 14. Build test results from inspector data
        const { tests, testNameIndex } = this.buildTestsFromInspector(testHierarchy, executionOrder, parsed, totalElapsedMs, inspectorIdToProjectFile);

        // Sort tests by name to ensure consistent order across runs
        // This is critical for Stryker's incremental mode - test IDs are assigned
        // based on order, so inconsistent order breaks coveredBy correlation
        tests.sort((a, b) => a.name.localeCompare(b.name));

        // Completeness gate, guarding against a silently truncated inspector event
        // stream — run AFTER tests are built (so it can see whether the run otherwise looks GREEN)
        // but BEFORE persisting the registry below: a gated run must never let other
        // Stryker workers load a corrupted/partial registry via loadRegistryFile().
        const gateResult = this.checkCompletenessGate(executionOrder, testHierarchy, parsed, rawKeyCount, orphanedKeyCount, wasClosedUnexpectedly, tests, closeInfo);
        if(gateResult) {
            return gateResult;
        }

        // Cache test names and persist registry for killedBy resolution in mutantRun
        await this.buildAndPersistTestRegistry(tests, testNameIndex);

        this.warnOnUnidentifiedDryRunFailure(result, parsed, tests);

        return {
            status: DryRunStatus.Complete,
            tests,
            mutantCoverage,
        };
    }

    /**
   * Build the in-memory test name cache and base-name index, then atomically
   * persist them — together with the exact-name testNameIndex from
   * buildTestsFromInspector — to a well-known file so other worker processes
   * can lazy-load them when handling static-coverage mutants (testFilter is
   * empty for those) and build exact --test-name-pattern alternatives.
   *
   * Writing to a .tmp path then renaming is atomic on POSIX: readers always see
   * either the previous complete file or the new one — never a partial write.
   */
    private async buildAndPersistTestRegistry(
        tests: RunnerTestResult[],
        testNameIndex: Map<string, string>
    ): Promise<void> {
        this.cachedTestNames = new Set(tests.map(t => t.name));
        // Stryker disable all: defensive check — buildTestsFromInspector always deduplicates names, so tests.length === cachedTestNames.size in normal operation; this entire block is unreachable defensive code
        if(tests.length !== this.cachedTestNames.size) {
            const nameCount = new Map<string, number>();
            for(const test of tests) {
                nameCount.set(test.name, (nameCount.get(test.name) ?? 0) + 1);
            }
            const duplicates = [...nameCount.entries()]
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
        // Stryker restore all

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
            // Stryker disable ConditionalExpression,EqualityOperator,BlockStatement,ArrayDeclaration: edge-case identity entries for suffixed names — only used when Bun output includes [N] suffixes (doesn't happen in practice); mutations here cause incorrect identity lookups but are not exercised by tests
            if(base !== id) {
                this.baseNameIndex.set(id, [id]);
            }
            // Stryker restore ConditionalExpression,EqualityOperator,BlockStatement,ArrayDeclaration
        }
        // Stryker disable next-line StringLiteral: diagnostic logging message
        this.logger.debug('Cached %d test names from dry run for killedBy resolution', this.cachedTestNames.size);

        // Keep the exact-name index on the instance BEFORE attempting the write
        // (mirrors cachedTestNames) so this worker's own mutantRuns can use it
        // even when the registry file write below fails.
        this.testNameIndex = testNameIndex;

        try {
            const registryPath = this.registryPath;
            const tmpPath = this.registryTmpPath;
            const registryData = JSON.stringify({
                version:         2,
                writtenAt:       Date.now(),
                // Stryker disable next-line ArrayDeclaration: equivalent mutant — prepending "Stryker was here" leaves all real test names in place; killedBy resolution is unaffected
                cachedTestNames: [...this.cachedTestNames],
                baseNameIndex:   [...this.baseNameIndex.entries()],
                testNameIndex:   [...testNameIndex.entries()],
            });
            // registryPath now lives under tmpdir()/stryker-bun-runner/, which may not
            // exist yet on a fresh machine/CI runner — create it before writing.
            // Safe to call unconditionally/concurrently: recursive mkdir is a no-op
            // (not an EEXIST throw) when the directory is already there.
            await fsPromises.mkdir(path.dirname(registryPath), { recursive: true });
            await fsPromises.writeFile(tmpPath, registryData, 'utf8');
            this.lastRegistryTmpPath = tmpPath;
            await fsPromises.rename(tmpPath, registryPath);
            // Clear lastRegistryTmpPath now that the rename succeeded — the .tmp file
            // no longer exists on disk.  dispose() will skip the unlink attempt so it
            // doesn't try to delete a file that was already renamed away.
            this.lastRegistryTmpPath = undefined;
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.debug('Wrote dryRun registry to %s (%d entries)', registryPath, this.cachedTestNames.size);
        } catch (error) {
            // Non-fatal: the worker that did dryRun still has its in-memory copy.
            // Other workers will fall back to raw names and log a warning.
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.warn('Failed to write dryRun registry file: %s', error instanceof Error ? error.message : String(error));
        }
    }

    /**
   * Lossy-visibility warns for a mutant run's --test-name-pattern.
   *
   * Bun exits 0 on a PARTIAL pattern miss (verified live, bun 1.3.14),
   * silently dropping the missed tests — so these warns are the only signal
   * that some covering-test alternatives were built via the lossy
   * ' > '-collapsing reconstruction instead of exact bun names. Must be called
   * AFTER the registry lazy-load so this.testNameIndex reflects reality.
   */
    private warnLossyPatternAlternatives(filterIds: readonly string[], mutantId: string): void {
        // Empty filter → no pattern is built at all, nothing lossy to warn about.
        if(filterIds.length === 0) {
            return;
        }
        const exactNameIndex = this.testNameIndex;
        if(exactNameIndex === undefined) {
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.warn('Mutant %s: no exact-name registry available — all %d covering-test pattern alternatives use lossy reconstruction; tests with " > " in their titles may be silently dropped', mutantId, filterIds.length);
            return;
        }
        const missed = filterIds.filter(id => !exactNameIndex.has(id));
        if(missed.length > 0) {
            // Stryker disable StringLiteral,MethodExpression,ConditionalExpression,EqualityOperator: diagnostic warn — the slice(0, 5) sample cap and the ', …' ellipsis ternary only shape log output; the guarding conditionals around this warn are behaviorally tested
            this.logger.warn(
                'Mutant %s: %d of %d testFilter ids missing from exact-name registry (lossy fallback; " > " titles among them may be silently dropped): %s%s',
                mutantId,
                missed.length,
                filterIds.length,
                missed.slice(0, 5).join(', '),
                missed.length > 5 ? ', …' : ''
            );
            // Stryker restore StringLiteral,MethodExpression,ConditionalExpression,EqualityOperator
        }
    }

    /**
   * Run tests with an active mutant
   */
    public async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Running mutant run for mutant %s', options.activeMutant.id);

        // Stryker disable next-line ArrayDeclaration: equivalent mutant — options.testFilter is always a non-null array in all tests; ?? fallback never fires, so ['Stryker was here'] = [] in practice
        const filterIds = options.testFilter ?? [];

        // Lazy-load the shared dryRun registry when this worker's instance registry is
        // not yet populated (i.e. this worker never ran dryRun).  We load it
        // regardless of whether testFilter is empty, because Bun's --test-name-pattern
        // is a hierarchy regex that can leak: tests NOT in testFilter may still run and
        // kill the mutant first.  Their names won't be in localRegistry, so we need the
        // instance registry as a fallback to avoid storing raw console names in killedBy.
        // IMPORTANT: this must run BEFORE buildTestNamePattern below — the load also
        // populates this.testNameIndex, whose exact bun names the pattern builder
        // needs for titles that legitimately contain ' > '.
        if(!this.cachedTestNames) {
            await this.loadRegistryFile();
        }

        // Lossy-visibility warns — see warnLossyPatternAlternatives.
        this.warnLossyPatternAlternatives(filterIds, options.activeMutant.id);

        // Translate testFilter into --test-name-pattern to run only the covering tests.
        // Each test ID is the full "file.test.ts > Suite > test name" string from dryRun.
        // When the exact-name registry has an entry for an id, Bun's exact matching
        // name is used verbatim; otherwise we strip the file-path prefix (Bun's
        // pattern matches the hierarchy without it) and collapse duplicate-name tests
        // (those with a " [N]" dedup suffix) to a single alternative — Bun cannot
        // distinguish them at runtime, but running both is correct.
        // --bail is applied unless Stryker's disableBail option is set — without bail
        // every covering test runs to completion, so killedBy can list all killing tests.
        // When the covering set is too large to encode safely in a single argv entry
        // (kernel argv limits are in UTF-8 bytes), buildTestNamePattern returns undefined
        // and the full suite runs instead (see MAX_TEST_NAME_PATTERN_LENGTH).
        // Sequential mode (--concurrency=1) is required to match dryRun's serialized
        // execution semantics — parallel timing can cause mutants to escape detection.
        // IMPORTANT: Preload script IS needed to set globalThis.__stryker__.activeMutant
        // The preload script skips coverage collection when __STRYKER_ACTIVE_MUTANT__ is set
        const testNamePattern = buildTestNamePattern(filterIds, this.testNameIndex);

        // Build a LOCAL index from options.testFilter so that every worker — not just
        // the one that ran dryRun — can resolve rawFailedNames into killedBy IDs.
        const { localRegistry, localBaseIndex } = this.buildLocalTestFilterIndex(filterIds);

        // Use cached bunfig path synchronously when available (pre-warmed by init()).
        const mutantCwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: inline cache hit — same pattern as ensureSanitizedBunfig, covered by 'reuses cached bunfig in mutantRun when cwd unchanged'
        const bunfigPath = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === mutantCwd)
            ? this.sanitizedBunfigPath
            : await this.ensureSanitizedBunfig();

        // Reuse the sorted test-file list cached during dryRun.
        // If this worker never ran dryRun (cachedTestFiles is undefined), discover
        // the files now and cache them for subsequent mutantRun calls on this worker.
        // When testFilesOverride is set, use it directly without globbing.
        this.cachedTestFiles = await this.getOrDiscoverTestFiles();

        return this.executeMutantRun(options, bunfigPath, testNamePattern, localRegistry, localBaseIndex);
    }

    /**
   * Spawn bun for a mutant run and interpret the result. Extracted from
   * mutantRun so that a --test-name-pattern which matched 0 tests can retry
   * once with the full suite (testNamePattern undefined) while reusing the
   * SAME localRegistry/localBaseIndex built from the original testFilter for
   * killedBy resolution — avoiding both a false Killed and redundant setup.
   * The retry always recurses with testNamePattern undefined, so the retry
   * gate's first conjunct is false on that call: recursion is bounded to
   * depth 1 by construction, never a retry-of-a-retry.
   */
    private async executeMutantRun(
        options:         MutantRunOptions,
        bunfigPath:      string,
        testNamePattern: string | undefined,
        localRegistry:   Set<string>,
        localBaseIndex:  Map<string, string[]>
    ): Promise<MutantRunResult> {
        // Tracked on `this` so dispose() can kill an orphaned child if this runner
        // is disposed while a mutant run is still in flight — mirrors dryRun().
        const abortController = new AbortController();
        this.currentAbortController = abortController;
        let result;
        try {
            result = await runBunTests({
                bunPath:               this.bunPath,
                timeout:               this.timeout,
                env:                   this.env,
                bunArgs:               this.bunArgs,
                bunfigPath,
                activeMutant:          options.activeMutant.id,
                bail:                  !options.disableBail, // Bail on first failure unless Stryker's disableBail is set
                sequentialMode:        true,            // Match dryRun's serialized execution for deterministic results
                preloadScript:         this.preloadScriptPath, // Needed to set globalThis.__stryker__.activeMutant
                testNamePattern, // undefined → no filter → full suite (current behaviour)
                testFiles:             this.cachedTestFiles,
                signal:                abortController.signal,
                smol:                  this.smol,
                maxChildRss:           this.maxChildRss,
                rssCheckIntervalMs:    this.rssCheckIntervalMs,
                maxSpawnDepth:         this.maxSpawnDepth,
                onMemoryLimitExceeded: (rssBytes: number) => {
                    this.logger.warn(
                        'bun test child exceeded maxChildRss (%d bytes observed) during mutant run %s — killing and reporting as a timeout for this mutant',
                        rssBytes,
                        options.activeMutant.id
                    );
                },
            });
        } finally {
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: clears the in-flight tracking so dispose() doesn't abort a stale/already-finished controller; covered by 'clears currentAbortController after mutantRun completes'
            if(this.currentAbortController === abortController) {
                this.currentAbortController = undefined;
            }
        }

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
        if(result.exitCode !== 0) {
            // A pattern that matched zero tests across the WHOLE run (bun's zero-match
            // error is total, never partial — verified live, bun 1.3.14) is a runner
            // pattern gap or a mutant that changed an interpolated test title, not a
            // genuine kill: retry once with the full suite before giving up.
            // eslint-disable-next-line @typescript-eslint/prefer-includes -- kept as a RegExp (not includes()) to match the module-level ZERO_MATCH_TEST_PATTERN_RE declaration shared with checkRuntimeError; behaviorally identical for this literal pattern
            if(testNamePattern !== undefined && parsed.tests.length === 0 && ZERO_MATCH_TEST_PATTERN_RE.test(result.stderr)) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.warn(
                    'Mutant %s: --test-name-pattern matched 0 tests — usually a runner pattern gap or a mutant that changed an interpolated test title (it.each); retrying once with the full suite',
                    options.activeMutant.id
                );
                return this.executeMutantRun(options, bunfigPath, undefined, localRegistry, localBaseIndex);
            }
            return this.buildMutantKilledResult(result, parsed, localRegistry, localBaseIndex, options.activeMutant.id);
        }

        // Exit code 0 means all tests passed, mutant survived
        return {
            status:    MutantRunStatus.Survived,
            nrOfTests: parsed.totalTests,
        };
    }

    /**
   * Build the MutantRunResult for a killed mutant (non-zero exit code).
   * Handles runtime error detection and killedBy resolution.
   */
    private buildMutantKilledResult(
        result:         { exitCode: number | null, stdout: string, stderr: string },
        parsed:         { tests: { status: string, name: string, failureMessage?: string }[], totalTests: number },
        localRegistry:  Set<string>,
        localBaseIndex: Map<string, string[]>,
        mutantId:       string
    ): MutantRunResult {
        const rawFailedNames = parsed.tests
            .filter(test => test.status === 'failed')
            .map(test => normalizeTestName(test.name));

        // Check for runtime errors: tests couldn't run due to module/syntax errors
        // These should be RuntimeError, not Killed, and don't need killedBy for caching
        // Stryker disable next-line BlockStatement,LogicalOperator: BlockStatement: runtime error detection covered by 'returns RuntimeError when stderr signals a syntax error'; LogicalOperator: equivalent mutant — rawFailedNames is always derived from parsed.tests (subset), so both are 0 simultaneously; && and || produce identical results for all reachable inputs
        if(rawFailedNames.length === 0 && parsed.tests.length === 0) {
            const runtimeResult = this.checkRuntimeError(result, mutantId);
            // Stryker disable next-line BlockStatement: covered by 'returns runtimeResult when checkRuntimeError returns non-null'
            if(runtimeResult) {
                return runtimeResult;
            }
        }

        const killedBy = this.resolveKilledBy(rawFailedNames, localRegistry, localBaseIndex, mutantId);

        // Genuinely unattributable kill (unparseable Bun output, or every failed
        // name dropped as unresolvable by resolveKilledBy): emit an EMPTY killedBy.
        // Never 'unknown' or a raw name — any value outside the dry-run id space
        // is written verbatim into the incremental report, orphans against the
        // test registry, and permanently prevents reuse of this mutant's verdict.
        // killedBy: [] is type-legal and safe: core remaps [] → [], and the differ
        // simply re-runs this one mutant on incremental passes — same cost as the
        // old fallback, but WARN-visible and without poisoning the report.
        if(killedBy.length === 0) {
            // Stryker disable StringLiteral: diagnostic logging message format strings — not behaviorally tested
            this.logger.warn(
                'Mutant %s: no killing test identifiable — emitting empty killedBy; '
                + 'this mutant will re-run on every incremental run\n'
                + 'exit=%s\n--- STDOUT (first 600 chars) ---\n%s\n'
                + '--- STDERR (first 600 chars) ---\n%s',
                mutantId,
                String(result.exitCode),
                // Stryker restore StringLiteral
                // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — slice(0,600) and '(empty)' are diagnostic only
                result.stdout.slice(0, 600) || '(empty)',
                // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutant — slice(0,600) and '(empty)' are diagnostic only
                result.stderr.slice(0, 600) || '(empty)'
            );
        }

        return {
            status:         MutantRunStatus.Killed,
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

    /**
   * Check if the process failed due to a runtime error (no tests ran).
   * Returns a MutantRunResult if this is a runtime error, or null to continue.
   */
    private checkRuntimeError(
        result:   { exitCode: number | null, stderr: string },
        mutantId: string
    ): MutantRunResult | null {
        const stderr = result.stderr;

        // A zero-match --test-name-pattern that reaches here either exhausted
        // mutantRun's one-shot full-suite retry, or never had a Stryker-built
        // pattern to retry (empty testFilter, user-supplied -t via bunArgs).
        // Classify distinctly from the generic runtime-error messages below so
        // operators can tell a runner pattern gap apart from a real crash.
        // eslint-disable-next-line @typescript-eslint/prefer-includes -- kept as a RegExp (not includes()) to match the module-level ZERO_MATCH_TEST_PATTERN_RE declaration shared with executeMutantRun's retry gate; behaviorally identical for this literal pattern
        if(ZERO_MATCH_TEST_PATTERN_RE.test(stderr)) {
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.warn(
                'Mutant %s: --test-name-pattern matched 0 tests with no covering tests left to retry — not a kill: %s',
                mutantId,
                stderr.slice(0, 200)
            );
            return {
                status:       MutantRunStatus.Error,
                // Stryker disable next-line StringLiteral: diagnostic error message text — behaviorally tested via .toContain, not exact-matched
                errorMessage: `stryker-bun-runner: bun's --test-name-pattern matched 0 tests for this mutant (runner pattern gap or mutant-changed interpolated title — not a kill): ${stderr.slice(0, 500)}`,
            };
        }

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
                mutantId,
                stderr.slice(0, 200)
            );
            return {
                status:       MutantRunStatus.Error,
                errorMessage: stderr.slice(0, 500) || `Runtime error with exit code ${result.exitCode}`,
            };
        }
        return null;
    }

    /**
   * Check for dry run process failures (timeout or non-zero exit).
   * Returns a DryRunResult to short-circuit if the process failed, or null to proceed.
   */
    private checkDryRunProcessResult(
        result:        { timedOut: boolean, exitCode: number | null, stderr: string },
        parsed:        { failed: number },
        testHierarchy: TestInfo[]
    ): DryRunResult | null {
        if(result.timedOut) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.warn('Dry run timed out');
            return { status: DryRunStatus.Timeout };
        }
        // Non-zero exit with 0 parsed failures means the process itself failed
        // (e.g. misconfiguration, missing module) rather than a test failure —
        // surface as a process-level Error so Stryker can report it clearly.
        // Non-zero exit WITH parsed failures means real tests failed; fall through
        // so the caller can build a Complete result with the failed test details.
        if(result.exitCode !== 0 && parsed.failed === 0) {
            // Structured data first: it's built from inspector data that survives even
            // when bun's own stdout/stderr recap is truncated or missing (the incident
            // this addresses), so it goes ahead of the raw stderr that may be useless.
            const failureDetails = this.formatInspectorFailureDetails(testHierarchy);
            const messageParts = [`Bun test process failed with exit code ${result.exitCode}`];
            if(failureDetails) {
                messageParts.push(failureDetails);
            }
            messageParts.push(result.stderr);
            return {
                status:       DryRunStatus.Error,
                errorMessage: messageParts.join('\n'),
            };
        }
        return null;
    }

    /**
   * Build a structured summary of failed tests observed via the inspector, for
   * inclusion in checkDryRunProcessResult's error message. Bun's own stdout/stderr
   * recap can be truncated or entirely empty on process failure, so this pulls
   * failure detail straight from the inspector's TestReporter data instead —
   * the same data buildTestsFromInspector would otherwise turn into per-test
   * results, had the process not short-circuited into the error branch first.
   *
   * Returns '' when there are no failed tests in the hierarchy so callers can
   * keep the plain exit-code+stderr message unchanged in that case. Only
   * type === 'test' entries are considered — describe blocks can also carry
   * status 'fail' (propagated from a failing child) and must not masquerade
   * as failed tests here.
   */
    private formatInspectorFailureDetails(testHierarchy: TestInfo[]): string {
        const failedTests = testHierarchy.filter(t => t.type === 'test' && t.status === 'fail');
        if(failedTests.length === 0) {
            return '';
        }

        const listed = failedTests.slice(0, MAX_DRY_RUN_FAILURE_TESTS_LISTED);
        const lines = listed.map((t) => {
            // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: fallback message text has no behavioral impact
            const message = t.error?.message ?? 'no error message captured';
            let line = `  - ${t.fullName}: ${message}`;
            if(t.error?.stack) {
                const indentedStack = t.error.stack.split('\n').map(stackLine => `    ${stackLine}`).join('\n');
                line += `\n${indentedStack}`;
            }
            return line;
        });

        const remaining = failedTests.length - listed.length;
        if(remaining > 0) {
            lines.push(`  ...and ${remaining} more`);
        }

        // Stryker disable next-line StringLiteral: diagnostic header text has no behavioral impact
        return `${failedTests.length} test(s) reported failed via Bun's inspector (stdout/stderr recap may be truncated or missing):\n${lines.join('\n')}`;
    }

    /**
   * Diagnostic-only check for the Complete dry-run path: bun reported a failure
   * (non-zero exit, or a failed count in its console recap) but nothing in the
   * built test results identifies which test failed. This is the observed
   * incident fingerprint — bun prints e.g. "1 tests failed:" with an empty
   * recap, the inspector shows no TestStatus.Failed entry, and nothing points
   * at a culprit. An unhandled error firing between tests (e.g. a rejected
   * fire-and-forget promise) rather than inside any single test body is a
   * likely cause. Logs a warning only; this check itself never alters test
   * statuses, ids, coverage, or the returned DryRunResult — contrast with
   * buildFailureMessage above, which (elsewhere in this same dry-run path)
   * DOES intentionally change a failed test's failureMessage content.
   */
    private warnOnUnidentifiedDryRunFailure(
        result: { exitCode: number | null, stderr: string },
        parsed: { failed: number },
        tests:  readonly RunnerTestResult[]
    ): void {
        if((result.exitCode !== 0 || parsed.failed > 0) && !tests.some(t => t.status === TestStatus.Failed)) {
            // Stryker disable next-line StringLiteral: diagnostic logging message only
            this.logger.warn(
                'Bun exited with code %s and its console output reported %d failed test(s), '
                + 'but no failing test could be identified from inspector or console data. '
                + 'An unhandled error firing between tests (e.g. a rejected fire-and-forget '
                + 'promise) is a likely cause. Last 500 chars of stderr:\n%s',
                String(result.exitCode),
                parsed.failed,
                result.stderr.slice(-500)
            );
        }
    }

    /**
   * Dry-run data-completeness gate.
   *
   * Guards against the inspector event stream silently truncating mid-run
   * (observed under CI runner contention): bun's own child-side coverage file
   * can be complete while the inspector-derived `executionOrder` is cut off at
   * a file boundary, and everything downstream of that (test results, coverage
   * attribution) accepted the truncated data silently — a plausible-looking
   * but corrupted score, not a loud failure.
   *
   * ONLY evaluated when the run otherwise looks GREEN (zero Failed entries in
   * the already-built `tests`): an already-failing dry run is handled by
   * {@link checkDryRunProcessResult} / {@link warnOnUnidentifiedDryRunFailure},
   * and this precondition structurally prevents a failing beforeAll (which
   * marks the rest of its describe/file Failed) from ever reaching Signal A —
   * the incident's own signature was a run that looked completely healthy.
   *
   * Fires (returns a DryRunStatus.Error result) iff EITHER signal is material:
   *
   * - Signal A (execution/console shortfall): `consoleTotal` (bun's SUMMARY
   *   pass+fail counts — deliberately NOT the parser's max(per-line, summary)
   *   fields, so per-ATTEMPT retry output can never inflate it — see
   *   ParsedTestResults.summaryPassed/summaryFailed) compared against the
   *   count of ids in `executionOrder` whose status is neither 'skip' nor
   *   bun's not-yet-implemented placeholder-test status. Retries do not
   *   create a shortfall in this direction: empirically (bun 1.3.14), a
   *   retried test fires ONE TestReporter.start per ATTEMPT for the SAME
   *   inspector id — so executionOrder, if anything, grows on retries, and
   *   bun's summary line counts tests, not attempts, either way. A material
   *   shortfall must clear both an absolute floor and a ratio floor.
   *
   * - Signal B (orphaned coverage keys): `orphanedKeyCount` (a whole file's
   *   coverage keys unpaired with any inspector test — see coverage-mapper.ts)
   *   exceeding a small absolute floor. Deliberately gate-blind for the legacy
   *   ("test-N") coverage format, which never populates this count — Signal A
   *   still covers that path since it does not depend on coverage format.
   *
   * `wasClosedUnexpectedly` is NEVER a standalone trigger — the WS-vs-child-exit
   * close race can plausibly be true on a nontrivial fraction of healthy runs —
   * it is folded into the Error message only as corroborating context once the
   * gate has already fired via Signal A or B.
   *
   * @returns A DryRunStatus.Error result if the gate fires, otherwise null.
   */
    private checkCompletenessGate(
        executionOrder:        number[],
        testHierarchy:         TestInfo[],
        parsed:                Pick<ParsedTestResults, 'summaryPassed' | 'summaryFailed'>,
        rawKeyCount:            number,
        orphanedKeyCount:       number,
        wasClosedUnexpectedly:  boolean,
        tests:                  readonly RunnerTestResult[],
        closeInfo:              InspectorCloseInfo
    ): DryRunResult | null {
        // Stryker disable next-line MethodExpression,EqualityOperator: equivalent — .some() vs .find()!==undefined would produce the same boolean; the guard itself (skip the gate when any built test already Failed) is covered by 'gate does not evaluate when built tests contain failures'
        if(tests.some(t => t.status === TestStatus.Failed)) {
            return null;
        }

        const testMap = new Map(testHierarchy.map(t => [t.id, t]));
        const nonSkippedExecutionCount = executionOrder.filter((id) => {
            const status = testMap.get(id)?.status;
            // Stryker disable next-line EqualityOperator: both conditions needed — 'skip' and the placeholder-test status both mean "never fired beforeEach"; mirrors coverage-mapper.ts's own nonSkipped filter so the two can't drift
            return status !== 'skip' && status !== 'todo';
        }).length;

        const consoleTotal = parsed.summaryPassed + parsed.summaryFailed;
        const shortfall = consoleTotal - nonSkippedExecutionCount;
        // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,ArithmeticOperator: threshold predicate — behaviorally tested via the dedicated gate-fires/gate-does-not-fire tests below; consoleTotal>0 guard prevents a division-by-zero-shaped false fire on an empty/zeroed-out console recap
        const signalA = consoleTotal > 0
          && shortfall > EXECUTION_SHORTFALL_ABS_FLOOR
          && shortfall / consoleTotal > EXECUTION_SHORTFALL_RATIO_THRESHOLD;

        // Stryker disable next-line EqualityOperator: threshold predicate — behaviorally tested via the dedicated gate-fires/gate-does-not-fire tests below
        const signalB = orphanedKeyCount > ORPHANED_KEY_ABS_FLOOR;

        // Stryker disable next-line LogicalOperator: equivalent mutants only affect the fast-path skip below; the message-building code that follows is unreachable (and untested as unreachable) when neither signal is material, so && vs || here is caught by the same gate-fires/gate-does-not-fire tests
        if(!signalA && !signalB) {
            return null;
        }

        const reasons: string[] = [];
        if(signalA) {
            reasons.push(
                `console reported ${consoleTotal} test(s) (pass+fail) but the inspector's execution order `
                + `contains only ${nonSkippedExecutionCount} non-skipped test(s) (shortfall ${shortfall})`
            );
        }
        if(signalB) {
            reasons.push(`${orphanedKeyCount} of ${rawKeyCount} coverage key(s) could not be paired with any inspector test (orphaned)`);
        }
        if(wasClosedUnexpectedly) {
            // closeInfo.code is undefined whenever the close event itself never carried a code
            // (e.g. the mock/test path, or a WebSocket implementation that omits it) — distinct
            // from a genuinely captured code (including 0), so this checks presence, not truthiness.
            const closeDetail = closeInfo.code === undefined
                ? 'close code/reason not captured'
                : `close code=${closeInfo.code} reason=${JSON.stringify(closeInfo.reason ?? '')} wasClean=${String(closeInfo.wasClean)}, ${String(closeInfo.msFromLastFrameToClose)}ms after the last received frame`;
            reasons.push(`the inspector WebSocket closed unexpectedly before this data could be fully drained (${closeDetail})`);
        }

        const errorMessage
            = 'stryker-bun-runner: dry run data-completeness check failed — '
              + `${reasons.join('; ')}. This indicates the Bun inspector event stream may have been `
              + 'truncated mid-run; proceeding would risk silently '
              + 'corrupted coverage attribution, so this dry run is being reported as an error instead of '
              + 'Complete, and the test registry has NOT been persisted.';

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.error('%s', errorMessage);

        return {
            status: DryRunStatus.Error,
            errorMessage,
        };
    }

    /**
   * Collect coverage from the coverage file and remap counter-based IDs to
   * full test names using the inspector's execution order.
   *
   * Also collects any cross-test async coverage-bleed observations recorded
   * by the preload (see {@link emitCoverageBleedWarnings}) and warns about
   * them. This method's sole call site is dryRun, so bleed detection is
   * dry-run-only by construction — mutant runs never reach this code.
   */
    private async collectAndRemapCoverage(
        testHierarchy:  TestInfo[],
        executionOrder: number[]
    ): Promise<{
        coverage:                 MutantCoverage | undefined
        inspectorIdToProjectFile: Map<number, string>
        rawKeyCount:              number
        orphanedKeyCount:         number
    }> {
        const testMap = new Map(testHierarchy.map(t => [t.id, t]));

        // A wholly-absent coverage file (no path configured, or the child crashed before
        // its afterAll write) is a distinct, already-tolerated degraded mode — Stryker
        // degrades gracefully to running the full suite per mutant when mutantCoverage is
        // undefined — and must NOT itself be gate-material, so both counts default to 0.
        if(!this.coverageFilePath) {
            return { coverage: undefined, inspectorIdToProjectFile: new Map(), rawKeyCount: 0, orphanedKeyCount: 0 };
        }
        // Read coverage and lateHits together, before cleanup deletes the file.
        // Two reads of the same (small, dry-run-only) file — see collectLateHits'
        // doc comment for why this doesn't share a read with collectCoverage.
        const [rawCoverage, lateHits] = await Promise.all([
            collectCoverage(this.coverageFilePath, this.logger),
            collectLateHits(this.coverageFilePath, this.logger),
        ]);
        await cleanupCoverageFile(this.coverageFilePath);
        if(!rawCoverage) {
            return { coverage: undefined, inspectorIdToProjectFile: new Map(), rawKeyCount: 0, orphanedKeyCount: 0 };
        }

        // Map coverage counter keys to full test names and extract the inspector-ID → project-file
        // mapping in a single pass. The new file-prefixed format ("relativeFile@@test-N") produces
        // a populated inspectorIdToProjectFile; legacy keys ("test-N") and unknown formats return
        // an empty map so the runner falls back to testInfo.url-based naming.
        const { coverage, inspectorIdToProjectFile, counterKeyToTestName, rawKeyCount, orphanedKeyCount } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testMap, this.logger);

        if(lateHits.length > 0) {
            this.emitCoverageBleedWarnings(lateHits, counterKeyToTestName);
        }

        return { coverage, inspectorIdToProjectFile, rawKeyCount, orphanedKeyCount };
    }

    /**
   * Warn about cross-test async coverage bleed: mutant coverage that was
   * recorded in the gap between one test's afterEach and the next test's
   * beforeEach, most likely because a fire-and-forget promise chain from the
   * ended test kept running past the test boundary.
   *
   * Diagnostic only: never alters dryRun/mutantRun results or coverage
   * attribution (stabilizeCoverage's "static wins" rule already governs
   * attribution independently of this warning).
   *
   * A known benign trigger this deliberately does NOT try to suppress: a
   * same-file describe-level beforeAll running in the gap looks identical to
   * genuine bleed from this vantage point (both execute while
   * currentTestId is undefined, between two tests). Filtering it out would
   * require tracking beforeAll boundaries explicitly, which is out of scope
   * here — the warning text calls the false-positive out instead.
   *
   * Capped at {@link MAX_COVERAGE_BLEED_WARNINGS} individual warnings, plus a
   * final summary line for the rest, so a suite with many leaking tests
   * doesn't flood the log.
   */
    private emitCoverageBleedWarnings(lateHits: LateHitEntry[], counterKeyToTestName: Map<string, string>): void {
        const listed = lateHits.slice(0, MAX_COVERAGE_BLEED_WARNINGS);
        for(const { testId, mutantIds } of listed) {
            const testName = counterKeyToTestName.get(testId) ?? testId;
            // Stryker disable next-line StringLiteral: diagnostic warning text has no behavioral impact
            this.logger.warn(
                'mutant coverage was recorded between tests, after \'%s\' completed — likely fire-and-forget async work '
                + 'leaking past the test boundary (or beforeAll/fixture code running between tests); attribution for %d '
                + 'mutant(s) may be wrong (mutant IDs: %s)',
                testName,
                mutantIds.length,
                mutantIds.join(', ')
            );
        }

        const remaining = lateHits.length - listed.length;
        if(remaining > 0) {
            // Stryker disable next-line StringLiteral: diagnostic warning text has no behavioral impact
            this.logger.warn('...and %d more coverage-bleed warning(s) suppressed', remaining);
        }
    }

    /**
   * Build local index structures from testFilter for killedBy resolution.
   *
   * testFilter carries the full registry IDs Stryker wants us to run, including
   * any " [N]" dedup suffixes. Building the index here means all workers behave
   * identically on the first shot, eliminating incremental drift caused by workers
   * that never ran dryRun falling through to raw names.
   */
    private buildLocalTestFilterIndex(testFilter: string[]): {
        localRegistry:  Set<string>
        localBaseIndex: Map<string, string[]>
    } {
        const localRegistry = new Set<string>(testFilter);
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
        return { localRegistry, localBaseIndex };
    }

    /**
   * Resolve raw failed test names from console output against the test registry.
   *
   * Console-parser output lacks the [N] dedup suffix that dryRun appends when
   * multiple tests share the same base name (e.g. it.each with %s).
   *
   * Fallback chain — stops at the FIRST successful resolution for each name:
   *   1. Exact match in localRegistry (built from testFilter)
   *   2. Base-name match in localBaseIndex (built from testFilter)
   *   3. Exact match in this.cachedTestNames (instance registry from dryRun)
   *   4. Base-name match in this.baseNameIndex (instance registry from dryRun)
   *
   * Names resolving through none of these are DROPPED with a single WARN — never
   * emitted raw. Every entry in a Killed result's killedBy must be exactly a
   * dry-run TestResult.id: Stryker core's remapTestId (`id => testIdMap.get(id)
   * ?? id`) writes anything else verbatim into the incremental report, where it
   * orphans against the test registry and the differ silently re-runs the mutant
   * on every incremental pass, forever (and the next accumulation pass launders
   * the orphan into an empty killedBy). Dropping instead degrades that one
   * mutant to correct-but-non-reusable — same re-run cost, but loudly visible
   * and never poisonous. No guessed recovery is attempted: bare console names
   * can collide across files, and --test-name-pattern leakage (see mutantRun)
   * means the killer may not even be a testFilter member, so any inference
   * risks crediting the wrong test and enabling stale cache reuse.
   */
    private resolveKilledBy(
        rawFailedNames:  string[],
        localRegistry:   Set<string>,
        localBaseIndex:  Map<string, string[]>,
        mutantId:        string
    ): string[] {
        const killedBySet = new Set<string>();
        const unresolved = new Set<string>();
        for(const name of rawFailedNames) {
            if(localRegistry.has(name)) {
                killedBySet.add(name);
                continue;
            }

            const localBucket = localBaseIndex.get(name);
            if(localBucket) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.debug(
                    'Expanded killedBy base name "%s" → %d local registry IDs for mutant %s',
                    name, localBucket.length, mutantId
                );
                for(const id of localBucket) {
                    killedBySet.add(id);
                }
                continue;
            }

            if(this.cachedTestNames?.has(name)) {
                killedBySet.add(name);
                continue;
            }

            const instanceBucket = this.baseNameIndex?.get(name);
            if(instanceBucket) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.logger.debug(
                    'Expanded killedBy base name "%s" → %d instance registry IDs for mutant %s',
                    name, instanceBucket.length, mutantId
                );
                for(const id of instanceBucket) {
                    killedBySet.add(id);
                }
                continue;
            }

            // Nothing matched — the name is outside the dry-run id space and is
            // dropped (see the contract note in this method's doc comment).
            unresolved.add(name);
        }

        this.warnUnresolvedKilledBy(unresolved, mutantId);
        return [...killedBySet];
    }

    /**
   * WARN about failed test names that could not be resolved to dry-run test
   * ids (and are therefore dropped from killedBy by resolveKilledBy). WARN,
   * not debug — the old debug-level log is why the resulting cache poisoning
   * was invisible in CI. No-op when everything resolved.
   */
    private warnUnresolvedKilledBy(unresolved: ReadonlySet<string>, mutantId: string): void {
        if(unresolved.size === 0) {
            return;
        }
        const sample = [...unresolved];
        // Stryker disable StringLiteral,MethodExpression,ConditionalExpression,EqualityOperator: diagnostic warn — the slice(0, 5) sample cap and the ', …' ellipsis ternary only shape log output; the drop itself is behaviorally tested
        this.logger.warn(
            'Mutant %s: %d failed test name(s) could not be resolved to dry-run test ids and will not be recorded in killedBy — this mutant\'s Killed verdict will not be reusable from the incremental cache: %s%s',
            mutantId,
            unresolved.size,
            sample.slice(0, 5).join(', '),
            sample.length > 5 ? ', …' : ''
        );
        // Stryker restore StringLiteral,MethodExpression,ConditionalExpression,EqualityOperator
    }

    /**
   * Cleanup resources
   */
    public async dispose(): Promise<void> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Disposing BunTestRunner');

        // If a dryRun/mutantRun child is still in flight when Stryker disposes
        // this runner (e.g. a hung worker being torn down), kill it rather than
        // leaving it orphaned. runBunTests' SIGTERM→SIGKILL escalation applies
        // the same as any other abort path.
        if(this.currentAbortController) {
            // Stryker disable next-line StringLiteral: logging message only
            this.logger.debug('Aborting in-flight bun test child during dispose');
            this.currentAbortController.abort();
            this.currentAbortController = undefined;
        }

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
