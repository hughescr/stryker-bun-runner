/**
 * Testable logic extracted from coverage-preload.ts
 *
 * This file contains pure functions that can be tested independently
 * of the runtime environment. The actual preload script imports and
 * uses these functions.
 */

import { appendFileSync } from 'node:fs';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { CoverageFileData } from './types.js';

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

export function formatCoverageData(
    mutantCoverage: PartialMutantCoverage | undefined,
    counterToName: Map<string, string>
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
