/**
 * Coverage preload script
 * This script is loaded before tests run to collect mutation coverage data
 * Note: This is a template file with a placeholder import that gets replaced at runtime
 */

import { beforeEach, afterEach, afterAll, describe, test, it } from 'bun:test';
import {
    getPreloadConfig,
    shouldCollectCoverage as shouldCollect,
    initializeStrykerNamespace,
    setActiveMutant,
    formatCoverageData,
    detectGapWindowBleed,
    writeCoverageToFile,
    startOrphanWatchdog,
    type StrykerNamespace,
    type LateHitEntry
} from '__PRELOAD_LOGIC_PATH__';

// ============================================================================
// Section 0: Orphan prevention
// ============================================================================
// Every bun test child loads this preload script (dryRun AND mutant runs), so
// this watchdog runs unconditionally, regardless of coverage collection.
// If the Stryker worker that spawned this process dies (including via
// SIGKILL, which gives it no chance to kill its children), this process would
// otherwise run forever, or until its own --timeout is reached — see README
// "Orphan prevention".
const stopOrphanWatchdog = startOrphanWatchdog({
    getPpid:    () => process.ppid,
    onOrphaned: () => {
        console.warn('[Stryker] Parent process is no longer running — terminating to avoid an orphaned bun test process');
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- deliberate self-termination once orphaned; nothing else can stop this process from running forever
        process.exit(1);
    },
});
afterAll(() => {
    stopOrphanWatchdog();
});

// Patch .concurrent() to be regular sequential execution
// This ensures accurate coverage tracking during mutation testing
// Users can still use .concurrent() for faster normal test runs
// Use Object.defineProperty to override readonly properties
Object.defineProperty(describe, 'concurrent', { value: describe, writable: true, configurable: true });
Object.defineProperty(test, 'concurrent', { value: test, writable: true, configurable: true });
Object.defineProperty(it, 'concurrent', { value: it, writable: true, configurable: true });

interface StrykerGlobal {
    [key: string]:       unknown
    __stryker__?:        StrykerNamespace
    __mutantCoverage__?: {
        'static': Record<string, number>
        perTest:  Record<string, Record<string, number>>
    }
}

// Eager modules list — placeholder replaced at generation time with a sorted JSON array of absolute
// paths to all source files being mutated.  Importing each module here (before any test code runs,
// while strykerGlobal.currentTestId is undefined) ensures that all module-level top-level code is
// executed in the "static" coverage bucket rather than the "perTest" bucket of whichever test
// happened to trigger the first import.  This makes coverage collection deterministic across runs.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Placeholder replaced at generation time; value is always a valid JSON array literal
const EAGER_MODULES: string[] = __EAGER_MODULES__;

// Get environment variables
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
const config = getPreloadConfig();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Config from placeholder import
const { syncPort, coverageFile, activeMutant } = config;

// Skip coverage collection during mutant runs (only need pass/fail)
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
const shouldCollectCoverage = shouldCollect(config);

// ============================================================================
// Section 1: WebSocket Sync (receive test start events)
// ============================================================================
let ws: WebSocket | null = null;

// Per-file test counters for per-test coverage tracking.
//
// Bun runs multiple test files sequentially inside the same worker process,
// sharing a single preload module instance.  A module-level counter would
// increment globally across all files, making position N for file B mean
// "the (N)th test of ALL files combined" rather than "the (N)th test of B".
// The coverage mapper expects per-file counters that restart at 1 for each
// file, so we keep a Map<filePrefix, count> and reset per-file naturally.
//
// Bun.main is read DYNAMICALLY inside beforeEach (not at module init time)
// because it changes to reflect the currently-executing test file.
const perFileCounters = new Map<string, number>();

