/**
 * Testable logic extracted from coverage-preload.ts
 *
 * This file contains pure functions that can be tested independently
 * of the runtime environment. The actual preload script imports and
 * uses these functions.
 */

import { appendFileSync } from 'node:fs';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { CoverageFileData, LateHitEntry } from './types.js';

// Re-exported so the coverage-preload template — which imports everything it
// needs from this module via the `__PRELOAD_LOGIC_PATH__` placeholder — can
// reference the type without a second relative import that wouldn't resolve
// correctly once the template is copied to its temp-dir location.
export type { LateHitEntry } from './types.js';

export interface StrykerNamespace {
    mutantCoverage?: MutantCoverage
    currentTestId?:  string
    activeMutant?:   string
}

// ============================================================================
// Configuration
// ============================================================================

export interface PreloadConfig {
    syncPort?:     string
    coverageFile?: string
    activeMutant?: string
}

export function getPreloadConfig(): PreloadConfig {
    return {
        syncPort:     process.env.__STRYKER_SYNC_PORT__,
        coverageFile: process.env.__STRYKER_COVERAGE_FILE__,
        activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__,
    };
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
        return { perTest: {}, 'static': [] };
    }

    const perTest: Record<string, string[]> = {};
    for(const [testId, coverage] of Object.entries(mutantCoverage.perTest ?? {})) {
        const actualName = counterToName.get(testId) ?? testId;
        perTest[actualName] = Object.keys(coverage);
    }

    const staticCoverage = Object.keys(mutantCoverage.static ?? {});

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

export function writeCoverageToFile(coverageFile: string, data: CoverageFileData): void {
    // eslint-disable-next-line n/no-sync -- sync required in afterAll hook to ensure write completes before process exit
    appendFileSync(coverageFile, `${JSON.stringify(data)}\n`, 'utf8');
}

// ============================================================================
// Orphan prevention: parent-liveness watchdog
// ============================================================================

/**
 * Dependencies injected into {@link startOrphanWatchdog}, so the polling
 * logic is testable without real timers or a real process tree.
 */
export interface OrphanWatchdogDeps {
    /** Returns the current parent PID, e.g. `() => process.ppid`. */
    getPpid:     () => number
    /** Called (once) the first time a parent-PID change is observed. */
    onOrphaned:  () => void
    /** Poll interval in milliseconds. @default 1000 */
    intervalMs?: number
}

/**
 * Detects when this process's original parent has died and invokes
 * `onOrphaned`, so a spawned `bun test` child never outlives the Stryker
 * worker that started it — even when that worker is killed with SIGKILL,
 * which gives it no chance to run any cleanup/kill-child code itself.
 *
 * POSIX reparents an orphaned child to the nearest subreaper (commonly PID 1,
 * or a container's init) as soon as its original parent exits. Polling
 * `process.ppid` and comparing it to the value captured when this watchdog
 * started is therefore a portable, dependency-free way to detect that
 * reparenting — no prctl(PR_SET_PDEATHSIG) or native addon required, and it
 * works the same on Linux and macOS.
 *
 * @returns A function that stops the watchdog (used by the preload script's
 *   own afterAll cleanup, and by tests).
 */
export function startOrphanWatchdog(deps: OrphanWatchdogDeps): () => void {
    const originalPpid = deps.getPpid();
    let fired = false;
    const intervalId = setInterval(() => {
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: reentrancy guard — the callback is invoked at most once regardless of how many further ticks observe the changed ppid; covered by 'invokes onOrphaned only once even if the interval ticks again before being stopped'
        if(fired || deps.getPpid() === originalPpid) {
            return;
        }
        fired = true;
        deps.onOrphaned();
    }, deps.intervalMs ?? 1000);
    // Never let the watchdog itself keep the process alive once real work
    // (the test run) has otherwise finished.
    intervalId.unref();
    return () => {
        clearInterval(intervalId);
    };
}
