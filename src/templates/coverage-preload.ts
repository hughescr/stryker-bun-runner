/**
 * Coverage preload script
 * This script is loaded before tests run to collect mutation coverage data
 */

import { appendFileSync } from 'node:fs';
import { beforeEach, afterEach, afterAll } from 'bun:test';

// Define the coverage data type inline (avoid import path issues)
interface CoverageFileData {
  perTest: Record<string, string[]>;
  static: string[];
}

// Get environment variables
const syncPort = process.env.__STRYKER_SYNC_PORT__;
const coverageFile = process.env.__STRYKER_COVERAGE_FILE__;
const activeMutant = process.env.__STRYKER_ACTIVE_MUTANT__;

// Skip coverage collection during mutant runs (only need pass/fail)
const shouldCollectCoverage = !activeMutant && !!coverageFile;


// ============================================================================
// Section 1: WebSocket Sync (wait for inspector to be ready)
// ============================================================================
if (syncPort) {
  try {
    const ws = new WebSocket(`ws://localhost:${syncPort}/sync`);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        console.warn('[Stryker Sync] Timeout waiting for ready signal, proceeding anyway');
        resolve();
      }, 5000);

      ws.onmessage = (event) => {
        if (event.data === 'ready') {
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
const strykerGlobal = (globalThis as any).__stryker__ || ((globalThis as any).__stryker__ = {});

// Initialize mutantCoverage structure (may already exist from instrumented code)
if (!strykerGlobal.mutantCoverage) {
  strykerGlobal.mutantCoverage = { static: {}, perTest: {} };
}

// CRITICAL: Stryker's ChildProcessTestRunnerWorker expects global.__mutantCoverage__
// Set up a reference to the same object so both locations point to the same data
(globalThis as any).__mutantCoverage__ = strykerGlobal.mutantCoverage;

// Set active mutant for mutant runs
if (activeMutant) {
  strykerGlobal.activeMutant = activeMutant;
}

// ============================================================================
// Section 3: Test Counter and Hooks (for per-test coverage tracking)
// ============================================================================
let testCounter = 0;

if (shouldCollectCoverage) {
  beforeEach(() => {
    testCounter++;
    strykerGlobal.currentTestId = `test-${testCounter}`;
    // Initialize perTest entry for this test
    if (!strykerGlobal.mutantCoverage.perTest[strykerGlobal.currentTestId]) {
      strykerGlobal.mutantCoverage.perTest[strykerGlobal.currentTestId] = {};
    }
  });

  afterEach(() => {
    // Clear currentTestId so any subsequent code records to static
    strykerGlobal.currentTestId = undefined;
  });
}

// ============================================================================
// Section 4: Exit Handler - Write Coverage Data
// ============================================================================

// Shared coverage writing logic
const writeCoverageData = () => {
  if (!shouldCollectCoverage || !coverageFile) {
    return;
  }

  const mutantCoverage = strykerGlobal.mutantCoverage;
  if (!mutantCoverage) {
    return;
  }


  // Convert from Record<string, number> to string[] format
  const perTest: Record<string, string[]> = {};
  for (const [testId, coverage] of Object.entries(mutantCoverage.perTest || {})) {
    perTest[testId] = Object.keys(coverage as Record<string, number>);
  }

  const staticCoverage = Object.keys(mutantCoverage.static || {});


  const data: CoverageFileData = {
    perTest,
    static: staticCoverage,
  };

  try {
    appendFileSync(coverageFile, JSON.stringify(data) + '\n', 'utf-8');
  } catch (error) {
    console.error('[Stryker Coverage] Failed to write coverage:', error);
  }
};

// Use afterAll hook to write coverage after all tests complete
// (process.on('beforeExit') and process.on('exit') don't fire in Bun's test runner)
if (shouldCollectCoverage) {
  afterAll(() => {
    writeCoverageData();
  });
}