// Helper: extract a stable relative file prefix from a Bun.main absolute path.
// Strips the Stryker sandbox prefix so keys are portable across runs.
function extractFilePrefix(bunMain: string): string {
    if(!bunMain) {
        return 'unknown';
    }
    // Stryker disable next-line Regex: sandbox path extraction pattern
    const sandboxMatch = /\.stryker-tmp\/sandbox-[^/]+\/(.+)$/.exec(bunMain);
    return sandboxMatch ? sandboxMatch[1] : bunMain.replace(/^.*\//, '');
}

// ============================================================================
// Cross-test async coverage-bleed detection (gap-window count-delta)
// ============================================================================
// Detects fire-and-forget promise chains (or other async work) that keep
// recording mutant coverage into the `static` bucket after their originating
// test's afterEach has fired — i.e. between one test ending and the next
// test beginning ("the gap window"). Diagnostic only: see
// emitCoverageBleedWarnings in bun-test-runner.ts for how this surfaces as a
// warning; it never changes coverage attribution.
//
// lastEndedTestId / lastFilePrefix / staticSnapshotAtLastBoundary are updated
// in afterEach (the start of a gap window) and consumed in the NEXT
// beforeEach (the end of that gap window) — see both hooks below.
let lastEndedTestId: string | undefined;
let lastFilePrefix: string | undefined;
let staticSnapshotAtLastBoundary = new Map<string, number>();
const lateHits: LateHitEntry[] = [];

if(syncPort && shouldCollectCoverage) {
    try {
        // Install the real 'ready' handler before yielding to the event loop so
        // there is no window where an arriving message is silently dropped.
        await new Promise<void>((resolve) => {
            ws = new WebSocket(`ws://localhost:${syncPort}/sync`);
            const timeout = setTimeout(() => {
                console.warn('[Stryker] Timeout waiting for ready signal');
                resolve();
            }, 2000);

            ws.onmessage = (event) => {
                if(event.data === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                console.warn('[Stryker] Failed to connect to sync server');
                resolve();
            };
        });
    } catch (error) {
        console.warn('[Stryker] Error during synchronization:', error);
    }
} else if(syncPort && !shouldCollectCoverage) {
    // No coverage collection, just wait for ready signal
    try {
        // Install the real 'ready' handler before yielding to the event loop so
        // there is no window where an arriving message is silently dropped.
        await new Promise<void>((resolve) => {
            const wsLocal = new WebSocket(`ws://localhost:${syncPort}/sync`);
            const timeout = setTimeout(() => {
                wsLocal.close();
                console.warn('[Stryker Sync] Timeout waiting for ready signal, proceeding anyway');
                resolve();
            }, 2000);

            wsLocal.onmessage = (event) => {
                if(event.data === 'ready') {
                    clearTimeout(timeout);
                    wsLocal.close();
                    resolve();
                }
            };

            wsLocal.onerror = () => {
                clearTimeout(timeout);
                console.warn('[Stryker Sync] Failed to connect to sync server, proceeding anyway');
                resolve();
            };
        });
    } catch (error) {
        console.warn('[Stryker Sync] Error during synchronization, proceeding anyway:', error);
    }
}

// ============================================================================
// Section 2: Initialize Stryker Namespace
// ============================================================================
const g = globalThis as unknown as StrykerGlobal;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
const strykerGlobal = initializeStrykerNamespace(g as Record<string, unknown>);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- StrykerGlobal from placeholder import
const mutantCoverage = strykerGlobal.mutantCoverage!;

// Set active mutant for mutant runs
if(activeMutant) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
    setActiveMutant(strykerGlobal, activeMutant);
}

// ============================================================================
// Section 3: Eager Module Imports (deterministic static coverage)
// ============================================================================
// Force all src modules to execute their top-level code during preload,
// while strykerGlobal.currentTestId is undefined.  Module-level mutants
// then deterministically record to the `static` bucket instead of the
// `perTest` entry of whichever test happened to trigger the import first.
//
// This block is skipped during mutant runs (shouldCollectCoverage is false)
// so mutant runs do not pay the startup cost of importing every source file.
if(shouldCollectCoverage) {
    for(const modPath of EAGER_MODULES) {
        try {
            // eslint-disable-next-line no-await-in-loop -- Sequential eager imports are intentional; parallel import would race on module-level side effects
            await import(modPath);
        } catch(err) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- err.message may exist at runtime
            console.warn(`[Stryker] Eager import failed for ${modPath}:`, err);
        }
    }
}

// ============================================================================
// Section 4: Coverage Writing Logic
// ============================================================================

// Shared coverage writing logic
const writeCoverageData = () => {
    if(!shouldCollectCoverage || !coverageFile) {
        return;
    }

    // counterToName is not populated (test names are resolved by coverage-mapper
    // from the inspector data, not stored here), so pass an empty Map.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Placeholder import replaced at runtime
    const data = formatCoverageData(strykerGlobal.mutantCoverage, new Map<string, string>(), lateHits);

    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
        writeCoverageToFile(coverageFile, data);
    } catch (error) {
        console.error('[Stryker Coverage] Failed to write coverage:', error);
    }
};

