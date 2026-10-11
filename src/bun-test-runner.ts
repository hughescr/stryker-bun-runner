/**
 * Main TestRunner implementation for Bun
 * Implements the Stryker TestRunner API
 */

import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CoverageAnalysis, MutantCoverage, StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import {
    DryRunStatus,
    MutantRunStatus,
    TestStatus,
    determineHitLimitReached,
    toMutantRunResult,
    type TestRunner,
    type DryRunOptions,
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
import { HIT_LIMIT_SENTINEL } from './coverage/preload-logic.js';
import { findDryRunDataLoss, type CoverageKeyCounts, type DryRunCompletenessFacts } from './dry-run-completeness.js';
import { InspectorClient, type InspectorCloseInfo } from './inspector/index.js';
import type { TestInfo } from './inspector/types.js';
import type { StrykerBunOptions } from './options.js';
import { parseBunTestOutput, type ParsedTestResults } from './parsers/console-parser.js';
import { runBunTests, stripAnsi, type BunProcessResult } from './process-runner.js';
import { type DroppedBunfigKey, assertSupportedBunArgs, splitBunConfigArg, stripRandomizeArgs, checkBunVersion, SyncServer, generateSanitizedBunfig, cleanupSanitizedBunfig, mutantRunBunfigPath, normalizeTestFilePath, normalizeTestName, buildUniqueTestName, buildProjectFileTestName, buildTestNamePattern, TEST_FILE_SUFFIX_RE, discoverTestFiles, findBuildOutputTestFiles, buildTestFileArgs, MAX_TEST_FILE_ARGS_BYTES, buildDiscoveryOrderIndex, sortDuplicateGroupByLineThenDiscovery, resolveRunTempDir, writePrivateFile, MutantWarnAggregator } from './utils/index.js';

/**
 * Event-driven wait for the inspector URL bun prints on startup.
 *
 * `onReady` is handed to process-runner's `onInspectorReady`, which calls it
 * when bun's inspector banner is seen. `wait(child, timeoutMs)` then resolves,
 * with no polling, at the first of:
 *  - the URL arriving (`onReady` fires),
 *  - `child` settling (resolved or rejected), or
 *  - `timeoutMs` elapsing.
 * It resolves with the URL, or `null` when none arrived by then. A URL that
 * arrives after `wait` has resolved is never reported: the deadline decides.
 *
 * Child settling is the short-circuit that matters when bun cannot start at
 * all (`spawnError`, e.g. ENOENT) or exits before printing its inspector
 * banner: the URL callback fires from stdout/stderr data, which always
 * precedes the process-close that resolves `child`, so once `child` has
 * settled a URL that was printed has already been delivered and nothing can
 * set one later. Waiting out the rest of `timeoutMs` would only delay the
 * error report.
 *
 * The timeout timer is cleared as soon as the wait resolves, so nothing is
 * left armed.
 */
function createInspectorUrlWaiter(): { onReady: (url: string) => void, wait: (child: Promise<unknown>, timeoutMs: number) => Promise<string | null> } {
    let url: string | null = null;
    let wake: (() => void) | undefined;
    return {
        onReady: (readyUrl: string): void => {
            url = readyUrl;
            wake?.();
        },
        wait: async (child: Promise<unknown>, timeoutMs: number): Promise<string | null> => {
            // The URL can be delivered before `wait` is called.
            if(url) {
                return url;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve) => {
                const finish = (): void => {
                    resolve();
                };
                timer = setTimeout(finish, timeoutMs);
                wake = finish;
                child.then(finish).catch(finish);
            });
            clearTimeout(timer);
            return url;
        },
    };
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
 * interval keeps the event loop alive indefinitely. The interval is cleared
 * ONLY there, not on rejection: the caller awaits the race and reaches
 * `cancel()` in the same microtask chain as the rejection, before the next
 * poll tick can fire, so a second clearing site could never be observed.
 */
function raceAgainstSilence(
    inspector: InspectorClient,
    silenceMs: number,
    absoluteCeilingMs: number
): { promise: Promise<never>, cancel: () => void } {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setInterval>;
    const promise = new Promise<never>((_resolve, reject) => {
        timer = setInterval(() => {
            const sinceLastFrame = inspector.getMsSinceLastFrame();
            const totalElapsed = Date.now() - startedAt;
            if(totalElapsed >= absoluteCeilingMs) {
                reject(new DrainWaitTimeoutError(`${absoluteCeilingMs}ms absolute ceiling reached`, 'ceiling'));
            } else if(totalElapsed >= silenceMs && sinceLastFrame >= silenceMs) {
                reject(new DrainWaitTimeoutError(`${sinceLastFrame}ms of inspector silence (limit ${silenceMs}ms)`, 'silence'));
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
function formatDrainSettleReason(reason: DrainSettleReason | undefined): string {
    return reason === undefined ? 'never requested' : `settled via ${reason}`;
}

/** How the drain handler settled: acknowledged, or one of the give-up paths. */
type DrainSettleReason = 'ack' | 'silence' | 'ceiling' | 'send-rejected';

/**
 * Error message for a `bun test` child that emitted an `'error'` event
 * (ENOENT, EACCES, …) — the tests never ran, so there is no kill to score.
 * Shared by the dry-run and mutant-run paths so both name the cause identically.
 */
function formatSpawnErrorMessage(spawnError: string): string {
    return `could not start bun test: ${spawnError}`;
}

/**
 * User-facing dry-run error for "bun never printed its inspector URL". Carries
 * what is needed to act on it without digging through logs: the timeout and the
 * option that controls it, how the child ended, and the TAIL of stderr (where
 * e.g. `spawn bun ENOENT` or a preload resolution error lands — the head is
 * usually just startup banner).
 */
function formatInspectorTimeoutMessage(
    inspectorTimeoutMs: number,
    child:              { exitCode: number | null, signal?: NodeJS.Signals | null, stderr: string, spawnError?: string, timedOut?: boolean }
): string {
    // The child never ran, so "exit code none" and a stderr tail would bury the real cause.
    if(child.spawnError !== undefined) {
        return formatSpawnErrorMessage(child.spawnError);
    }
    // A timedOut child was SIGTERMed by the runner's own run timeout (it hung without printing the URL), not killed externally.
    let ended = child.signal ? `terminated by signal ${child.signal}` : `exit code ${child.exitCode ?? 'none'}`;
    if(child.timedOut === true) {
        ended = 'killed by the runner after the run timeout (bun.timeout)';
    }
    const prefix = `Timeout waiting for inspector URL after ${inspectorTimeoutMs}ms (raise bun.inspectorTimeout if bun is slow to start)`;
    return `${prefix}; bun test ${ended}; last stderr: ${formatStderrTail(child.stderr)}`;
}

/**
 * The last 1000 characters of a child's stderr, trimmed, for a dry-run error:
 * the tail is where a child's own reason for exiting lands, the head is usually
 * just startup banner.
 */
function formatStderrTail(stderr: string): string {
    return stderr.trim().slice(-1000) || '(empty)';
}

/**
 * User-facing dry-run error for an inspector connection (or TestReporter.enable)
 * that failed after bun printed its URL. The usual cause is the child itself
 * exiting, e.g. the coverage preload giving up when its sync channel to the
 * runner is lost, and whether the enable is refused or left unanswered is down
 * to timing; either way the child's stderr says why, so its tail goes with it.
 */
function formatInspectorConnectMessage(error: string, child: { stderr: string }): string {
    return `Failed to connect to Bun inspector: ${error}; last stderr: ${formatStderrTail(child.stderr)}`;
}

/**
 * The abnormal conditions behind the single post-drain `warn` in
 * {@link BunTestRunner.dryRun}. A healthy dry run — drain acknowledged
 * ('ack'), no remaining found-id gaps, no duplicate found-id events — yields an
 * empty list and therefore no warn at all (the detailed drain/close/collision
 * numbers are logged at debug either way). Anything else is evidence the
 * inspector stream may be incomplete or merged: the drain-request never
 * arrived, the wait gave up ('silence'/'ceiling') or the round-trip was
 * rejected ('send-rejected'), found-id gaps remain, or the Bun TestReporter
 * id-collision bug was observed (duplicate found-id events). The WebSocket
 * close code is NOT a condition: bun closes the socket with 1006
 * (wasClean false) after the drain ack on every healthy run.
 */
function collectAbnormalDrainProblems(data: {
    drainSettleReason:     DrainSettleReason | undefined
    drainRejection:        string | undefined
    finalGaps:             readonly number[]
    duplicateFoundIdCount: number
}): string[] {
    const problems: string[] = [];
    if(data.drainSettleReason !== 'ack') {
        const rejection = data.drainRejection === undefined ? '' : ` (${data.drainRejection})`;
        problems.push(`drain handshake ${formatDrainSettleReason(data.drainSettleReason)}${rejection}`);
    }
    // The WebSocket close code is deliberately NOT a problem here. Measured on bun 1.4.2, every
    // healthy dry run ends with close code 1006 / wasClean false / reason "Connection ended" a few
    // ms after the last frame, because the child exits right after the drain ack. A close that
    // loses data before the ack already surfaces as a non-'ack' drain; the close detail stays in
    // the debug diagnostics and the completeness gate's error message.
    if(data.finalGaps.length > 0) {
        problems.push(`${data.finalGaps.length} found-id gap(s) remaining${formatGapIdList(data.finalGaps)}`);
    }
    if(data.duplicateFoundIdCount > 0) {
        problems.push(`${data.duplicateFoundIdCount} duplicate found-id event(s) (Bun TestReporter id-collision bug)`);
    }
    return problems;
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
    version:            number
    writtenAt:          number
    cachedTestNames:    string[]
    baseNameIndex:      [string, string[]][]
    testNameIndex:      [string, string][]
    /**
     * The exact (absolute) test files Stryker's `testFiles` option selected for the
     * dry run, so workers that never ran dryRun keep to the same selection in their
     * full-suite runs. Optional and additive: absent when Stryker selected none, and
     * ignored when not a non-empty array of strings.
     */
    testFiles?:         string[]
    /**
     * How long each test file's tests took in the dry run, in ms (project-relative file,
     * the id prefix, → the sum of its tests' durations), so every worker can hand bun a
     * mutant run's files cheapest first. Optional and additive, like testFiles: a registry
     * without it (or with a malformed one) still loads, and its mutant runs keep the
     * alphabetical file order.
     */
    testFileDurations?: [string, number][]
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

/** What a failed test says when neither bun's console recap nor the inspector says why. */
function defaultFailureMessage(testInfo: TestInfo): string {
    return testInfo.status === 'timeout' ? 'Test timed out' : 'Test failed';
}

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
 * Separator between the project-file prefix and the test's own name inside a
 * test id — see buildProjectFileTestName, which is the only thing that builds
 * one. Kept here so resolveCoveringTestFiles splits on exactly what was joined.
 */
const TEST_ID_FILE_SEPARATOR = ' > ';

/**
 * Per test file, the sum of its tests' durations (ms). The file is the id's prefix
 * (see buildProjectFileTestName), so the keys are exactly the files
 * resolveCoveringTestFiles derives from ids; tests whose id carries no file prefix
 * (console-fallback ids) are left out. Skipped tests count too, with their (near
 * zero) time. A test's duration is bun's own, so time spent loading the file or in
 * its beforeAll hooks is not counted.
 */
function sumDurationsByFile(tests: readonly RunnerTestResult[]): Map<string, number> {
    const durations = new Map<string, number>();
    for(const test of tests) {
        const sepIdx = test.id.indexOf(TEST_ID_FILE_SEPARATOR);
        if(sepIdx !== -1) {
            const file = test.id.slice(0, sepIdx);
            durations.set(file, (durations.get(file) ?? 0) + test.timeSpentMs);
        }
    }
    return durations;
}

/** `bun.bunArgs` (as spawned) for mutant runs: without `--randomize`/`--seed` (see stripRandomizeArgs). */
function mutantRunBunArgs(bunArgs: string[] | undefined): string[] | undefined {
    return bunArgs === undefined ? undefined : stripRandomizeArgs(bunArgs);
}

/** True for a `[file, ms]` registry entry. */
function isFileDurationEntry(entry: unknown): entry is [string, number] {
    return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'number';
}

/**
 * The registry's testFileDurations as a map, or undefined when it is absent or
 * malformed. It is only advisory (it orders files, it never selects them), so a bad
 * value is ignored rather than invalidating the registry.
 */
function parseTestFileDurations(value: unknown): Map<string, number> | undefined {
    return Array.isArray(value) && value.every(entry => isFileDurationEntry(entry)) ? new Map(value) : undefined;
}

/**
 * How long the completeness gate waits, after {@link InspectorClient.expectClose}
 * is called, for the WebSocket to actually finish closing before snapshotting
 * inspector data — see the drain step in {@link BunTestRunner.dryRun}. This only
 * needs to cover the gap between child-process exit and the WS's own teardown
 * of an already-idle socket (not a real network round-trip), so it is kept short.
 */
const INSPECTOR_DRAIN_TIMEOUT_MS = 1000;

/**
 * Smallest gap between the runner's own kill of a mutant-run child and
 * Stryker's per-mutant timeout. Stryker's TimeoutDecorator starts its timer
 * (options.timeout) in the main process before the run reaches this worker, and
 * when it fires it disposes and restarts the whole worker (~1 s each) instead of
 * just reporting Timeout. The runner therefore kills first. 750 ms covers
 * process-runner's 500 ms SIGTERM→SIGKILL grace (a child that handles SIGTERM
 * only dies at the SIGKILL), plus the child's reaping, the IPC hop and the
 * runner's own pre-spawn work. A child that does not handle SIGTERM is gone
 * within ~20 ms of the kill (measured on bun 1.4.2, sync and async hangs alike).
 */
const STRYKER_TIMEOUT_MARGIN_MIN_MS = 750;
/** Proportional part of the margin: 5% of Stryker's timeout, when that is larger. */
const STRYKER_TIMEOUT_MARGIN_RATIO = 0.05;
/**
 * Upper bound on the margin as a fraction of Stryker's timeout. The 750 ms floor
 * alone would eat three quarters of a 1 s timeout; capping at 25% leaves a small
 * `timeoutMS` at least three quarters of its budget to run in. The cap only binds
 * below 3 s, where the margin is then shorter than the 750 ms SIGTERM-to-SIGKILL
 * cushion, so a child that handles SIGTERM may outlast Stryker's timer.
 */
const STRYKER_TIMEOUT_MARGIN_MAX_RATIO = 0.25;
/** Fraction of bun.timeout a dry run may use before the runner warns that the limit is tight. */
const DRY_RUN_TIMEOUT_WARN_RATIO = 0.8;

/**
 * The runner's own kill limit for a mutant run given Stryker's per-mutant
 * `options.timeout`: that timeout minus max(750 ms, 5%), with the margin capped
 * at 25% of the timeout so a tiny budget still leaves the run most of its time.
 */
function limitFromStrykerTimeout(strykerTimeoutMs: number): number {
    const margin = Math.min(strykerTimeoutMs * STRYKER_TIMEOUT_MARGIN_MAX_RATIO, Math.max(STRYKER_TIMEOUT_MARGIN_MIN_MS, strykerTimeoutMs * STRYKER_TIMEOUT_MARGIN_RATIO));
    return Math.floor(strykerTimeoutMs - margin);
}

/**
 * True when Stryker supplied a usable per-mutant timeout. `MutantRunOptions.timeout`
 * is typed as required, but callers outside Stryker core (and older cores) can
 * leave it out; anything that is not a positive finite number falls back to
 * bun.timeout rather than producing a zero or NaN kill timer.
 */
function isUsableTimeout(timeout: unknown): timeout is number {
    return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0;
}

/** Prefix the coverage preload (src/templates/coverage-preload.ts) puts on its own stderr diagnostics. */
const PRELOAD_COVERAGE_DIAGNOSTIC_PREFIX = '[Stryker Coverage]';
/** Cap on preload diagnostic lines carried into one log message. */
const MAX_PRELOAD_DIAGNOSTIC_LINES = 20;

/**
 * The coverage preload's `[Stryker Coverage] …` lines from a child's stderr,
 * ANSI-stripped and trimmed, at most {@link MAX_PRELOAD_DIAGNOSTIC_LINES}.
 */
function extractPreloadCoverageDiagnostics(stderr: string): string[] {
    return stripAnsi(stderr)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith(PRELOAD_COVERAGE_DIAGNOSTIC_PREFIX))
        .slice(0, MAX_PRELOAD_DIAGNOSTIC_LINES);
}

/**
 * True when any mutant has a positive hit count, per test or statically —
 * Stryker's own test (TestCoverage.from counts only `count > 0`).
 */
function coversAnyMutant(coverage: MutantCoverage): boolean {
    const buckets = [coverage.static, ...Object.values(coverage.perTest)];
    return buckets.some(bucket => Object.values(bucket).some(count => count > 0));
}

/**
 * The warnings a mutant run can emit once per mutant, by kind. Each is logged through
 * {@link MutantWarnAggregator}: the first of a kind at warn, later ones at debug, and a
 * summary line named by these labels at dispose() when a kind affected several mutants.
 */
const MUTANT_WARN_KIND = {
    unresolvedKilledBy:  'failed test names could not be resolved to dry-run test ids',
    noRegistry:          'no exact-name registry available (lossy covering-test patterns)',
    registryMiss:        'testFilter ids missing from exact-name registry (lossy fallback)',
    zeroMatchRetry:      '--test-name-pattern matched 0 tests (retried with the full suite)',
    zeroMatchNoRetry:    '--test-name-pattern matched 0 tests with no covering tests left to retry',
    spawnError:          'could not start bun test, scoring as Error rather than Killed',
    signalError:         'bun test terminated by a signal, scoring as Error rather than Killed',
    noEvidence:          'bun test exited non-zero with no failing test and no fail/error count, scoring as Error rather than Killed',
    inconclusiveTimeout: 'inconclusive timeout, scoring as Error rather than Timeout',
    registryVersion:     'dryRun registry file has an unexpected version (skipped)',
    registryMalformed:   'dryRun registry file is malformed (treated as absent)',
    registryLoadFailed:  'failed to load the dryRun registry file',
    noKillerIdentified:  'no killing test identifiable, emitting empty killedBy',
    memoryLimit:         'bun test child exceeded maxChildRss, reporting a timeout',
} as const;

/** A zeroed tally of mutant runs per status. */
function emptyMutantRunCounts(): Record<MutantRunStatus, number> {
    return {
        [MutantRunStatus.Killed]:   0,
        [MutantRunStatus.Survived]: 0,
        [MutantRunStatus.Timeout]:  0,
        [MutantRunStatus.Error]:    0,
    };
}

/**
 * A fresh secret for one bun child's hit-limit sentinel (see
 * formatHitLimitSentinel in preload-logic.ts): 128 random bits as hex, so it is
 * unguessable and needs no escaping in {@link readReportedHitCount}'s pattern.
 */
function newHitLimitToken(): string {
    return randomBytes(16).toString('hex');
}

/**
 * The active mutant's hit count, if the coverage preload reported it past its
 * hit limit on the child's stderr; undefined otherwise. Only the preload's own
 * line counts: alone on its line and carrying `token`, the secret this run's
 * child was given, so test output cannot forge it.
 */
function readReportedHitCount(stderr: string, token: string): number | undefined {
    const match = new RegExp(String.raw`^${HIT_LIMIT_SENTINEL} ${token} (\d+)$`, 'm').exec(stderr);
    return match ? Number(match[1]) : undefined;
}

/** Per-mutant-run state shared by the first spawn and the zero-match full-suite retry. */
interface MutantRunContext {
    options:           MutantRunOptions
    bunfigPath:        string
    localRegistry:     Set<string>
    localBaseIndex:    Map<string, string[]>
    /** Number of covering test ids Stryker asked for (0 for a static mutant / full-suite plan, and for a file-scoped run). */
    coveringTestCount: number
    /** Absolute Date.now() by which every spawn of this mutant run must have been killed. */
    deadline:          number
    /** Stryker's options.timeout when it set the deadline; undefined when bun.timeout did. */
    strykerTimeoutMs?: number
    /**
     * Set when Stryker's testFilter was a list of test FILES (its own `testFiles`
     * option) rather than test ids: exactly these files run, with no
     * --test-name-pattern. See {@link BunTestRunner.resolveTestFileFilter}.
     */
    testFileScope?:    string[]
}

/**
 * Bun test runner for Stryker mutation testing
 */
export class BunTestRunner implements TestRunner {
    public static readonly inject = tokens(commonTokens.logger, commonTokens.options);

    private readonly bunPath:             string;
    private readonly timeout:             number;
    private readonly inspectorTimeout:    number;
    private readonly env?:                Record<string, string>;
    /** `bun.bunArgs` as the user wrote them; validated at init(). */
    private readonly configuredBunArgs?:  string[];
    /** `bun.bunArgs` as spawned: the user's `--config`/`-c` is removed (the runner passes its own sanitized one). */
    private readonly bunArgs?:            string[];
    /** {@link bunArgs} for mutant runs: without `--randomize`/`--seed`, which only the dry run keeps (see stripRandomizeArgs). */
    private readonly mutantBunArgs?:      string[];
    /**
     * True when the current sanitized bunfig randomizes the test order, so mutant runs use its mutant-run
     * copy (see mutantRunBunfigPath). Set whenever the sanitized bunfig is (re)generated, which every run does first.
     */
    private sanitizedBunfigRandomizes?:   boolean;
    /** True once the "randomized order is off for mutant runs" debug line has been logged; it is shown once per runner. */
    private loggedRandomizeOff = false;
    /** Which argv-budget notes (see {@link fitTestFiles}) have been logged; each is shown once per runner. */
    private readonly loggedFileArgNotes = new Set<'relative' | 'none' | 'oversized'>();
    /**
     * Each test file's dry-run duration in ms (project-relative file → sum of its tests' durations),
     * from this worker's dry run or the shared registry. Mutant runs hand bun their files in
     * ascending order of it; undefined when neither had any, and the order is then left alone.
     */
    private testFileDurations?:           Map<string, number>;
    /** The user's bunfig named by `--config`/`-c` in `bun.bunArgs`, as written: the source the runner sanitizes and reads `[test].root` from. */
    private readonly sourceBunfig?:       string;
    private readonly testFilesOverride?:  string[];
    private readonly mutateGlobs:         readonly string[];
    private readonly smol:                boolean;
    private readonly maxChildRss?:        number;
    private readonly rssCheckIntervalMs?: number;
    private readonly maxSpawnDepth?:      number;
    /** Stryker's coverageAnalysis from the Stryker options; DryRunOptions.coverageAnalysis wins when given. */
    private readonly coverageAnalysis?:   CoverageAnalysis;
    private preloadScriptPath?:           string;
    private coverageFilePath?:            string;
    private sanitizedBunfigPath?:         string;
    private sanitizedBunfigCwd?:          string;
    private tempDir?:                     string;
    private cachedTestNames?:             Set<string>;
    private baseNameIndex?:               Map<string, string[]>;
    private testNameIndex?:               Map<string, string>;
    /** The auto-discovered test files, valid for `cachedTestFilesCwd` only. Written by discovery alone, never by a selection. */
    private cachedTestFiles?:             string[];
    private cachedTestFilesCwd?:          string;
    /**
     * The list mutantRun uses for its "run all tests" runs and for validating covering-test
     * narrowing: the effective selection (Stryker's testFiles, bun.testFiles or discovery).
     * Kept apart from {@link cachedTestFiles} so a selection can never be read back as the discovered set.
     */
    private effectiveTestFiles?:          string[];
    /**
     * The test files Stryker's own `testFiles` option selected (DryRunOptions.testFiles), as
     * exact absolute paths, valid for `cwd`. Set by dryRun (or loaded from the shared registry
     * by a worker that never ran dryRun). While set it wins over bun.testFiles and
     * auto-discovery, for the dry run and for every "run all tests" fallback after it.
     */
    private strykerTestFiles?:            { cwd: string, files: string[] };
    /** True once the "Stryker's testFiles overrides bun.testFiles" warning has been logged. */
    private warnedTestFilesConflict = false;
    /** True once the dist/build-discovery warning has been logged; it is shown once per runner. */
    private warnedBuildOutputTests = false;
    /** True once the "bunfig retry/rerunEach ignored" warning has been logged; it is shown once per runner. */
    private warnedIgnoredBunfigKeys = false;
    private cachedEagerModules?:          string[];
    private cachedEagerModulesCwd?:       string;
    private lastRegistryTmpPath?:         string;
    /** True once `<bunPath> --version` has passed the startup check; later init() calls skip it. */
    private bunChecked = false;
    /** The version the startup check reported; set together with {@link bunChecked}. */
    private bunVersion?:                  string;
    /** True once the start summary has been logged; it is shown once per runner. */
    private loggedStartSummary = false;
    /** Stryker's `disableBail` option as given at construction; undefined when Stryker did not supply it. */
    private readonly disableBail?:        boolean;
    /** Per-mutant warnings: the first of each kind at warn, the rest at debug, one summary per repeated kind at dispose(). */
    private readonly mutantWarnings:      MutantWarnAggregator;
    /** The mutant runs this worker has executed, by the status returned to Stryker. Reset when the end summary is logged. */
    private mutantRunsByStatus = emptyMutantRunCounts();
    /** Mutant runs that had covering tests but ran the full suite anyway (pattern too long, or zero-match retry). Reset with {@link mutantRunsByStatus}. */
    private fullSuiteFallbacks = 0;

    /**
   * AbortController for whichever `dryRun`/`mutantRun` child process is
   * currently in flight, if any. Lets {@link dispose} kill an orphaned child
   * if Stryker disposes this runner while a run hasn't finished — see
   * "Orphan prevention" in docs/internals.md.
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
        this.configuredBunArgs = bunOptions.bunArgs;
        const split = bunOptions.bunArgs === undefined ? undefined : splitBunConfigArg(bunOptions.bunArgs);
        this.bunArgs = split?.args;
        this.mutantBunArgs = mutantRunBunArgs(this.bunArgs);
        this.sourceBunfig = split?.configPath;
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
        // Likewise declared non-optional (Stryker defaults it to 'perTest') but absent in partial options.
        this.coverageAnalysis = (options as { coverageAnalysis?: CoverageAnalysis }).coverageAnalysis;
        // Likewise declared non-optional (Stryker defaults it to false) but absent in partial options.
        this.disableBail = (options as { disableBail?: boolean }).disableBail;
        this.mutantWarnings = new MutantWarnAggregator(logger);

        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('BunTestRunner initialized with options: %o', {
            bunPath:            this.bunPath,
            timeout:            this.timeout,
            inspectorTimeout:   this.inspectorTimeout,
            env:                this.env,
            bunArgs:            this.configuredBunArgs,
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
     * The temp directory is OS-managed instead. Specifically it is the run's
     * private directory (src/utils/private-temp-dir.ts): owned by the current
     * user, mode 0700, re-resolved (and so re-verified) before every write and
     * before the lazy load, so another local user can neither plant nor read a
     * registry.
     *
     * Keyed by sha256(cwd + ':' + ppid) (plus the uid, in the directory name): every worker process Stryker spawns
     * for one run is a direct child of that run's single Stryker main
     * process, so all of them share BOTH process.cwd() (the sandbox
     * directory) AND process.ppid (the main process's pid) — and therefore
     * independently resolve this SAME path with no coordination required
     * (resolveRunTempDir's numbered slots converge too: each call takes the
     * lowest slot that is already ours). A
     * worker recycled mid-run is still a child of the same main process, so
     * it re-derives the same path too (docs/internals.md documents recycled instances
     * lazily loading the registry). This is the entire sharing contract:
     * writer (buildAndPersistTestRegistry) and reader (loadRegistryFile) both
     * go through this one method rather than reimplementing the formula, so
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
     * Reading process.cwd()/process.ppid at call time
     * (rather than caching at construction) ensures the path resolves against
     * Stryker's sandbox directory — which is set by the time these are
     * invoked — rather than the orchestrator's cwd at module-load time.
     */
    private async resolveRegistryPath(): Promise<string> {
        return path.join(await resolveRunTempDir(), 'registry.json');
    }

    /**
   * Narrow a targeted mutant run to just the test FILES its covering tests live
   * in.
   *
   * `--test-name-pattern` filters at the TEST level, not the file level: bun
   * still loads every test file it was given in order to discover which names
   * match. On a suite of 31 spec files that costs ~330ms per run of which only
   * ~54ms is process startup — and a run that ends up executing two tests pays
   * it in full, on every mutant. Handing bun only the files that can contain a
   * covering test drops the same measurement to ~66ms.
   *
   * Test ids are `<projectFile> > <fullName>` (see buildProjectFileTestName), so
   * the file is already the id's prefix and no extra bookkeeping is needed.
   *
   * Returns undefined — meaning "use the full discovered list" — whenever the
   * narrowing cannot be proven safe:
   * - no filter at all (static mutants, full-suite runs),
   * - any id that carries no parsable file prefix (console-fallback ids), or
   * - any derived file that is not in the discovered list, which would mean the
   *   prefix was something other than a real test file.
   *
   * A wrong narrowing would silently skip a covering test and turn a killed
   * mutant into a survivor, so every uncertain case takes the full list.
   */
    private resolveCoveringTestFiles(filterIds: readonly string[]): string[] | undefined {
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: no covering tests means a full-suite run; covered by 'keeps the full file list when there is no test filter'
        if(filterIds.length === 0) {
            return undefined;
        }
        const discovered = this.effectiveTestFiles;
        // Stryker disable next-line ConditionalExpression,BlockStatement: without a discovered list there is nothing to validate against; covered by 'keeps the full file list when discovery produced nothing'
        if(!discovered || discovered.length === 0) {
            return undefined;
        }
        // Ids carry the project-relative file, but the list may hold absolute entries
        // (Stryker's own testFiles arrive as absolute sandbox paths): match on the
        // relative form and hand bun the entry exactly as listed.
        const listedByProjectFile = new Map<string, string>();
        for(const listed of discovered) {
            listedByProjectFile.set(normalizeTestFilePath(listed) ?? listed, listed);
        }
        const files = new Set<string>();
        for(const id of filterIds) {
            const sepIdx = id.indexOf(TEST_ID_FILE_SEPARATOR);
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: a fallback-path id has no file prefix; covered by 'keeps the full file list when an id carries no file prefix'
            if(sepIdx === -1) {
                return undefined;
            }
            const file = id.slice(0, sepIdx);
            const listed = listedByProjectFile.get(file);
            if(listed === undefined) {
                return undefined;
            }
            files.add(listed);
        }
        // Alphabetical: the order orderCheapestFirst keeps between files with the same (or no) dry-run time.
        return [...files].toSorted((a, b) => a.localeCompare(b));
    }

    /**
   * `files` in ascending order of their dry-run duration, for a mutant run.
   *
   * Mutant runs bail on the first failing test, and bun runs the files it is given
   * in argument order (measured on bun 1.4.2, for path arguments — see
   * runBunTests). Running the cheapest covering file first means a fast unit test
   * usually kills the mutant before a slow integration file is even loaded.
   *
   * The sort is stable: files that took the same time keep their order (the
   * alphabetical order of the discovered list and of resolveCoveringTestFiles), and
   * files with no recorded duration — every file, when there are no durations at
   * all — go last in their old order. `files` itself is not modified.
   */
    private orderCheapestFirst(files: readonly string[] | undefined): string[] | undefined {
        const cost = (file: string): number => this.testFileDurations?.get(normalizeTestFilePath(file) ?? file) ?? Number.POSITIVE_INFINITY;
        // Infinity - Infinity is NaN, which a sort comparator treats as "equal".
        return files?.toSorted((a, b) => cost(a) - cost(b));
    }

    /**
   * Say once, at debug, that mutant runs do not randomize the test order although
   * the project asked for it (in the bunfig, in bun.bunArgs, or both). They run
   * test files cheapest first and tests in source order, so a mutant's verdict
   * never depends on a random order; the dry run keeps the setting.
   */
    private logRandomizeOffOnce(): void {
        const sources: string[] = [];
        if(this.sanitizedBunfigRandomizes) {
            sources.push('the bunfig\'s [test].randomize/seed');
        }
        if(this.mutantBunArgs?.length !== this.bunArgs?.length) {
            sources.push('--randomize/--seed in bun.bunArgs');
        }
        if(this.loggedRandomizeOff || sources.length === 0) {
            return;
        }
        this.loggedRandomizeOff = true;
        this.logger.debug('Randomized test order applies to the dry run only; mutant runs turn it off (%s) and run test files cheapest-first', sources.join(' and '));
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
   * The files Stryker's own `testFiles` option selected, when they apply to `cwd`.
   * A selection recorded under another cwd (a different sandbox) names files that
   * are not there, so it is ignored rather than trusted.
   */
    private selectedTestFilesFor(cwd: string): string[] | undefined {
        return this.strykerTestFiles?.cwd === cwd ? this.strykerTestFiles.files : undefined;
    }

    /**
   * Record (or clear) the selection from DryRunOptions.testFiles for this dry run.
   *
   * Stryker (core 9.6+, also 10) fills `testFiles` with the sandbox-absolute paths of
   * the files matching its `testFiles` option, or leaves it undefined. Only a
   * non-empty array counts; an empty one is treated as unset. Relative entries are
   * resolved against the cwd, so bun gets exact paths (a bare relative argument is a
   * substring filter to `bun test`, which would also run e.g. a `dist/` copy).
   *
   * Precedence for the files bun is handed: Stryker's testFiles > bun.testFiles >
   * auto-discovery. When both Stryker's and bun.testFiles select files and they
   * differ, one warning says Stryker's wins.
   */
    private applyDryRunTestFiles(options: DryRunOptions | undefined): void {
        const requested = options?.testFiles;
        const cwd = process.cwd();
        if(requested === undefined || requested.length === 0) {
            this.strykerTestFiles = undefined;
            if(requested !== undefined) {
                this.logger.debug('Stryker passed an empty testFiles array; ignoring it');
            }
        } else {
            const files = [...new Set(requested.map(file => path.resolve(cwd, file)))].toSorted((a, b) => a.localeCompare(b));
            this.strykerTestFiles = { cwd, files };
            this.warnIfTestFilesOverridden(files, cwd);
        }
    }

    /** Where the test files for `cwd` come from, in the precedence of {@link getOrDiscoverTestFiles}, for the log. */
    private testFilesSource(cwd: string): string {
        return this.explicitTestFilesSource(cwd) ?? 'auto-discovery';
    }

    /** Like {@link testFilesSource}, but undefined when the files are auto-discovered rather than chosen by the user. */
    private explicitTestFilesSource(cwd: string): string | undefined {
        if(this.selectedTestFilesFor(cwd) !== undefined) {
            return 'Stryker\'s testFiles option';
        }
        return this.testFilesOverride === undefined ? undefined : 'bun.testFiles';
    }

    /**
     * The test files to hand bun for this spawn, kept within the argv budget (see
     * MAX_TEST_FILE_ARGS_BYTES). `files` is already narrowed and ordered.
     *
     * - Within the budget (as absolute paths, or as the shorter ./-relative ones
     *   runBunTests then picks, said once at debug): `files` as given.
     * - Over it, with auto-discovered files: undefined, so bun finds and runs every
     *   test file itself. That is the full suite, which is what a full-suite run
     *   lists anyway, and a superset of a targeted run's covering files — safe,
     *   because a targeted run keeps its --test-name-pattern; it only loses the
     *   cheapest-first order (said once at info).
     * - Over it, with files the user chose (bun.testFiles, Stryker's testFiles):
     *   `files`, as no other list would keep the selection, and a warning (once)
     *   that bun may fail to start.
     *
     * @param explicitSource - What chose the files, or undefined when they were auto-discovered
     */
    private fitTestFiles(files: string[] | undefined, explicitSource: string | undefined): string[] | undefined {
        if(files === undefined) {
            return undefined;
        }
        const fit = buildTestFileArgs(files);
        if(fit.fits) {
            if(fit.form === 'relative' && !this.loggedFileArgNotes.has('relative')) {
                this.loggedFileArgNotes.add('relative');
                this.logger.debug('The %d test file argument(s) as absolute paths would exceed the %d-byte budget; passing ./-relative paths (%d bytes) instead', files.length, MAX_TEST_FILE_ARGS_BYTES, fit.bytes);
            }
            return files;
        }
        if(explicitSource === undefined) {
            if(!this.loggedFileArgNotes.has('none')) {
                this.loggedFileArgNotes.add('none');
                this.logger.info('The %d test file argument(s) take %d bytes even as ./-relative paths, over the %d-byte budget; passing no file list, so bun finds and runs every test file itself (in its own order, not cheapest first)', files.length, fit.bytes, MAX_TEST_FILE_ARGS_BYTES);
            }
            return undefined;
        }
        if(!this.loggedFileArgNotes.has('oversized')) {
            this.loggedFileArgNotes.add('oversized');
            this.logger.warn(
                'The %d test file argument(s) from %s take %d bytes even as ./-relative paths, over the %d-byte budget, and no other list would keep your selection; spawning bun may fail with E2BIG. List directories rather than individual files, or select fewer files',
                files.length,
                explicitSource,
                fit.bytes,
                MAX_TEST_FILE_ARGS_BYTES
            );
        }
        return files;
    }

    /** Debug-log how many test files the dry run uses and where they came from. Same precedence as {@link getOrDiscoverTestFiles}. */
    private logTestFilesSource(testFiles: readonly string[] | undefined, cwd: string): void {
        this.logger.debug('Dry run test files: %d from %s', testFiles?.length ?? 0, this.testFilesSource(cwd));
    }

    /**
     * Log the one-line start summary (at info, once per runner): the bun version and path, how
     * many test files the runner hands bun and where they came from, the sanitized bunfig, and
     * whether mutant runs bail. Called at the end of init(), so a re-init in another cwd
     * (Stryker's sandbox rotation) does not repeat it.
     *
     * @param testFiles the files {@link getOrDiscoverTestFiles} chose; undefined when discovery
     *                  found none and bun is left to discover the tests itself
     */
    private logStartSummary(testFiles: readonly string[] | undefined): void {
        if(this.loggedStartSummary) {
            return;
        }
        this.loggedStartSummary = true;
        const files = testFiles === undefined
            ? 'no test files found by the runner, bun will discover them itself'
            : `${testFiles.length} test file(s) from ${this.testFilesSource(process.cwd())}`;
        const parts = [
            `Bun test runner started: bun ${this.bunVersion} at ${this.bunPath}`,
            files,
            `sanitized bunfig ${this.sanitizedBunfigPath}`,
        ];
        if(this.disableBail !== undefined) {
            parts.push(this.disableBail ? 'bail off' : 'bail on');
        }
        this.logger.info('%s', parts.join('; '));
    }

    /**
   * Warn, once per runner, that Stryker's testFiles option replaces a differing
   * bun.testFiles. Both are compared as sets of resolved absolute paths, so the same
   * files spelled relative vs absolute, or in another order, are not a conflict.
   */
    private warnIfTestFilesOverridden(selected: readonly string[], cwd: string): void {
        if(this.warnedTestFilesConflict || this.testFilesOverride === undefined) {
            return;
        }
        const configured = [...new Set(this.testFilesOverride.map(file => path.resolve(cwd, file)))];
        const selectedSet = new Set(selected);
        if(configured.length === selectedSet.size && configured.every(file => selectedSet.has(file))) {
            return;
        }
        this.warnedTestFilesConflict = true;
        this.logger.warn(
            'Both Stryker\'s testFiles option and bun.testFiles are set and select different test files; '
            + 'Stryker\'s testFiles option takes precedence and bun.testFiles is ignored. '
            + 'Remove bun.testFiles, or make the two agree, to silence this warning.'
        );
    }

    /**
   * Return the test file list to use for this run.
   * Precedence: the files Stryker's own `testFiles` option selected (see
   * {@link applyDryRunTestFiles}), then `bun.testFiles` (returned verbatim), then
   * auto-discovery; the first two skip discovery entirely. A discovery result is
   * cached after the first real call so that subsequent callers (dryRun, mutantRun)
   * do not re-glob the filesystem.
   */
    private async getOrDiscoverTestFiles(): Promise<string[] | undefined> {
        const selected = this.selectedTestFilesFor(process.cwd());
        if(selected !== undefined) {
            return selected;
        }
        // Stryker disable next-line EqualityOperator,BlockStatement: EqualityOperator: inverts condition, ignoring override → discovery runs on wrong files → Timeout; BlockStatement: removes early return, override ignored → Timeout
        if(this.testFilesOverride !== undefined) {
            return this.testFilesOverride;
        }
        const cwd = process.cwd();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cache hit — cwd match verified by tests; mutations caught by 'rediscovers test files when cwd changes'
        if(this.cachedTestFiles !== undefined && this.cachedTestFilesCwd === cwd) {
            return this.cachedTestFiles;
        }
        this.cachedTestFiles = await discoverTestFiles(cwd, this.logger, this.sourceBunfig);
        this.cachedTestFilesCwd = cwd;
        this.warnAboutBuildOutputTests(this.cachedTestFiles);
        return this.cachedTestFiles;
    }

    /**
   * Warn, once per runner, when auto-discovery picked up test files below a
   * `dist` or `build` directory. Bun searches those directories too, so a
   * project whose tsc emits `dist/**\/*.test.js` gets the compiled copies run
   * as well: slower, and a stale compiled test can fail the dry run. Parity
   * with `bun test` is kept on purpose; the warning names the ways out.
   */
    private warnAboutBuildOutputTests(discovered: readonly string[] | undefined): void {
        if(this.warnedBuildOutputTests || !discovered) {
            return;
        }
        const buildOutput = findBuildOutputTestFiles(discovered);
        if(buildOutput.length === 0) {
            return;
        }
        this.warnedBuildOutputTests = true;
        const sample = buildOutput.slice(0, 3).join(', ');
        this.logger.warn(
            'Test discovery found %d test file(s) under a "dist" or "build" directory (e.g. %s%s); bun searches those directories too, so compiled copies of your tests will run '
            + '(slower, and a stale compiled test can fail the dry run). To exclude them set [test].root or [test].pathIgnorePatterns in bunfig.toml, '
            + 'or list the tests to run in bun.testFiles. This warning is shown once.',
            buildOutput.length,
            sample,
            buildOutput.length > 3 ? ', …' : ''
        );
    }

    /**
   * Test-file cache hit for a given cwd.
   * Returns the cached list synchronously when available, or undefined to
   * signal that async re-discovery is needed (cwd changed or first call).
   * Used by dryRun() to avoid introducing a microtask yield on the hot path.
   */
    private testFilesCacheHit(cwd: string): string[] | undefined | null {
        const selected = this.selectedTestFilesFor(cwd);
        if(selected !== undefined) {
            return selected;
        }
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

        // Reject bunArgs that fight the runner's own flags (concurrency, test selection, ...)
        // before doing any work — a loud config error beats silently wrong mutant scores.
        assertSupportedBunArgs(this.configuredBunArgs);

        // Fail fast, with an actionable message, if bun cannot be run or is older than the
        // supported floor — otherwise a missing binary only shows up later as a dry-run
        // "Timeout waiting for inspector URL". Uses the same bunPath/env the real spawn uses.
        // Done once per runner: the binary does not change between sandbox-rotation re-inits.
        if(!this.bunChecked) {
            this.bunVersion = await checkBunVersion(this.bunPath, this.env);
            this.bunChecked = true;
        }

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

        // Every temp file of this worker (preload script, coverage data, sanitized
        // bunfig) goes in the run's private directory, verified before anything is
        // written: an unsafe directory (another user's, a symlink, group/other
        // access) fails init loudly rather than letting the preload be swapped.
        const tempDir = await this.ensureRunTempDir();
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
        const testFiles = await this.getOrDiscoverTestFiles();
        this.logStartSummary(testFiles);
    }

    /** Create/verify the run's private temp directory (see src/utils/private-temp-dir.ts) and remember it as this worker's tempDir. */
    private async ensureRunTempDir(): Promise<string> {
        this.tempDir = await resolveRunTempDir();
        return this.tempDir;
    }

    /**
   * Log the bunfig settings the sanitizer dropped or overrode: each at debug with
   * its reason, and the ones mutation runs cannot honour (retry, rerunEach) in
   * one warning, shown once per runner however often the bunfig is regenerated.
   */
    private reportDroppedBunfigKeys(drops: readonly DroppedBunfigKey[]): void {
        for(const drop of drops) {
            this.logger.debug('Sanitized bunfig dropped %s: %s', drop.key, drop.reason);
        }
        const ignored = drops.filter(d => d.warn);
        if(this.warnedIgnoredBunfigKeys || ignored.length === 0) {
            return;
        }
        this.warnedIgnoredBunfigKeys = true;
        const lines = ignored.map(() => '  - %s: it %s').join('\n');
        this.logger.warn(
            `These bunfig settings were ignored for mutation runs (remove them from the bunfig to silence this warning; a per-test { retry } option in test code still applies):\n${lines}`,
            ...ignored.flatMap(d => [d.key.replace(/^test\./, '[test].'), d.reason])
        );
    }

    /**
   * Regenerate the sanitized bunfig if the worker's cwd has changed (or if this
   * is the first spawn). The sanitizer anchors the relative `preload`/`root`
   * paths it forwards at this cwd (bun itself resolves relative bunfig paths
   * against the process cwd, not against the bunfig's directory), so keying on
   * cwd ensures those paths land in the right sandbox. Every setting it did not
   * forward is logged at debug; ignored retry/rerun settings warn once per runner.
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
        const tempDir = this.tempDir ?? await this.ensureRunTempDir();
        let randomizes = false;
        this.sanitizedBunfigPath = await generateSanitizedBunfig(cwd, tempDir, this.sourceBunfig, (drops) => {
            // A key dropped for mutant runs only means the sanitizer wrote a mutant-run copy.
            randomizes = drops.some(drop => drop.mutantRunsOnly);
            this.reportDroppedBunfigKeys(drops);
        });
        this.sanitizedBunfigRandomizes = randomizes;
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
   *
   * The registry is only ever read from a verified private directory: it is
   * resolved first, outside the try, so a registry another user could have
   * planted is never trusted, and an unsafe temp area (a directory above the
   * run directory) fails the mutant run loudly instead.
   */
    private async loadRegistryFile(mutantId: string): Promise<void> {
        const registryPath = await this.resolveRegistryPath();
        try {
            const raw = await fsPromises.readFile(registryPath, 'utf8');
            const parsed = JSON.parse(raw) as RegistryFileV2;
            if(parsed.version !== 2) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.mutantWarnings.warn(MUTANT_WARN_KIND.registryVersion, mutantId, 'dryRun registry file has unexpected version %s; skipping', String(parsed.version));
                return;
            }
            if(!Array.isArray(parsed.cachedTestNames) || !Array.isArray(parsed.baseNameIndex) || !Array.isArray(parsed.testNameIndex)) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.mutantWarnings.warn(
                    MUTANT_WARN_KIND.registryMalformed,
                    mutantId,
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
                this.mutantWarnings.warn(
                    MUTANT_WARN_KIND.registryMalformed,
                    mutantId,
                    'dryRun registry file is malformed (testNameIndex entry is not a [string, string] pair); treating as absent'
                );
                return;
            }
            this.cachedTestNames = new Set<string>(parsed.cachedTestNames);
            this.baseNameIndex   = new Map<string, string[]>(parsed.baseNameIndex);
            this.testNameIndex   = new Map<string, string>(parsed.testNameIndex);
            // The selection Stryker's testFiles option made for the dry run. The field is
            // optional and only advisory (an unusable value just means "no selection"), so it
            // never invalidates the rest of the registry.
            const selectedFiles: unknown = parsed.testFiles;
            if(Array.isArray(selectedFiles) && selectedFiles.length > 0 && selectedFiles.every((file: unknown) => typeof file === 'string')) {
                this.strykerTestFiles = { cwd: process.cwd(), files: selectedFiles };
            }
            this.testFileDurations = parseTestFileDurations(parsed.testFileDurations);
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
            } else {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                this.mutantWarnings.warn(
                    MUTANT_WARN_KIND.registryLoadFailed,
                    mutantId,
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
        const baseFailureMessage = parsedTest?.failureMessage ?? testInfo.error?.message ?? defaultFailureMessage(testInfo);
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

            // A timed-out test is a failed one: bun counts it on its ' N fail' line.
            if(status === 'fail' || status === 'timeout') {
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

            if(status === 'skip' || status === 'todo' || status === 'skipped_because_label') {
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
   * Run all tests (dry run). Stryker always passes `options`; only its
   * `coverageAnalysis` is read (to judge missing coverage, see
   * checkCoverageData), falling back to the Stryker options' value. bun.timeout,
   * not `options.timeout` (dryRunTimeoutMinutes), bounds the child.
   */
    public async dryRun(options?: DryRunOptions): Promise<DryRunResult> {
        const coverageAnalysis = this.resolveCoverageAnalysis(options);
        // Stryker's own `testFiles` option, when set, decides which files this dry run (and the
        // "run everything" fallbacks of later mutant runs) cover; see applyDryRunTestFiles.
        this.applyDryRunTestFiles(options);
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

        // 1-2. Start the sync server. Neither it nor bun's inspector (see inspect
        // below) is given a port chosen in advance: each binds port 0 and reports
        // the port the OS gave it. A port probed free and released again can be
        // bound by another process before the server or bun gets to it.
        const syncServer = new SyncServer();
        let syncPort: number;
        try {
            await syncServer.start();
            syncPort = syncServer.port;
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
        const inspectorUrlWaiter = createInspectorUrlWaiter();

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
            const listed = testFilesCached === null ? await this.getOrDiscoverTestFiles() : testFilesCached;
            this.logTestFilesSource(listed, cwd);
            const testFiles = this.fitTestFiles(listed, this.explicitTestFilesSource(cwd));

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
                // child (mutant runs are bounded by Stryker's per-mutant timeout, see
                // mutantRun), and a genuinely hung dry run is already a rare,
                // one-time cost.
                timeout:               this.timeout + DRAIN_ACK_ABSOLUTE_CEILING_MS,
                env:                   this.env,
                bunArgs:               this.bunArgs,
                bunfigPath,
                preloadScript:         this.preloadScriptPath,
                coverageFile:          this.coverageFilePath,
                inspect:               true,
                sequentialMode:        true,  // Critical for correlation
                syncPort, // Pass sync port to preload script via env var
                syncToken:             syncServer.token,
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
                onInspectorReady: inspectorUrlWaiter.onReady,
            });

            // 4. Wait for inspector URL with timeout (or until the child is gone)
            const inspectorUrl = await inspectorUrlWaiter.wait(testProcess, this.inspectorTimeout);

            if(!inspectorUrl) {
                // Await the child to drain its stdout/stderr so we can surface what Bun
                // actually emitted before we abandoned it.  Some setups (e.g. preload
                // scripts that fail to resolve) can make Bun exit before the inspector
                // banner is printed; without this diagnostic the user only sees a
                // useless "Timeout waiting for inspector URL".
                // Close the sync server first: the preload waits for 'ready' with no
                // deadline, so a child still running would otherwise sit there until the
                // run timeout kills it. Seeing its sync socket fail or close, it exits at
                // once and says why on stderr, which the diagnostics below include.
                await syncServer.close();
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
                    errorMessage: formatInspectorTimeoutMessage(this.inspectorTimeout, diagnosticResult),
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
                // The child may well be the one that went away (see
                // formatInspectorConnectMessage): wait for it, already exiting or
                // just aborted, so its stderr can say why.
                const child = await testProcess;
                return {
                    status:       DryRunStatus.Error,
                    errorMessage: formatInspectorConnectMessage(errorMsg, child),
                };
            }

            // undefined = drain-request never arrived (step 9 reports this distinctly).
            let drainSettleReason: DrainSettleReason | undefined;
            // Error text when the drain round-trip itself was rejected ('send-rejected'); surfaced in the single abnormal-data warn.
            let drainRejection: string | undefined;

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
                // debug, not warn: every healthy dry run performs this handshake. The one
                // abnormal-data warn (if any) is emitted at step 9 — see collectAbnormalDrainProblems.
                this.logger.debug(
                    'Drain-request received: %d/%d/%d found/start/end events received so far; %d found-id gap(s)%s',
                    countsAtRequest.found, countsAtRequest.start, countsAtRequest.end,
                    gapsAtRequest.length, formatGapIdList(gapsAtRequest)
                );

                const { promise: silencePromise, cancel: cancelSilence } = raceAgainstSilence(
                    inspector, DRAIN_ACK_SILENCE_TIMEOUT_MS, DRAIN_ACK_ABSOLUTE_CEILING_MS
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
                    if(error instanceof DrainWaitTimeoutError) {
                        drainSettleReason = error.reason;
                        // Which bound fired and what it observed (e.g. how long the stream had been silent).
                        this.logger.debug('Inspector drain wait gave up: %s', error.message);
                    } else {
                        drainSettleReason = 'send-rejected';
                        drainRejection = error instanceof Error ? error.message : String(error);
                        this.logger.debug('Inspector drain round-trip rejected before any wait bound was hit: %s', drainRejection);
                    }
                    // Swallowed on purpose: resolving makes SyncServer send 'drained' even on
                    // give-up, releasing the child immediately — otherwise the child would
                    // idle out its own (now 40s) backstop on every failed handshake.
                } finally {
                    cancelSilence();
                    const elapsedMs = Date.now() - drainRequestReceivedAt;
                    const countsAtSettle = inspector.getEventCounts();
                    const gapsAtSettle = inspector.getFoundIdGaps();
                    this.logger.debug(
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

            // 7. Signal the preload script to start the tests. Only now: the inspector is
            // connected, TestReporter is enabled and the drain handler is registered, so
            // every test event is observed. The preload waits for this with no deadline of
            // its own, however long steps 5–6.5 take (they are bounded by inspectorTimeout).
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
            this.logger.debug(
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
            this.logger.debug(
                'Post-drain inspector close/collision diagnostics: WS close code=%s reason=%s wasClean=%s msFromLastFrameToClose=%s; '
                + 'found events %d raw / %d unique id(s) / %d duplicate id event(s) (nonzero duplicates = direct evidence of the Bun '
                + 'TestReporter id-collision bug; the found-id-gap count above is density-only — it does NOT prove losslessness under collisions)',
                String(closeInfo.code), String(closeInfo.reason), String(closeInfo.wasClean), String(closeInfo.msFromLastFrameToClose),
                collisionStats.rawFoundCount, collisionStats.uniqueFoundIdCount, collisionStats.duplicateFoundIdCount
            );

            // The ONE warn for this whole drain/post-drain block, and only when the data is
            // actually abnormal; the four diagnostics above stay at debug so a healthy run is quiet.
            this.warnOnAbnormalDrainData({
                drainSettleReason,
                drainRejection,
                finalGaps,
                duplicateFoundIdCount: collisionStats.duplicateFoundIdCount,
            });

            // 10–12. Handle timeout and process errors; parse output
            const parsed = parseBunTestOutput(result.stdout, result.stderr);
            const earlyResult = this.checkDryRunProcessResult(result, parsed, testHierarchy);
            if(earlyResult) {
                return earlyResult;
            }

            // 13–16. Collect/remap coverage, build tests, run the completeness gate, and
            // (if it passes) persist the registry — extracted to keep dryRun()'s own
            // complexity under the lint threshold; see buildGatedDryRunResult's doc comment.
            return await this.buildGatedDryRunResult(
                result, parsed, testHierarchy, executionOrder, totalElapsedMs,
                { wasClosedUnexpectedly, closeInfo, duplicateFoundIdCount: collisionStats.duplicateFoundIdCount },
                coverageAnalysis
            );
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
   * The dry run's coverageAnalysis: Stryker's DryRunOptions value, else the
   * Stryker options' value. Extracted to keep dryRun()'s complexity under the
   * lint threshold.
   */
    private resolveCoverageAnalysis(options: DryRunOptions | undefined): CoverageAnalysis | undefined {
        return options?.coverageAnalysis ?? this.coverageAnalysis;
    }

    /**
   * Emit the single post-drain `warn` iff {@link collectAbnormalDrainProblems}
   * finds anything; a healthy dry run logs nothing at warn. Extracted from
   * dryRun() to keep its complexity under the lint threshold.
   */
    private warnOnAbnormalDrainData(data: Parameters<typeof collectAbnormalDrainProblems>[0]): void {
        const problems = collectAbnormalDrainProblems(data);
        if(problems.length > 0) {
            this.logger.warn(
                'Inspector data looks abnormal after the dry run: %s — test results may be incomplete; enable debug logging for the full drain/close/collision diagnostics',
                problems.join('; ')
            );
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
        inspectorState:        { wasClosedUnexpectedly: boolean, closeInfo: InspectorCloseInfo, duplicateFoundIdCount: number },
        coverageAnalysis:       CoverageAnalysis | undefined
    ): Promise<DryRunResult> {
        // 13. Collect and remap coverage data
        const { coverage: mutantCoverage, inspectorIdToProjectFile, coverageKeys } = await this.collectAndRemapCoverage(testHierarchy, executionOrder);

        // 14. Build test results from inspector data: one result per test. A retried
        // test is started once per attempt, so its id repeats in executionOrder; its
        // coverage keys are already merged into one entry under its one name.
        const { tests, testNameIndex } = this.buildTestsFromInspector(testHierarchy, [...new Set(executionOrder)], parsed, totalElapsedMs, inspectorIdToProjectFile);

        // Sort tests by name to ensure consistent order across runs
        // This is critical for Stryker's incremental mode - test IDs are assigned
        // based on order, so inconsistent order breaks coveredBy correlation
        tests.sort((a, b) => a.name.localeCompare(b.name));

        // Completeness gate — run AFTER tests are built (so it can see whether the run
        // otherwise looks GREEN, and compare them with the coverage) but BEFORE persisting
        // the registry below: a gated run must never let other Stryker workers load a
        // corrupted/partial registry via loadRegistryFile().
        const facts: DryRunCompletenessFacts = {
            executionOrder,
            testHierarchy,
            summary:               { passed: parsed.summaryPassed, skipped: parsed.summarySkipped, todo: parsed.summaryTodo, printed: parsed.summaryPrinted },
            coverageKeys,
            coveredTestIds:        Object.keys(mutantCoverage?.perTest ?? {}),
            resultTestIds:         tests.map(t => t.id),
            duplicateFoundIdCount: inspectorState.duplicateFoundIdCount,
        };
        const gateResult = this.checkCompletenessGate(facts, parsed.summaryFailed, inspectorState.wasClosedUnexpectedly, tests, inspectorState.closeInfo, result.stderr);
        if(gateResult) {
            return gateResult;
        }

        // Like the gate, before the registry is persisted: a dry run failed for missing
        // coverage must not leave a registry behind for other workers.
        const coverageResult = this.checkCoverageData(mutantCoverage, tests, coverageAnalysis, result.stderr);
        if(coverageResult) {
            return coverageResult;
        }

        // Cache test names and persist registry for killedBy resolution in mutantRun
        await this.buildAndPersistTestRegistry(tests, testNameIndex);

        this.warnOnUnidentifiedDryRunFailure(result, parsed, tests);
        this.warnOnTightDryRunTimeout(totalElapsedMs);

        return {
            status: DryRunStatus.Complete,
            tests,
            mutantCoverage,
        };
    }

    /**
   * Judge the dry run's mutant coverage before it is handed to Stryker.
   *
   * Stryker treats `mutantCoverage: undefined` as "no coverage analysis": every
   * mutant then runs the FULL suite (mutant-test-planner's no-coverage branch),
   * with no message saying why. The coverage preload writes the coverage file in
   * its final afterAll on every dry run — even one that covered nothing writes a
   * line with empty perTest/static — so a dry run that completed without one
   * means the preload never ran, could not write (it logs a `[Stryker Coverage]`
   * line on the child's stderr), or the child exited before that afterAll.
   *
   * - coverageAnalysis 'perTest': the user asked for per-test coverage, and
   *   silently running the full suite per mutant can turn a run of minutes into
   *   hours — fail the dry run (Error), naming the file and likely causes.
   *   'all'/'off' remain available to run without it.
   * - 'all' (or unknown): warn with the same explanation; the run is correct, only slower.
   * - 'off': Stryker wants no coverage; say nothing.
   * A dry run with failed tests is left alone: Stryker stops on those anyway,
   * and its failed-test report is the more useful message.
   *
   * When coverage exists but covers no mutant at all, every mutant will be
   * NoCoverage (Stryker's executeNoCoverage) — warn, since that is a legitimate
   * outcome only when the tests really never touch the mutated files.
   *
   * `[Stryker Coverage]` diagnostics from the preload are otherwise dropped on a
   * green run (the child's stderr is only shown on failure), so they are
   * surfaced at warn here, or folded into the missing-coverage message.
   */
    private checkCoverageData(
        coverage:         MutantCoverage | undefined,
        tests:            readonly RunnerTestResult[],
        coverageAnalysis: CoverageAnalysis | undefined,
        stderr:           string
    ): DryRunResult | null {
        const preloadLines = extractPreloadCoverageDiagnostics(stderr);
        const coverageMissing = coverage === undefined && coverageAnalysis !== 'off';
        if(!coverageMissing || tests.some(t => t.status === TestStatus.Failed)) {
            if(preloadLines.length > 0) {
                this.logger.warn('The coverage preload reported problems on the dry-run child\'s stderr:\n%s', preloadLines.join('\n'));
            }
            if(coverage !== undefined && coverageAnalysis !== 'off' && !coversAnyMutant(coverage)) {
                this.logger.warn(
                    'The dry run\'s coverage data shows no mutant covered by any test, per test or statically, so Stryker will report every mutant as NoCoverage. '
                    + 'Check that the mutate globs (%s) match the source files your tests import, and that the tests import those files rather than a built copy (e.g. dist/).',
                    this.mutateGlobs.join(', ') || '(none)'
                );
            }
            return null;
        }

        const coverageDir = this.coverageFilePath === undefined ? tmpdir() : path.dirname(this.coverageFilePath);
        const parts = [
            `stryker-bun-runner: the dry run produced no mutant coverage data — the coverage file ${this.coverageFilePath ?? '(none configured)'} was missing, unreadable or empty. `
            + 'Without it Stryker runs the full test suite for every mutant, which is far slower than running each mutant\'s covering tests. '
            + 'Likely causes: the coverage preload never ran (check for a [test].preload in bunfig.toml or bun.bunArgs that replaces or bypasses it), '
            + `${coverageDir} is not writable, or the bun test child exited before its final afterAll hook wrote the file (e.g. a test calls process.exit).`,
        ];
        if(coverageAnalysis === 'perTest') {
            parts.push('Failing the dry run because coverageAnalysis is \'perTest\'; set coverageAnalysis to \'all\' or \'off\' to run without per-test coverage instead.');
        }
        if(preloadLines.length > 0) {
            parts.push(`Coverage preload diagnostics from the child's stderr:\n${preloadLines.join('\n')}`);
        }
        const message = parts.join(' ');

        if(coverageAnalysis === 'perTest') {
            this.logger.error('%s', message);
            return { status: DryRunStatus.Error, errorMessage: message };
        }
        this.logger.warn('%s', message);
        return null;
    }

    /**
   * Warn when a completed dry run used more than {@link DRY_RUN_TIMEOUT_WARN_RATIO}
   * of bun.timeout. bun.timeout now governs only the dry run (mutant runs follow
   * Stryker's per-mutant timeout), so this is the one place a too-small value
   * bites: the next, slightly slower dry run is killed. Called once, from the
   * Complete path of the single dry run.
   */
    private warnOnTightDryRunTimeout(elapsedMs: number): void {
        if(elapsedMs > this.timeout * DRY_RUN_TIMEOUT_WARN_RATIO) {
            this.logger.warn(
                'The dry run took %dms, more than 80%% of bun.timeout (%dms). bun.timeout bounds the dry run (mutant runs use Stryker\'s per-mutant timeout instead); a dry run that outgrows bun.timeout plus the drain-handshake allowance is killed — raise bun.timeout',
                elapsedMs,
                this.timeout
            );
        }
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
            // No identity entry for an already-suffixed id: resolveKilledBy tests
            // cachedTestNames.has(name) before it consults this index, and every id is in
            // cachedTestNames, so a suffixed name can never reach a lookup here.
        }
        // Stryker disable next-line StringLiteral: diagnostic logging message
        this.logger.debug('Cached %d test names from dry run for killedBy resolution', this.cachedTestNames.size);

        // Keep the exact-name index on the instance BEFORE attempting the write
        // (mirrors cachedTestNames) so this worker's own mutantRuns can use it
        // even when the registry file write below fails.
        this.testNameIndex = testNameIndex;
        this.testFileDurations = sumDurationsByFile(tests);
        this.logger.debug('Recorded dry-run durations for %d test file(s) to order mutant runs cheapest-first', this.testFileDurations.size);

        try {
            // registryPath lives in the run's private temp directory, resolved (created/verified)
            // now rather than reused from init (cwd may differ from init's). Safe to call
            // concurrently: an existing directory is re-verified, not an error.
            const registryPath = await this.resolveRegistryPath();
            const tmpPath = `${registryPath}.tmp`;
            const registryData = JSON.stringify({
                version:           2,
                writtenAt:         Date.now(),
                // Stryker disable next-line ArrayDeclaration: equivalent mutant — prepending "Stryker was here" leaves all real test names in place; killedBy resolution is unaffected
                cachedTestNames:   [...this.cachedTestNames],
                baseNameIndex:     [...this.baseNameIndex.entries()],
                testNameIndex:     [...testNameIndex.entries()],
                // Omitted (JSON drops undefined) when Stryker selected no files.
                testFiles:         this.selectedTestFilesFor(process.cwd()),
                testFileDurations: [...this.testFileDurations.entries()],
            } satisfies RegistryFileV2);
            // The tmp file is created owner-only and exclusively, replacing anything at its path.
            await writePrivateFile(tmpPath, registryData);
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
            this.warnRegistryWriteFailed(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Warn that the dry-run registry could not be written. The registry also carries
     * Stryker's testFiles selection, so when one is active the warning adds that other
     * workers will not see it and fall back to bun.testFiles or auto-discovery.
     */
    private warnRegistryWriteFailed(message: string): void {
        if(this.selectedTestFilesFor(process.cwd()) === undefined) {
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.logger.warn('Failed to write dryRun registry file: %s', message);
            return;
        }
        this.logger.warn(
            'Failed to write dryRun registry file: %s. Stryker\'s testFiles option is active, so other workers will not see the selection '
            + 'and will fall back to bun.testFiles or auto-discovery for full-suite runs.',
            message
        );
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
            this.mutantWarnings.warn(MUTANT_WARN_KIND.noRegistry, mutantId, 'Mutant %s: no exact-name registry available — all %d covering-test pattern alternatives use lossy reconstruction; tests with " > " in their titles may be silently dropped', mutantId, filterIds.length);
            return;
        }
        const missed = filterIds.filter(id => !exactNameIndex.has(id));
        if(missed.length > 0) {
            this.mutantWarnings.warn(
                MUTANT_WARN_KIND.registryMiss,
                mutantId,
                'Mutant %s: %d of %d testFilter ids missing from exact-name registry (lossy fallback; " > " titles among them may be silently dropped): %s%s',
                mutantId,
                missed.length,
                filterIds.length,
                missed.slice(0, 5).join(', '),
                missed.length > 5 ? ', …' : ''
            );
        }
    }

    /**
   * Run tests with an active mutant
   */
    public async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
        // The time budget starts now, not at spawn: Stryker's own timer is already
        // running, and the registry load / bunfig / discovery below spend from it.
        const startedAt = Date.now();
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Running mutant run for mutant %s', options.activeMutant.id);

        // Stryker disable next-line ArrayDeclaration: equivalent mutant — options.testFilter is always a non-null array in all tests; ?? fallback never fires, so ['Stryker was here'] = [] in practice
        const requestedFilter = options.testFilter ?? [];

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
            await this.loadRegistryFile(options.activeMutant.id);
        }

        // Stryker's own `testFiles` option fills testFilter with test FILE paths, not
        // ids. Such a run is scoped by file (no --test-name-pattern) and its filter
        // carries no ids, so everything below that works from ids sees an empty filter.
        const testFileScope = await this.resolveTestFileFilter(requestedFilter);
        if(testFileScope !== undefined) {
            this.logger.debug('Mutant %s: testFilter holds %d test file path(s) (Stryker\'s testFiles option); running those files without a --test-name-pattern', options.activeMutant.id, testFileScope.length);
        }
        const filterIds = testFileScope === undefined ? requestedFilter : [];

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
        // Sequential mode (--max-concurrency=1) is required to match dryRun's serialized
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
        const sanitizedBunfig = (this.sanitizedBunfigPath && this.sanitizedBunfigCwd === mutantCwd)
            ? this.sanitizedBunfigPath
            : await this.ensureSanitizedBunfig();
        // Mutant runs never randomize the test order: a bunfig that does gets its mutant-run copy.
        const bunfigPath = this.sanitizedBunfigRandomizes ? mutantRunBunfigPath(sanitizedBunfig) : sanitizedBunfig;
        this.logRandomizeOffOnce();

        // Reuse the sorted test-file list cached during dryRun.
        // If this worker never ran dryRun (cachedTestFiles is undefined), discover
        // the files now and cache them for subsequent mutantRun calls on this worker.
        // The files Stryker's testFiles option selected (kept from this worker's dryRun, or
        // loaded from the shared registry above) and then bun.testFiles are used directly
        // without globbing; either way this is the list every "run all tests" fallback uses.
        this.effectiveTestFiles = await this.getOrDiscoverTestFiles();

        // Kill limit: Stryker's per-mutant timeout less a margin, so the runner reports
        // the Timeout itself before Stryker's TimeoutDecorator fires and restarts the
        // worker. Stryker sizes options.timeout from the dry-run time of exactly the
        // tests it planned (the covering tests, or the full suite for a static mutant),
        // so it is the principled limit; bun.timeout only governs the dry run, and is
        // the fallback when Stryker supplies no timeout.
        const strykerTimeoutMs = isUsableTimeout(options.timeout) ? options.timeout : undefined;
        const limitMs = strykerTimeoutMs === undefined ? this.timeout : limitFromStrykerTimeout(strykerTimeoutMs);

        const result = await this.executeMutantRun({
            options,
            bunfigPath,
            localRegistry,
            localBaseIndex,
            coveringTestCount: filterIds.length,
            deadline:          startedAt + limitMs,
            strykerTimeoutMs,
            testFileScope,
        }, testNamePattern, this.resolveCoveringTestFiles(filterIds));
        this.mutantRunsByStatus[result.status]++;
        return result;
    }

    /**
   * Recognise a testFilter that is a list of test FILES rather than test ids.
   *
   * Stryker core's own `testFiles` option (9.6+, also 10) makes the mutant
   * planner give static and no-coverage mutants `testFilter =
   * project.testFiles.map(sandbox.sandboxFileFor)` — absolute paths of test files
   * inside the sandbox (mutant-test-planner.js, verified on 10.0.0) — instead of
   * undefined. Treated as ids they build a --test-name-pattern that matches
   * nothing, forcing a full-suite retry whose deadline kill is then (wrongly)
   * scored as an inconclusive Error. They are the opposite of covering tests:
   * Stryker sized the timeout for exactly these files, so they run as given.
   *
   * Every entry must pass all of: not a known test id (the dry-run registry
   * wins), ends in a test-file suffix, and names an existing regular file
   * (resolved against the cwd when relative). One failing entry — or an empty
   * filter — means this is an ordinary id filter and the answer is undefined.
   * The checks are ordered so a normal id filter costs no I/O.
   *
   * @returns The distinct files, sorted, as Stryker gave them; undefined when
   *          the filter is not a file list
   */
    private async resolveTestFileFilter(filter: readonly string[]): Promise<string[] | undefined> {
        if(filter.length === 0) {
            return undefined;
        }
        const entries = [...new Set(filter)];
        const looksLikeFile = (entry: string): boolean => !this.cachedTestNames?.has(entry) && TEST_FILE_SUFFIX_RE.test(entry);
        if(!entries.every(entry => looksLikeFile(entry))) {
            return undefined;
        }
        const cwd = process.cwd();
        const exist = await Promise.all(entries.map(async (entry) => {
            try {
                const stat = await fsPromises.stat(path.resolve(cwd, entry));
                return stat.isFile();
            } catch{
                return false;
            }
        }));
        return exist.every(Boolean) ? entries.toSorted((a, b) => a.localeCompare(b)) : undefined;
    }

    /**
   * Spawn bun for a mutant run and interpret the result. Extracted from
   * mutantRun so that a --test-name-pattern which matched 0 tests can retry
   * once with the full suite (testNamePattern undefined) while reusing the
   * SAME localRegistry/localBaseIndex built from the original testFilter for
   * killedBy resolution — avoiding both a false Killed and redundant setup.
   * The retry always recurses with testNamePattern undefined, so the retry
   * gate's first conjunct is false on that call: recursion is bounded to
   * depth 1 by construction, never a retry-of-a-retry. The retry spends what is
   * left of the same deadline, because Stryker's timer covers both spawns.
   */
    private async executeMutantRun(
        ctx:                MutantRunContext,
        testNamePattern:    string | undefined,
        coveringTestFiles?: string[]
    ): Promise<MutantRunResult> {
        const { options, bunfigPath, localRegistry, localBaseIndex } = ctx;
        this.countFullSuiteFallback(testNamePattern, ctx.coveringTestCount);
        // Tracked on `this` so dispose() can kill an orphaned child if this runner
        // is disposed while a mutant run is still in flight — mirrors dryRun().
        const abortController = new AbortController();
        this.currentAbortController = abortController;
        // Per spawn, so neither a retry nor a later run can accept another child's report.
        const hitLimitToken = newHitLimitToken();
        // Narrowed to the covering tests' own files when the run is targeted; the full
        // list whenever it is not, or whenever the narrowing cannot be proven safe (see
        // resolveCoveringTestFiles). A file-scoped run (Stryker's testFiles option) runs
        // exactly its files, whatever was discovered. Either way cheapest first.
        // Then kept within the argv budget: see fitTestFiles.
        const ordered = this.orderCheapestFirst(ctx.testFileScope ?? (testNamePattern === undefined ? this.effectiveTestFiles : (coveringTestFiles ?? this.effectiveTestFiles)));
        const testFiles = this.fitTestFiles(ordered, ctx.testFileScope === undefined ? this.explicitTestFilesSource(process.cwd()) : 'Stryker\'s testFiles option');
        let result;
        try {
            result = await runBunTests({
                bunPath:               this.bunPath,
                // The 1 ms floor only matters once the deadline has passed (a retry after a slow first spawn).
                timeout:               Math.max(1, ctx.deadline - Date.now()),
                env:                   this.env,
                bunArgs:               this.mutantBunArgs, // No --randomize/--seed: see stripRandomizeArgs
                bunfigPath,
                activeMutant:          options.activeMutant.id,
                hitLimit:              options.hitLimit, // Arms the instrumenter's infinite-loop protection in the preload
                hitLimitToken, // The preload signs its hit-limit report with it; see readReportedHitCount
                bail:                  !options.disableBail, // Bail on first failure unless Stryker's disableBail is set
                sequentialMode:        true,            // Match dryRun's serialized execution for deterministic results
                preloadScript:         this.preloadScriptPath, // Needed to set globalThis.__stryker__.activeMutant
                testNamePattern, // undefined → no filter → full suite (current behaviour)
                testFiles,
                signal:                abortController.signal,
                smol:                  this.smol,
                maxChildRss:           this.maxChildRss,
                rssCheckIntervalMs:    this.rssCheckIntervalMs,
                maxSpawnDepth:         this.maxSpawnDepth,
                onMemoryLimitExceeded: (rssBytes: number) => {
                    this.mutantWarnings.warn(
                        MUTANT_WARN_KIND.memoryLimit,
                        options.activeMutant.id,
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

        const runawayResult = this.classifyRunawayMutantRun(result, ctx, testNamePattern, hitLimitToken);
        if(runawayResult) {
            return runawayResult;
        }

        // The child failed to spawn (ENOENT, EACCES, …): bun test never ran, so exitCode is
        // null and means nothing. Policy: Killed only when a failing test is seen — never
        // score a run that executed no tests as a kill.
        if(result.spawnError !== undefined) {
            const errorMessage = formatSpawnErrorMessage(result.spawnError);
            this.mutantWarnings.warn(MUTANT_WARN_KIND.spawnError, options.activeMutant.id, 'Mutant %s: %s — scoring as Error rather than Killed', options.activeMutant.id, errorMessage);
            return { status: MutantRunStatus.Error, errorMessage };
        }

        // With the run's files, so a header-shaped line in a failure message cannot rename the failing test.
        const parsed = parseBunTestOutput(result.stdout, result.stderr, testFiles);

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
                this.mutantWarnings.warn(
                    MUTANT_WARN_KIND.zeroMatchRetry,
                    options.activeMutant.id,
                    'Mutant %s: --test-name-pattern matched 0 tests — usually a runner pattern gap or a mutant that changed an interpolated test title (it.each); retrying once with the full suite',
                    options.activeMutant.id
                );
                return this.executeMutantRun(ctx, undefined);
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
     * Count a spawn that had covering tests but no pattern: it runs the whole suite instead of
     * just those tests, because the pattern was too long for argv or because this is the retry
     * of a zero-match pattern. A mutant gets at most one such spawn (the retry never retries),
     * so this counts mutants.
     */
    private countFullSuiteFallback(testNamePattern: string | undefined, coveringTestCount: number): void {
        if(testNamePattern === undefined && coveringTestCount > 0) {
            this.fullSuiteFallbacks++;
        }
    }

    /**
   * The verdict for a mutant run that ran away — it exceeded Stryker's hit limit,
   * or the runner had to kill it — or undefined for a run that ended on its own.
   */
    private classifyRunawayMutantRun(
        result:          BunProcessResult,
        ctx:             MutantRunContext,
        testNamePattern: string | undefined,
        hitLimitToken:   string
    ): MutantRunResult | undefined {
        // Stryker's infinite-loop protection: past its hitLimit the instrumenter throws
        // out of the mutant's loop, and the preload reports the count on stderr. That
        // is conclusive whatever happened next — the error failed a test (which would
        // read as Killed), a test swallowed it (Survived), or the run was killed anyway
        // — so, as in Stryker's own runners, it is scored Timeout with Stryker's reason.
        const hitLimitTimeout = determineHitLimitReached(readReportedHitCount(result.stderr, hitLimitToken), ctx.options.hitLimit);
        if(hitLimitTimeout) {
            return toMutantRunResult(hitLimitTimeout);
        }

        if(!result.timedOut) {
            return undefined;
        }

        // A full-suite FALLBACK run (the covering tests' pattern was too long, or
        // matched nothing and this is the retry) killed at a Stryker-derived limit
        // proves nothing: Stryker sized that budget for the covering tests only, so
        // a merely slow full suite and a hanging mutant look identical. Scoring it
        // Timeout would count it as detected. The runner cannot buy the full suite
        // more time — Stryker's TimeoutDecorator fires at options.timeout no matter
        // what the runner does — so it reports Error (excluded from the score). A
        // maxChildRss kill is evidence of a runaway either way and stays Timeout, as
        // does a kill at bun.timeout, which is documented as a full-suite limit.
        const isFullSuiteFallback = testNamePattern === undefined && ctx.coveringTestCount > 0;
        if(isFullSuiteFallback && ctx.strykerTimeoutMs !== undefined && result.memoryLimitExceeded !== true) {
            return this.buildInconclusiveFallbackTimeout(ctx.options.activeMutant.id, ctx.coveringTestCount, ctx.strykerTimeoutMs);
        }
        this.logger.debug('Mutant run timed out');
        return {
            status: MutantRunStatus.Timeout,
        };
    }

    /**
   * Error result for a full-suite fallback run killed at the limit derived from
   * Stryker's per-mutant timeout — see classifyRunawayMutantRun.
   */
    private buildInconclusiveFallbackTimeout(mutantId: string, coveringTestCount: number, strykerTimeoutMs: number): MutantRunResult {
        const errorMessage = `the full-suite fallback run (used because this mutant's ${coveringTestCount} covering test(s) could not be run by --test-name-pattern) was stopped at the limit derived from Stryker's ${strykerTimeoutMs} ms per-mutant timeout, which Stryker sized for those ${coveringTestCount} covering test(s), not the full suite; a slow full suite and a hanging mutant look the same here, so this is not scored as a Timeout`;
        this.mutantWarnings.warn(MUTANT_WARN_KIND.inconclusiveTimeout, mutantId, 'Mutant %s: inconclusive timeout, scoring as Error rather than Timeout: %s', mutantId, errorMessage);
        return { status: MutantRunStatus.Error, errorMessage };
    }

    /**
   * Build the MutantRunResult for a killed mutant (non-zero exit code).
   * Handles runtime error detection and killedBy resolution.
   */
    private buildMutantKilledResult(
        result:         { exitCode: number | null, signal?: NodeJS.Signals | null, stdout: string, stderr: string },
        parsed:         Pick<ParsedTestResults, 'tests' | 'totalTests' | 'failed' | 'summaryErrors'>,
        localRegistry:  Set<string>,
        localBaseIndex: Map<string, string[]>,
        mutantId:       string
    ): MutantRunResult {
        const rawFailedNames = parsed.tests
            .filter(test => test.status === 'failed')
            .map(test => normalizeTestName(test.name));

        // A child that died from a signal (SIGSEGV, SIGABRT, an external SIGKILL…) proves
        // nothing about the mutant unless the output ALSO shows a failing test that we can
        // attribute: a crash is Killed only with that evidence, otherwise it is an Error
        // naming the signal. This path is only reached for runs the runner did not kill
        // itself — executeMutantRun returns Timeout for result.timedOut first, which also
        // covers the maxChildRss kill — so any signal seen here is the child's own.
        if(result.signal && rawFailedNames.length === 0) {
            return this.buildSignalErrorResult(result, mutantId, `bun test terminated by ${result.signal} before any test reported a failure`);
        }

        // No individual test failed: decide whether bun still reported a failure (Killed)
        // or nothing at all (Error) — see classifyRunWithoutFailedTest.
        if(rawFailedNames.length === 0) {
            const noEvidenceResult = this.classifyRunWithoutFailedTest(result, parsed, mutantId);
            if(noEvidenceResult) {
                return noEvidenceResult;
            }
        }

        const killedBy = this.resolveKilledBy(rawFailedNames, localRegistry, localBaseIndex, mutantId);

        // Signal death with failing tests reported, but none attributable: still no evidence the
        // mutant (rather than the crash) caused it. Error, not an unattributable Killed.
        if(result.signal && killedBy.length === 0) {
            return this.buildSignalErrorResult(
                result,
                mutantId,
                `bun test terminated by ${result.signal}; the ${rawFailedNames.length} failing test(s) reported could not be attributed to a known test`
            );
        }

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
            this.mutantWarnings.warn(
                MUTANT_WARN_KIND.noKillerIdentified,
                mutantId,
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
            // Only failed tests carry a failureMessage (the parser collects error lines for nothing else).
            failureMessage: parsed.tests
                .map(test => test.failureMessage)
                .filter((msg): msg is string => !!msg)
                .join('\n\n') || `Tests failed with exit code ${result.exitCode}: ${stripAnsi(result.stderr).trim().slice(0, 1000)}`,
            nrOfTests: parsed.totalTests || 1,
        };
    }

    /**
   * Error result for a mutant run whose `bun test` child died from a signal
   * without attributable failing-test evidence — see buildMutantKilledResult.
   * Logged at warn (with the output head, like the unattributable-kill path) so
   * a crashing suite is visible rather than silently scored.
   */
    private buildSignalErrorResult(
        result:       { stdout: string, stderr: string },
        mutantId:     string,
        errorMessage: string
    ): MutantRunResult {
        this.mutantWarnings.warn(
            MUTANT_WARN_KIND.signalError,
            mutantId,
            'Mutant %s: %s — scoring as Error rather than Killed\n'
            + '--- STDOUT (first 600 chars) ---\n%s\n'
            + '--- STDERR (first 600 chars) ---\n%s',
            mutantId,
            errorMessage,
            result.stdout.slice(0, 600) || '(empty)',
            result.stderr.slice(0, 600) || '(empty)'
        );
        return { status: MutantRunStatus.Error, errorMessage };
    }

    /**
   * Classify a non-zero, non-signal, non-timeout mutant run in which no
   * individual test reported a failure. Returns an Error result when there is
   * no evidence the mutant was detected, or null to let the caller score it
   * Killed (with an empty killedBy, since no single test failed).
   *
   * Killed needs evidence that the suite failed, and bun's summary is that
   * evidence: a non-zero ' N fail' (or 'Bailed out after N failures') or
   * ' N error' count. That is exactly what bun prints when a test file cannot
   * load — its import graph throws (TypeError, ReferenceError, …), a source or
   * test file no longer parses, a describe body throws — as an "# Unhandled
   * error between tests" block with no `(fail)` line. Verified on bun 1.4.2: a
   * source module that throws at import gives ' 1 fail' + ' 1 error'; a
   * describe body that throws gives ' 0 fail' + ' 1 error'; under --bail both
   * the throwing import and a source syntax error give 'Bailed out after 1
   * failure'. Stryker's jest and vitest runners score a test file that fails to
   * load as Killed too, and a whole class of mutants (module-level constants,
   * config objects) can only ever be detected this way.
   *
   * Why that is not a false Killed: a load failure in a test FILE and one in a
   * SOURCE file print the same shape, but under mutation only source files are
   * changed, and the dry run — which must pass, and which fails outright on any
   * unattributable fail/error count (see checkDryRunProcessResult and the
   * completeness gate's Signal C) — loaded every one of these files without
   * error. So a load failure seen here was caused by the active mutant. The
   * residual risk is a load failure that depends on which files run together:
   * a targeted run hands bun only the covering tests' files, so a test file
   * that only loads after some other file has run would fail here and not in
   * the dry run. That is a test-isolation defect the same way it is under jest.
   *
   * Error remains for the cases that are no evidence at all: bun's zero-match
   * --test-name-pattern error (a runner pattern gap, not a kill), and a run
   * whose output carries no failure count whatsoever (a missing preload, an
   * unparseable bunfig, a crash that printed no summary). An exit code alone is
   * not evidence that a test caught the mutant.
   */
    private classifyRunWithoutFailedTest(
        result:   { exitCode: number | null, stdout: string, stderr: string },
        parsed:   Pick<ParsedTestResults, 'failed' | 'summaryErrors'>,
        mutantId: string
    ): MutantRunResult | null {
        const stderr = result.stderr;

        // A zero-match --test-name-pattern that reaches here either exhausted
        // mutantRun's one-shot full-suite retry, or never had a Stryker-built
        // pattern to retry (an empty or mismatched covering-test list; -t in
        // bunArgs is rejected at init, so it cannot be the source).
        // Classify distinctly from the generic runtime-error messages below so
        // operators can tell a runner pattern gap apart from a real crash.
        // eslint-disable-next-line @typescript-eslint/prefer-includes -- kept as a RegExp (not includes()) to match the module-level ZERO_MATCH_TEST_PATTERN_RE declaration shared with executeMutantRun's retry gate; behaviorally identical for this literal pattern
        if(ZERO_MATCH_TEST_PATTERN_RE.test(stderr)) {
            // Stryker disable next-line StringLiteral: diagnostic logging message
            this.mutantWarnings.warn(
                MUTANT_WARN_KIND.zeroMatchNoRetry,
                mutantId,
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

        if(parsed.failed > 0 || parsed.summaryErrors > 0) {
            this.logger.debug(
                'Mutant %s: bun reported %d failure(s) and %d error(s) outside any single test (e.g. a test file that failed to load) — scoring Killed',
                mutantId,
                parsed.failed,
                parsed.summaryErrors
            );
            return null;
        }

        const output = (stripAnsi(stderr).trim() || stripAnsi(result.stdout).trim()).slice(0, 500) || '(no output)';
        this.mutantWarnings.warn(
            MUTANT_WARN_KIND.noEvidence,
            mutantId,
            'Mutant %s: bun test exited with code %s but reported no failing test and no fail/error count — scoring as Error rather than Killed: %s',
            mutantId,
            String(result.exitCode),
            output
        );
        return {
            status:       MutantRunStatus.Error,
            errorMessage: `bun test exited with code ${result.exitCode} but reported no failing test and no fail/error count, so there is no evidence a test detected this mutant: ${output}`,
        };
    }

    /**
   * Check for dry run process failures (timeout or non-zero exit).
   * Returns a DryRunResult to short-circuit if the process failed, or null to proceed.
   */
    private checkDryRunProcessResult(
        result:        { timedOut: boolean, memoryLimitExceeded?: boolean, exitCode: number | null, signal?: NodeJS.Signals | null, stderr: string, spawnError?: string },
        parsed:        { failed: number },
        testHierarchy: TestInfo[]
    ): DryRunResult | null {
        if(result.timedOut) {
            // A maxChildRss kill also sets timedOut; onMemoryLimitExceeded already warned about it.
            if(result.memoryLimitExceeded !== true) {
                // Stryker disable next-line StringLiteral: logging message only
                this.logger.warn(
                    'Dry run timed out: bun.timeout is %dms, and the dry-run child was killed at its %dms limit (bun.timeout plus the drain-handshake allowance) — raise bun.timeout above your full suite\'s run time',
                    this.timeout,
                    this.timeout + DRAIN_ACK_ABSOLUTE_CEILING_MS
                );
            }
            return { status: DryRunStatus.Timeout };
        }
        // A child 'error' event (exitCode and signal both null): name the spawn error rather
        // than "exit code null". Status semantics unchanged — still an Error.
        if(result.spawnError !== undefined) {
            return {
                status:       DryRunStatus.Error,
                errorMessage: `${formatSpawnErrorMessage(result.spawnError)}\n${result.stderr}`,
            };
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
            // A signal death has exitCode null; name the signal rather than "exit code null".
            // Status semantics are unchanged: still an Error (a dry run with no parsed
            // failures has no kill to score, so there is no Killed/Error policy question here).
            const messageParts = [result.signal
                ? `Bun test process terminated by signal ${result.signal}`
                : `Bun test process failed with exit code ${result.exitCode}`];
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
   * Diagnostic-only check for the Complete dry-run path: bun's console recap
   * reported a failed count (a non-zero exit always comes with one by this point) but nothing in the
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
        // Only `parsed.failed` is tested, not the exit code: this runs only after
        // checkDryRunProcessResult, which already returned an Error for any non-zero exit with
        // zero parsed failures, so a non-zero exit reaching here implies parsed.failed > 0.
        if(parsed.failed > 0 && !tests.some(t => t.status === TestStatus.Failed)) {
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
   * A dry run may only be reported Complete when every test bun ran, and every
   * per-test coverage key the preload recorded, is accounted for: bun's console
   * summary, the inspector's TestReporter events and the coverage keys must
   * agree EXACTLY (see src/dry-run-completeness.ts for each comparison and the
   * bun behaviour it accounts for). Any unexplained difference fails the dry
   * run (DryRunStatus.Error) with a message naming what was lost, the counts
   * and the likely cause: a Complete run built on lost or merged data would
   * hand Stryker coverage that is silently missing or credited to the wrong
   * tests, and loud failure is preferred to that.
   *
   * ONLY evaluated when the run otherwise looks GREEN (zero Failed entries in
   * the already-built `tests`): an already-failing dry run is handled by
   * {@link checkDryRunProcessResult} / {@link warnOnUnidentifiedDryRunFailure},
   * and Stryker stops on its failed tests anyway. That also keeps out hook
   * failures, which bun counts as failures with no inspector events.
   *
   * Besides the data-loss checks, it fails when bun's summary counts failing
   * tests but none of them could be attributed to a test (Signal C, below).
   *
   * `wasClosedUnexpectedly` is NEVER a trigger: bun closes the inspector socket
   * a few ms after the drain acknowledgment on healthy runs. It is added to the
   * message only as context once the gate has already fired.
   *
   * @returns A DryRunStatus.Error result if the gate fires, otherwise null.
   */
    private checkCompletenessGate(
        facts:                  DryRunCompletenessFacts,
        summaryFailed:          number,
        wasClosedUnexpectedly:  boolean,
        tests:                  readonly Pick<RunnerTestResult, 'status'>[],
        closeInfo:              InspectorCloseInfo,
        stderr:                 string
    ): DryRunResult | null {
        // Stryker disable next-line MethodExpression,EqualityOperator: equivalent — .some() vs .find()!==undefined would produce the same boolean; the guard itself (skip the gate when any built test already Failed) is covered by 'gate does not evaluate when built tests contain failures'
        if(tests.some(t => t.status === TestStatus.Failed)) {
            return null;
        }

        const reasons = findDryRunDataLoss(facts);

        // Signal C (unattributable failures): bun's own summary reported failing
        // test(s), yet not one of them survives into `tests` as Failed. The gate's
        // precondition above already returned when any failure WAS identified, so
        // reaching here with summaryFailed > 0 means the count and the per-test data
        // flatly disagree. Proceeding would report a dry run as Complete while
        // silently dropping every failure it contains — a suite with an unloadable
        // spec file then scores 100%.
        if(summaryFailed > 0) {
            // The stderr tail is included here rather than left to
            // warnOnUnidentifiedDryRunFailure: that warn is deliberately skipped once
            // the gate fires (see its 'does not double-message' test), and for this
            // signal stderr is the one datum that names the cause — the unresolvable
            // import, the throwing module — so it must ride along with the error.
            reasons.push(
                `bun's console summary reported ${summaryFailed} failing test(s), but none of them could be `
                + 'attributed to an individual test — a whole spec file that fails to load (e.g. an unresolvable '
                + `import) produces exactly this shape. Last 500 chars of stderr:\n${stderr.slice(-500)}`
            );
        }

        if(reasons.length === 0) {
            return null;
        }

        if(wasClosedUnexpectedly) {
            // closeInfo.code is undefined whenever the close event itself never carried a code
            // (e.g. the mock/test path, or a WebSocket implementation that omits it) — distinct
            // from a genuinely captured code (including 0), so this checks presence, not truthiness.
            const closeDetail = closeInfo.code === undefined
                ? 'close code/reason not captured'
                : `close code=${closeInfo.code} reason=${JSON.stringify(closeInfo.reason ?? '')} wasClean=${String(closeInfo.wasClean)}, ${String(closeInfo.msFromLastFrameToClose)}ms after the last received frame`;
            reasons.push(`the inspector WebSocket also closed unexpectedly (${closeDetail}), which is routine on its own and listed only as context`);
        }

        const errorMessage
            = 'stryker-bun-runner: dry run data-completeness check failed — '
              + `${reasons.join('; ')}. Completing this dry run would hand Stryker test results or coverage that are silently `
              + 'missing or credited to the wrong tests, so it is reported as an error instead, and the test registry has NOT '
              + 'been persisted. If a cause named above is in your test suite, fix it there; otherwise re-run the dry run, and '
              + 'if this recurs, please report it at https://github.com/hughescr/stryker-bun-runner/issues with this message, '
              + 'your bun version and a debug log (logLevel: \'debug\').';

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
        coverageKeys:             CoverageKeyCounts | undefined
    }> {
        const testMap = new Map(testHierarchy.map(t => [t.id, t]));

        // A wholly-absent coverage file (no path configured, or the child crashed before
        // its afterAll write) has no keys for the completeness gate to count, so
        // coverageKeys is undefined. It is judged separately, by checkCoverageData: Stryker
        // would otherwise silently run the full suite for every mutant.
        if(!this.coverageFilePath) {
            return { coverage: undefined, inspectorIdToProjectFile: new Map(), coverageKeys: undefined };
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
            return { coverage: undefined, inspectorIdToProjectFile: new Map(), coverageKeys: undefined };
        }

        // Map coverage counter keys to full test names and extract the inspector-ID → project-file
        // mapping in a single pass. The new file-prefixed format ("relativeFile@@test-N") produces
        // a populated inspectorIdToProjectFile; legacy keys ("test-N") and unknown formats return
        // an empty map so the runner falls back to testInfo.url-based naming.
        const { coverage, inspectorIdToProjectFile, counterKeyToTestName, rawKeyCount, orphanedKeyCount } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testMap, this.logger);

        // No length guard: with no lateHits, emitCoverageBleedWarnings logs nothing.
        this.emitCoverageBleedWarnings(lateHits, counterKeyToTestName);

        return { coverage, inspectorIdToProjectFile, coverageKeys: { keyCount: rawKeyCount, unmatchedKeyCount: orphanedKeyCount } };
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
        this.mutantWarnings.warn(
            MUTANT_WARN_KIND.unresolvedKilledBy,
            mutantId,
            'Mutant %s: %d failed test name(s) could not be resolved to dry-run test ids and will not be recorded in killedBy — this mutant\'s Killed verdict will not be reusable from the incremental cache: %s%s',
            mutantId,
            unresolved.size,
            sample.slice(0, 5).join(', '),
            sample.length > 5 ? ', …' : ''
        );
    }

    /**
     * Log the one-line end summary (at info): this worker's mutant runs by outcome and how many
     * of them ran the full suite as a fallback. Nothing is logged for a worker that ran no
     * mutant, and the tallies restart afterwards so a second dispose() does not repeat the line.
     */
    private logMutantRunSummary(): void {
        const counts = this.mutantRunsByStatus;
        const total = counts.killed + counts.survived + counts.timeout + counts.error;
        if(total === 0) {
            return;
        }
        this.logger.info(
            'Mutant runs on this worker: %d (killed %d, survived %d, timeout %d, error %d); full-suite fallbacks: %d',
            total,
            counts.killed,
            counts.survived,
            counts.timeout,
            counts.error,
            this.fullSuiteFallbacks
        );
        this.mutantRunsByStatus = emptyMutantRunCounts();
        this.fullSuiteFallbacks = 0;
    }

    /**
   * Cleanup resources
   *
   * Removes only this worker's own files. The registry, and so the run's private
   * temp directory holding it, is deliberately left in place: Stryker gives a
   * worker no signal that it is the last one, and maxTestRunnerReuse /
   * crash recovery dispose a worker mid-run and start a fresh process that must
   * still find the registry (with concurrency 1, the disposing worker IS the
   * only one, so a "last one out" check would delete it from under its successor).
   */
    public async dispose(): Promise<void> {
        // Stryker disable next-line StringLiteral: logging message only
        this.logger.debug('Disposing BunTestRunner');

        // Summaries first: a cleanup failure below must not swallow them.
        this.logMutantRunSummary();
        this.mutantWarnings.flush();

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
