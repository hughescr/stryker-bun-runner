/**
 * Coverage preload script
 * This script is loaded before tests run to collect mutation coverage data
 */

import { appendFileSync } from 'node:fs';
import { beforeEach, afterEach, afterAll } from 'bun:test';

// Define the coverage data type inline (avoid import path issues)
interface CoverageFileData {
    perTest:  Record<string, string[]>
    'static': string[]
}

interface StrykerGlobal {
    __stryker__?: {
        mutantCoverage?: {
            'static': Record<string, number>
            perTest:  Record<string, Record<string, number>>
        }
        currentTestId?: string
        activeMutant?:  string
    }
    __mutantCoverage__?: {
        'static': Record<string, number>
        perTest:  Record<string, Record<string, number>>
    }
}

// Get environment variables
const syncPort = process.env.__STRYKER_SYNC_PORT__;
const coverageFile = process.env.__STRYKER_COVERAGE_FILE__;
const activeMutant = process.env.__STRYKER_ACTIVE_MUTANT__;

// Skip coverage collection during mutant runs (only need pass/fail)
const shouldCollectCoverage = !activeMutant && !!coverageFile;

// ============================================================================
// Section 1: WebSocket Sync (receive test start events)
// ============================================================================
let ws: WebSocket | null = null;

// Track test counter and WebSocket-provided names (only needed when collecting coverage)
let testCounter = 0;
const counterToName = new Map<string, string>();
let pendingTestName: string | undefined;

if(shouldCollectCoverage) {
    // Coverage collection will use these variables
}

if(syncPort && shouldCollectCoverage) {
    try {
        ws = new WebSocket(`ws://localhost:${syncPort}/sync`);

        ws.onmessage = (event) => {
            const data = String(event.data);
            if(data === 'ready') {
                // Initial ready signal - tests can start
                return;
            }
            try {
                const msg = JSON.parse(data) as { type?: string, name?: string };
                if(msg.type === 'testStart' && msg.name) {
                    // Store the pending test name to be picked up by beforeEach
                    pendingTestName = msg.name;
                }
            } catch{
                // Ignore parse errors
            }
        };

        // Wait for ready signal
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                console.warn('[Stryker] Timeout waiting for ready signal');
                resolve();
            }, 5000);

            const wsInstance = ws;
            if(!wsInstance) {
                clearTimeout(timeout);
                resolve();
                return;
            }

            const originalOnMessage = wsInstance.onmessage;
            wsInstance.onmessage = (event) => {
                if(event.data === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                }
                if(originalOnMessage) {
                    originalOnMessage.call(wsInstance, event);
                }
            };

            wsInstance.onerror = () => {
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
        const ws = new WebSocket(`ws://localhost:${syncPort}/sync`);
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                ws.close();
                console.warn('[Stryker Sync] Timeout waiting for ready signal, proceeding anyway');
                resolve();
            }, 5000);

            ws.onmessage = (event) => {
                if(event.data === 'ready') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                }
            };

            ws.onerror = () => {
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
g.__stryker__ ??= { mutantCoverage: { 'static': {}, perTest: {} } };
const strykerGlobal = g.__stryker__;

// Initialize mutantCoverage structure (may already exist from instrumented code)
strykerGlobal.mutantCoverage ??= { 'static': {}, perTest: {} };
const mutantCoverage = strykerGlobal.mutantCoverage;

// CRITICAL: Stryker's ChildProcessTestRunnerWorker expects global.__mutantCoverage__
// Set up a reference to the same object so both locations point to the same data
g.__mutantCoverage__ = mutantCoverage;

// Set active mutant for mutant runs
if(activeMutant) {
    strykerGlobal.activeMutant = activeMutant;
}

// ============================================================================
// Section 3: Coverage Writing Logic
// ============================================================================

// Shared coverage writing logic
const writeCoverageData = () => {
    if(!shouldCollectCoverage || !coverageFile) {
        return;
    }

    const mutantCoverage = strykerGlobal.mutantCoverage;
    if(!mutantCoverage) {
        return;
    }

    // Convert from Record<string, number> to string[] format
    // Remap counter IDs to test names using the mapping
    const perTest: Record<string, string[]> = {};
    for(const [testId, coverage] of Object.entries(mutantCoverage.perTest ?? {})) {
    // Check if this is a counter ID that needs remapping
        const actualName = counterToName.get(testId) ?? testId;
        perTest[actualName] = Object.keys(coverage);
    }

    const staticCoverage = Object.keys(mutantCoverage.static ?? {});

    const data: CoverageFileData = {
        perTest,
        'static': staticCoverage,
    };

    try {
        // eslint-disable-next-line n/no-sync -- sync required in afterAll hook to ensure write completes before process exit
        appendFileSync(coverageFile, JSON.stringify(data) + '\n', 'utf-8');
    } catch (error) {
        console.error('[Stryker Coverage] Failed to write coverage:', error);
    }
};

// ============================================================================
// Section 4: Test Hooks (for per-test coverage tracking)
// ============================================================================
if(shouldCollectCoverage) {
    beforeEach(() => {
        testCounter++;
        const counterId = `test-${testCounter}`;

        // If we have a pending test name from WebSocket, use it
        if(pendingTestName) {
            counterToName.set(counterId, pendingTestName);
            strykerGlobal.currentTestId = pendingTestName;
            mutantCoverage.perTest[pendingTestName] ??= {};
            pendingTestName = undefined;
        } else {
            // Fallback to counter - will be remapped later
            strykerGlobal.currentTestId = counterId;
            mutantCoverage.perTest[counterId] ??= {};
        }
    });

    afterEach(() => {
    // Clear currentTestId so any subsequent code records to static
        strykerGlobal.currentTestId = undefined;
    });

    afterAll(() => {
        ws?.close();
        writeCoverageData();
    });
}
