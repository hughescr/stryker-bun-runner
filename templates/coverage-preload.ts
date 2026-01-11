/**
 * Coverage preload script
 * This script is injected before test execution to collect per-test coverage data
 *
 * It hooks into Bun's test lifecycle to track which mutants are executed during each test.
 * Works with Stryker's built-in coverage instrumentation.
 */

declare const Bun: {
  write(path: string, content: string): Promise<number>;
};

// Note: expect may not be available in preload context, so we access it via globalThis

interface StrykerMutantCoverage {
  static: Record<string, number>;
  perTest: Record<string, Record<string, number>>;
}

interface StrykerGlobal {
  activeMutant?: number;
  currentTestId?: string;
  mutantCoverage?: StrykerMutantCoverage;
}

let currentTestId: string | undefined;

// Initialize or retrieve the __stryker__ global that instrumented code uses
const strykerGlobal = ((globalThis as any).__stryker__ || ((globalThis as any).__stryker__ = {})) as StrykerGlobal;

// Set active mutant from environment if provided
if (!strykerGlobal.activeMutant && process.env.__STRYKER_ACTIVE_MUTANT__) {
  strykerGlobal.activeMutant = parseInt(process.env.__STRYKER_ACTIVE_MUTANT__, 10);
}

// Hook into Bun's test lifecycle
import { beforeEach, afterEach, afterAll } from 'bun:test';

beforeEach(() => {
  // Get the current test name from Bun's test context
  // expect may not be available in preload context, so we use a fallback
  let testName: string | undefined;

  try {
    // This might work if called from within a test context
    const expectGlobal = (globalThis as any).expect;
    if (expectGlobal && typeof expectGlobal.getState === 'function') {
      const state = expectGlobal.getState();
      testName = state?.currentTestName;
    }
  } catch {
    // Ignore - expect not available
  }

  currentTestId = testName ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  strykerGlobal.currentTestId = currentTestId;
});

afterEach(() => {
  currentTestId = undefined;
  strykerGlobal.currentTestId = undefined;
});

afterAll(async () => {
  // Read coverage data from Stryker's built-in coverage tracking
  const mutantCoverage = strykerGlobal.mutantCoverage;

  if (!mutantCoverage) {
    console.warn('[Stryker Coverage] No mutantCoverage found - instrumentation may not be working');
    return;
  }

  // Convert to the format expected by the test runner
  // Stryker stores: perTest[testId][mutantId] = hitCount
  // We need: perTest[testId] = [mutantId, ...]
  const coverageData = {
    perTest: Object.fromEntries(
      Object.entries(mutantCoverage.perTest).map(([testId, mutants]) => [
        testId,
        Object.keys(mutants),
      ])
    ),
    static: Object.keys(mutantCoverage.static),
  };

  // Write to temp file - path is provided via environment variable
  const coverageFile = process.env.__STRYKER_COVERAGE_FILE__;
  if (coverageFile) {
    try {
      await Bun.write(coverageFile, JSON.stringify(coverageData, null, 2));
    } catch (error) {
      // Silently fail - don't break tests if coverage writing fails
      console.error('Failed to write coverage data:', error);
    }
  }
});
