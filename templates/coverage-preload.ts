/**
 * Coverage preload script
 * This script is injected before test execution to collect per-test coverage data
 *
 * It hooks into Bun's test lifecycle to track which mutants are executed during each test.
 * Works with Stryker's built-in coverage instrumentation.
 */

declare const Bun: {
  write(path: string, content: string | Buffer, options?: { append?: boolean }): Promise<number>;
};

interface StrykerMutantCoverage {
  static: Record<string, number>;
  perTest: Record<string, Record<string, number>>;
}

interface StrykerGlobal {
  activeMutant?: number;
  currentTestId?: string;
  mutantCoverage?: StrykerMutantCoverage;
}

// Initialize or retrieve the __stryker__ global that instrumented code uses
const strykerGlobal = ((globalThis as any).__stryker__ || ((globalThis as any).__stryker__ = {})) as StrykerGlobal;

// Set active mutant from environment if provided
// Keep as string or number depending on what Stryker's instrumentation expects
if (strykerGlobal.activeMutant === undefined && process.env.__STRYKER_ACTIVE_MUTANT__) {
  // Try both string and number forms for compatibility
  const mutantId = process.env.__STRYKER_ACTIVE_MUTANT__;
  (strykerGlobal as any).activeMutant = mutantId;
}

// Hook into Bun's test lifecycle
import { beforeEach, afterEach, afterAll } from 'bun:test';

// Skip coverage collection entirely during mutant runs
// Coverage is only needed during dry run to identify which tests cover which mutants
const isMutantRun = !!process.env.__STRYKER_ACTIVE_MUTANT__;

let currentTestId: string | undefined;
let testCounter = 0;

// Note: We cannot get test filenames or describe hierarchy in beforeEach because:
// 1. Bun's beforeEach callback doesn't include test file frames in the call stack
// 2. Bun's module exports are read-only, so we can't wrap describe/test/it
// 3. Bun doesn't expose expect.getState() like Jest/Vitest
// 4. Bun's Inspector Protocol TestReporter domain (as of v1.3.5) doesn't fire events
//
// Test IDs are therefore counter-based (test-1, test-2, etc.)
// This requires --no-randomize flag to ensure consistent ordering between runs.
// The console parser provides filenames in format: "file.test.ts > test name"

beforeEach(() => {
  if (isMutantRun) return;

  testCounter++;
  currentTestId = `test-${testCounter}`;
  strykerGlobal.currentTestId = currentTestId;
});

afterEach(() => {
  // Skip during mutant runs
  if (isMutantRun) return;

  currentTestId = undefined;
  strykerGlobal.currentTestId = undefined;
});

/**
 * Write data with timeout to prevent hanging
 */
async function writeWithTimeout(path: string, content: string, timeoutMs: number): Promise<void> {
  const writePromise = Bun.write(path, content, { append: true });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Write timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  await Promise.race([writePromise, timeoutPromise]);
}

afterAll(async () => {
  // Skip coverage collection during mutant runs
  if (isMutantRun) return;

  // Read coverage data from Stryker's built-in coverage tracking
  const mutantCoverage = strykerGlobal.mutantCoverage;

  if (!mutantCoverage) {
    // Don't warn - this is normal if no coverage instrumentation was active
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
  // Use JSON lines format (one JSON object per line) with atomic append
  const coverageFile = process.env.__STRYKER_COVERAGE_FILE__;
  if (coverageFile) {
    try {
      // Write as a single line with newline separator for atomic append
      const jsonLine = JSON.stringify(coverageData) + '\n';
      await writeWithTimeout(coverageFile, jsonLine, 5000);
    } catch (error) {
      // Silently fail - don't break tests if coverage writing fails
      console.error('Failed to write coverage data:', error);
    }
  }
});
