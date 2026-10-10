/**
 * Testable logic extracted from coverage-preload.ts
 *
 * This file contains pure functions that can be tested independently
 * of the runtime environment. The actual preload script imports and
 * uses these functions.
 */

import { appendFileSync, closeSync, constants, createReadStream, openSync, writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { CoverageFileData, LateHitEntry } from './types.js';

// Re-exported so the coverage-preload template — which imports everything it
// needs from this module via the `__PRELOAD_LOGIC_PATH__` placeholder — can
// reference the type without a second relative import that wouldn't resolve
// correctly once the template is copied to its temp-dir location.
export type { LateHitEntry } from './types.js';

/**
 * The node:fs functions the preload calls, captured when this module loads,
 * which is before any test file runs.
 *
 * The preload runs inside the suite's own process, and test suites spy on
 * node:fs (`spyOn(fs, 'appendFileSync')`). Called through the live ESM import
 * binding, a spy a test leaves installed would swallow the coverage write in
 * the preload's final afterAll, with no error — the dry run would then find no
 * coverage file. Calls go through this object instead; this module's own
 * tests spy on it, not on node:fs.
 */
export const preloadFs = { appendFileSync, closeSync, openSync, writeSync };

/**
 * The `__stryker__` global shared with Stryker-instrumented code. Field names
 * are the instrumenter's (INSTRUMENTER_CONSTANTS in @stryker-mutator/api/core).
 */
export interface StrykerNamespace {
    mutantCoverage?: MutantCoverage
    currentTestId?:  string
    activeMutant?:   string
    /** Hits of the active mutant so far; the instrumenter only counts (and limits) while this is defined. */
    hitCount?:       number
    /** The instrumenter throws once {@link hitCount} exceeds this. */
    hitLimit?:       number
}

// ============================================================================
// Configuration
// ============================================================================

export interface PreloadConfig {
    syncPort?:      string
    coverageFile?:  string
    activeMutant?:  string
    /** Stryker's hit limit for the active mutant (mutant runs only), see {@link installHitLimit}. */
    hitLimit?:      number
    /** This run's secret for signing the hit-limit sentinel, see {@link formatHitLimitSentinel}. */
    hitLimitToken?: string
}

/** Env var carrying the per-run token the hit-limit sentinel must include. */
export const HIT_LIMIT_TOKEN_ENV = '__STRYKER_HIT_LIMIT_TOKEN__';

export function getPreloadConfig(): PreloadConfig {
    return {
        syncPort:      process.env.__STRYKER_SYNC_PORT__,
        coverageFile:  process.env.__STRYKER_COVERAGE_FILE__,
        activeMutant:  process.env.__STRYKER_ACTIVE_MUTANT__,
        hitLimit:      parseHitLimit(process.env.__STRYKER_HIT_LIMIT__),
        hitLimitToken: process.env[HIT_LIMIT_TOKEN_ENV],
    };
}

/**
 * Parse the `__STRYKER_HIT_LIMIT__` value. Stryker computes the limit as 100 ×
 * the mutant's dry-run hit count, so anything other than a positive integer
 * means no usable limit — and no limit is the safe reading: it can only cost
 * time, never misreport a mutant.
 */
export function parseHitLimit(raw: string | undefined): number | undefined {
    const limit = Number(raw);
    return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

export function shouldCollectCoverage(config: PreloadConfig): boolean {
    return !config.activeMutant && !!config.coverageFile;
}

// ============================================================================
// Stryker Namespace Initialization
// ============================================================================

export function initializeStrykerNamespace(globalObj: Record<string, unknown>): StrykerNamespace {
    const g = globalObj as { __stryker__?: StrykerNamespace, __mutantCoverage__?: MutantCoverage };
    // Stryker disable next-line ObjectLiteral: structure verified by tests; line 61 fallback is only for existing __stryker__ without coverage
    g.__stryker__ ??= { mutantCoverage: { 'static': {}, perTest: {} } };
    const strykerGlobal = g.__stryker__;
    strykerGlobal.mutantCoverage ??= { 'static': {}, perTest: {} };
    g.__mutantCoverage__ = strykerGlobal.mutantCoverage;
    return strykerGlobal;
}

export function setActiveMutant(strykerNamespace: StrykerNamespace, activeMutant: string): void {
    strykerNamespace.activeMutant = activeMutant;
}

// ============================================================================
// Hit limit (Stryker's infinite-loop protection)
// ============================================================================

/**
 * Marker the preload writes on the child's stderr when the active mutant
 * exceeds its hit limit; the runner (bun-test-runner.ts) reads it back and
 * scores the mutant as a Timeout.
 */
export const HIT_LIMIT_SENTINEL = '__STRYKER_HIT_LIMIT_REACHED__';

/**
 * The stderr line reporting `hitCount`. It starts with a newline because bun
 * may have just written a partial line, and the runner only accepts the
 * sentinel at the start of a line.
 *
 * `token` is the random secret the runner generated for this run and passed in
 * {@link HIT_LIMIT_TOKEN_ENV}. The runner only accepts a sentinel carrying it, so
 * test output that happens to print a sentinel-shaped line cannot turn a
 * surviving mutant into a Timeout.
 */
export function formatHitLimitSentinel(token: string, hitCount: number): string {
    return `\n${HIT_LIMIT_SENTINEL} ${token} ${hitCount}\n`;
}

/**
 * Arm the instrumenter's hit limit for this (single-mutant) process.
 *
 * Instrumented code calls `stryMutAct_9fa48(id)` at every mutant switch; for
 * the active mutant it does `if (ns.hitCount !== void 0 && ++ns.hitCount >
 * ns.hitLimit) throw new Error('Stryker: Hit count limit reached (…)')`. So
 * setting `hitCount = 0` and `hitLimit` here is all it takes for a mutant that
 * loops forever to throw out of its loop within ~100 × its dry-run hits instead
 * of spinning until the runner's timeout.
 *
 * The thrown error alone is not enough for the runner: the test may catch it,
 * and a failing test would otherwise be scored Killed. So the runner also needs
 * the count, and it needs it even though, under `--bail`, bun exits on the
 * first failure without running afterAll hooks or process 'exit' handlers
 * (verified with bun 1.4.2). `hitCount` is therefore an accessor whose setter
 * reports the first hit past the limit synchronously, from inside the
 * instrumenter's own `++ns.hitCount`, before the error is even thrown.
 *
 * @param token - This run's sentinel token, see {@link formatHitLimitSentinel}.
 * @param report - Receives {@link formatHitLimitSentinel}'s line once; defaults
 *   to a synchronous write to fd 2, which nothing in bun buffers or drops.
 */
export function installHitLimit(
    strykerNamespace: StrykerNamespace,
    hitLimit: number,
    token: string,
    report: (line: string) => void = (line) => {
        // eslint-disable-next-line n/no-sync -- must reach stderr before bun's bail exit, which runs no async work
        preloadFs.writeSync(2, line);
    }
): void {
    let hitCount = 0;
    let reported = false;
    strykerNamespace.hitLimit = hitLimit;
    Object.defineProperty(strykerNamespace, 'hitCount', {
        configurable: true,
        enumerable:   true,
        get:          () => hitCount,
        set:          (value: number) => {
            hitCount = value;
            if(!reported && hitCount > hitLimit) {
                reported = true;
                report(formatHitLimitSentinel(token, hitCount));
            }
        },
    });
}

// ============================================================================
// Coverage Data Formatting
// ============================================================================

// Runtime coverage objects come from globalThis.__stryker__ and may have
// partially-initialised fields (perTest/static may be missing even though
// the MutantCoverage type declares them as required).  Widen the parameter
// type here so TypeScript treats the guards below as necessary.
interface PartialMutantCoverage {
    'static'?: MutantCoverage['static']
    perTest?:  MutantCoverage['perTest']
}

/**
 * Detect cross-test async coverage bleed within a single gap window (the span
 * between one test's afterEach and the next test's beforeEach).
 *
 * Compares the static bucket's per-key hit COUNTS at the start of the gap
 * (`staticCountsAtLastBoundary`, snapshotted in afterEach) against the counts
 * now (`staticCoverageNow`, read at the end of the gap). Any key whose count
 * increased — or that is newly present — proves code executed while no test
 * was active, i.e. after the previous test ended.
 *
 * Using count deltas rather than key presence is deliberate: a mutant that
 * already bled once (and so already exists in the snapshot) must still be
 * detected the next time it bleeds again.
 *
 * @param staticCountsAtLastBoundary - Static bucket counts snapshotted at the start of the gap window
 * @param staticCoverageNow - Current static bucket counts (`strykerGlobal.mutantCoverage.static`), or undefined
 * @returns Mutant ids whose static-bucket count increased during the gap window
 */
export function detectGapWindowBleed(
    staticCountsAtLastBoundary: Map<string, number>,
    staticCoverageNow: Record<string, number> | undefined
): string[] {
    if(!staticCoverageNow) {
        return [];
    }

    const bledIds: string[] = [];
    for(const [id, countNow] of Object.entries(staticCoverageNow)) {
        const countAtBoundary = staticCountsAtLastBoundary.get(id) ?? 0;
        if(countNow > countAtBoundary) {
            bledIds.push(id);
        }
    }
    return bledIds;
}

export function formatCoverageData(
    mutantCoverage: PartialMutantCoverage | undefined,
    counterToName: Map<string, string>,
    lateHits: LateHitEntry[] = []
): CoverageFileData {
    if(!mutantCoverage) {
        return { perTest: {}, 'static': {} };
    }

    // Hit counts are kept, not just the covered ids: Stryker sums them per mutant
    // to size each mutant run's hitLimit (100 × dry-run hits). Copied so later
    // hits cannot change what is written.
    const perTest: Record<string, Record<string, number>> = {};
    for(const [testId, coverage] of Object.entries(mutantCoverage.perTest ?? {})) {
        const actualName = counterToName.get(testId) ?? testId;
        perTest[actualName] = { ...coverage };
    }

    const staticCoverage = { ...mutantCoverage.static };

    return {
        perTest,
        'static': staticCoverage,
        // Copy so later mutation of the caller's accumulator array doesn't retroactively change already-written data.
        ...(lateHits.length > 0 ? { lateHits: [...lateHits] } : {}),
    };
}

// ============================================================================
// File Writing
// ============================================================================

/** Append (one line per test file of the run), creating if absent, and never through a symlink planted at the path (O_NOFOLLOW fails with ELOOP). */
// eslint-disable-next-line no-bitwise -- open(2) flags are a bitmask
const COVERAGE_APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/* eslint-disable n/no-sync -- sync required in afterAll hook to ensure write completes before process exit */
export function writeCoverageToFile(coverageFile: string, data: CoverageFileData): void {
    // mode applies only when the open creates the file: owner-only, like everything else in the runner's private temp dir.
    const fd = preloadFs.openSync(coverageFile, COVERAGE_APPEND_FLAGS, 0o600);
    try {
        preloadFs.appendFileSync(fd, `${JSON.stringify(data)}\n`, 'utf8');
    } finally {
        preloadFs.closeSync(fd);
    }
}
/* eslint-enable n/no-sync -- end of writeCoverageToFile */

// ============================================================================
// Orphan prevention: the parent lifeline
// ============================================================================

/**
 * Environment variable through which the runner tells a `bun test` child which
 * of its file descriptors is the parent lifeline: the read end of a pipe whose
 * other end only the spawning runner process holds.
 */
export const LIFELINE_FD_ENV = '__STRYKER_LIFELINE_FD__';

/** Dependencies of {@link watchParentLifeline}. */
export interface ParentLifelineDeps {
    /** The descriptor as the runner named it: `process.env[LIFELINE_FD_ENV]`. */
    fdValue:    string | undefined
    /** Called once the parent is gone. */
    onOrphaned: () => void
    /** Opens the descriptor for reading. Defaults to an fs read stream on it. */
    open?:      (fd: number) => Readable
}

/**
 * The lifeline descriptor named by `value`, or undefined when there is none.
 * Descriptors 0–2 are stdio, never a lifeline: stdin is /dev/null for a
 * runner child, and reading it would look like the parent dying at once.
 */
function parseLifelineFd(value: string | undefined): number | undefined {
    if(value === undefined || !/^\d+$/.test(value)) {
        return undefined;
    }
    const fd = Number(value);
    return Number.isSafeInteger(fd) && fd > 2 ? fd : undefined;
}

/**
 * Calls `onOrphaned` when the process that spawned this one dies, so a
 * `bun test` child never outlives the Stryker worker that started it — even
 * when that worker is killed with SIGKILL, which gives it no chance to run any
 * cleanup of its own.
 *
 * The runner spawns each child with an extra pipe and holds the write end
 * without ever closing it. The kernel closes every descriptor of a process
 * that exits, however it exits, so end-of-file on the read end means the
 * parent is gone. This is an I/O event: no timer is involved. A timer-based
 * check (polling `process.ppid`) is lost to any suite that installs bun's fake
 * timers, because bun moves a real interval that ticks while fake timers are
 * installed into the fake-timer queue, where it never fires again on its own
 * (bun 1.4.2). Capturing the real timer functions does not avoid that: the
 * timer itself is moved. Reading also drains anything the parent writes.
 *
 * Only end-of-file counts. A descriptor that is not open errors and closes
 * without one, and says nothing about the parent.
 *
 * @returns true when the lifeline is being watched, false when `fdValue`
 *   names no usable descriptor (the process was not spawned by the runner).
 */
export function watchParentLifeline(deps: ParentLifelineDeps): boolean {
    const fd = parseLifelineFd(deps.fdValue);
    if(fd === undefined) {
        return false;
    }
    const open = deps.open ?? ((lifelineFd: number) => createReadStream('', { fd: lifelineFd }));
    const lifeline = open(fd);
    lifeline.once('end', deps.onOrphaned);
    lifeline.on('error', () => {
        // Not end-of-file: see above.
    });
    lifeline.resume();
    return true;
}
