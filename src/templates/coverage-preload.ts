/**
 * Coverage preload script
 * This script is loaded before tests run to collect mutation coverage data
 * Note: This is a template file with a placeholder import that gets replaced at runtime
 */

import { beforeEach, afterEach, afterAll } from 'bun:test';
import {
    getPreloadConfig,
    shouldCollectCoverage as shouldCollect,
    initializeStrykerNamespace,
    setActiveMutant,
    formatCoverageData,
    writeCoverageToFile,
    parseWebSocketMessage,
    createTestCounter,
    type StrykerNamespace
} from '__PRELOAD_LOGIC_PATH__';

interface StrykerGlobal {
    [key: string]:       unknown
    __stryker__?:        StrykerNamespace
    __mutantCoverage__?: {
        'static': Record<string, number>
        perTest:  Record<string, Record<string, number>>
    }
}

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

// Track test counter and WebSocket-provided names (only needed when collecting coverage)
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
const testCounter = createTestCounter();
let pendingTestName: string | undefined;

if(shouldCollectCoverage) {
    // Coverage collection will use these variables
}

if(syncPort && shouldCollectCoverage) {
    try {
        ws = new WebSocket(`ws://localhost:${syncPort}/sync`);

        ws.onmessage = (event) => {
            const data = String(event.data);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
            const parsedMessage = parseWebSocketMessage(data);

            if(parsedMessage === 'ready') {
                // Initial ready signal - tests can start
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Parsed message has dynamic type
            if(parsedMessage && typeof parsedMessage === 'object' && parsedMessage.type === 'testStart') {
                // Store the pending test name to be picked up by beforeEach
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Parsed message has dynamic type
                pendingTestName = parsedMessage.name;
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
// Section 3: Coverage Writing Logic
// ============================================================================

// Shared coverage writing logic
const writeCoverageData = () => {
    if(!shouldCollectCoverage || !coverageFile) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Placeholder import replaced at runtime
    const data = formatCoverageData(strykerGlobal.mutantCoverage, testCounter.getCounterToNameMap());

    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Placeholder import replaced at runtime
        writeCoverageToFile(coverageFile, data);
    } catch (error) {
        console.error('[Stryker Coverage] Failed to write coverage:', error);
    }
};

// ============================================================================
// Section 4: Test Hooks (for per-test coverage tracking)
// ============================================================================
if(shouldCollectCoverage) {
    beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- TestCounter from placeholder import
        const counterId = testCounter.increment();

        // If we have a pending test name from WebSocket, use it
        if(pendingTestName) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- TestCounter from placeholder import
            testCounter.setName(counterId, pendingTestName);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- StrykerGlobal from placeholder import
            strykerGlobal.currentTestId = pendingTestName;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- MutantCoverage from placeholder import
            mutantCoverage.perTest[pendingTestName] ??= {};
            pendingTestName = undefined;
        } else {
            // Fallback to counter - will be remapped later
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- StrykerGlobal from placeholder import
            strykerGlobal.currentTestId = counterId;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- MutantCoverage from placeholder import
            mutantCoverage.perTest[counterId] ??= {};
        }
    });

    afterEach(() => {
    // Clear currentTestId so any subsequent code records to static
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- StrykerGlobal from placeholder import
        strykerGlobal.currentTestId = undefined;
    });

    afterAll(() => {
        ws?.close();
        writeCoverageData();
    });
}
