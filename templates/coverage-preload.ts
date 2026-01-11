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

beforeEach(() => {
  // Skip coverage tracking during mutant runs
  if (isMutantRun) return;

  // Get the current test name from Bun's test context
  // Bun doesn't have expect.getState() like Jest, so we use a counter-based approach
  let testName: string | undefined;

  try {
    // Try to access Bun's test context if available
    const bunTestContext = (globalThis as any).__bunTestContext__;
    if (bunTestContext && bunTestContext.testName) {
      testName = bunTestContext.testName;
    }
  } catch {
    // Ignore - context not available
  }

  // Fallback to counter-based approach
  // Use only counter (no PID) so test IDs are consistent across workers
  testCounter++;
  currentTestId = testName ?? `test-${testCounter}`;
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