// ============================================================================
// Section 5: Test Hooks (for per-test coverage tracking)
// ============================================================================
if(shouldCollectCoverage) {
    beforeEach(() => {
        // Assign a stable, per-file test ID by combining the normalized test
        // file path with a per-file counter.
        //
        // Key design constraints:
        //   1. Bun runs multiple test files sequentially in one worker process,
        //      so the preload module is initialized ONCE for the whole run.
        //   2. However, Bun.main IS updated to the currently-running test file
        //      by the time each beforeEach fires.
        //   3. The coverage-mapper expects counters to restart at 1 per file
        //      (e.g. "tests/foo.test.ts@@test-1", "tests/bar.test.ts@@test-1"),
        //      so we track a separate counter per file prefix.
        //
        // @ts-expect-error -- Bun global is available at runtime but not in TS typings
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Bun global accessed at runtime
        const bunMain = String((globalThis as unknown as { Bun?: { main?: string } }).Bun?.main ?? '');
        const filePrefix = extractFilePrefix(bunMain);

        // Gap-window bleed check: this beforeEach is the END of the gap window that
        // started when the previous test's afterEach ran (see afterEach below). Diff
        // the static bucket now against the snapshot taken back then; any mutant whose
        // count increased executed while no test was active — i.e. after the previous
        // test ended.
        if(filePrefix !== lastFilePrefix) {
            // FILE-BOUNDARY SKIP: this test starts a new file relative to the last one
            // that ended. A new file's module-level code (imports, describe-level setup)
            // legitimately executes in this gap and would be indistinguishable from real
            // bleed from here, so we deliberately do not diff across a file boundary.
            // This trades missed cross-file leaks for zero file-boundary false positives,
            // which is the safer default for a diagnostic-only warning.
            lastEndedTestId = undefined;
            staticSnapshotAtLastBoundary = new Map();
        } else if(lastEndedTestId !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Placeholder import replaced at runtime
            const bledMutantIds = detectGapWindowBleed(staticSnapshotAtLastBoundary, mutantCoverage.static);
            if(bledMutantIds.length > 0) {
                lateHits.push({ testId: lastEndedTestId, mutantIds: bledMutantIds });
            }
        }

        const prevCount = perFileCounters.get(filePrefix) ?? 0;
        const nextCount = prevCount + 1;
        perFileCounters.set(filePrefix, nextCount);
        const testId = `${filePrefix}@@test-${nextCount}`;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- StrykerGlobal from placeholder import
        strykerGlobal.currentTestId = testId;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- MutantCoverage from placeholder import
        mutantCoverage.perTest[testId] ??= {};
    });

    afterEach(() => {
        // Record the gap-window START: which test just ended, and the static bucket's
        // counts at this instant. The NEXT beforeEach (above) diffs against this
        // snapshot to detect any coverage recorded in between — see
        // "Cross-test async coverage-bleed detection" above.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- StrykerGlobal from placeholder import
        const endedTestId: string | undefined = strykerGlobal.currentTestId;
        lastEndedTestId = endedTestId;
        if(endedTestId) {
            const sepIdx = endedTestId.indexOf('@@');
            lastFilePrefix = sepIdx === -1 ? endedTestId : endedTestId.slice(0, sepIdx);
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- MutantCoverage from placeholder import
        staticSnapshotAtLastBoundary = new Map(Object.entries(mutantCoverage.static));

        // Clear currentTestId so any subsequent code records to static
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- StrykerGlobal from placeholder import
        strykerGlobal.currentTestId = undefined;
    });

    afterAll(() => {
        // Final gap check, best-effort: catches bleed that has already recorded a
        // counter delta by the time afterAll runs, with no following beforeEach
        // left to catch it any other way. This preload's afterAll fires once per
        // WORKER PROCESS (empirically verified — Bun runs multiple test files
        // sequentially in one worker sharing this preload module instance), so
        // this is the single final opportunity to detect trailing bleed before
        // coverage is written below.
        //
        // LIMITATION: this only sees hits that execute before afterAll itself
        // runs. A queued timer or promise continuation that is still pending
        // when afterAll fires (and settles afterward, e.g. during process
        // teardown) is never observed — there is no later hook to diff against.
        // Fully catching trailing leaks would need a deliberate strict-drain
        // mode (draining the microtask/timer queue before treating the run as
        // over) — deliberately out of scope here (event-loop starvation risk);
        // see README's "Coverage-bleed warning" section.
        if(lastEndedTestId !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Placeholder import replaced at runtime
            const bledMutantIds = detectGapWindowBleed(staticSnapshotAtLastBoundary, mutantCoverage.static);
            if(bledMutantIds.length > 0) {
                lateHits.push({ testId: lastEndedTestId, mutantIds: bledMutantIds });
            }
        }

        ws?.close();
        writeCoverageData();
        // Clear the accumulator now that it has been written out.
        lateHits.length = 0;
    });
}
