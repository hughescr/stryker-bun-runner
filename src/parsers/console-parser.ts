/**
 * Console output parser for Bun test results
 * Parses Bun's console output to extract test results
 */

export interface TestResult {
  name: string;
  file?: string;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number;
  failureMessage?: string;
}

export interface ParsedTestResults {
  tests: TestResult[];
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration?: number;
}

/**
 * Parse Bun test console output
 *
 * Example Bun output:
 * ```
 * bun test v1.x.x
 *
 * tests/example.test.ts:
 * ✓ should pass [0.12ms]
 * ✗ should fail [0.05ms]
 *   error: Expected 1 to equal 2
 * ⏭ should skip
 *
 *  2 pass
 *  1 fail
 *  1 skip
 *  3 expect() calls
 * ```
 */
export function parseBunTestOutput(stdout: string, stderr: string): ParsedTestResults {
  const tests: TestResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Combine stdout and stderr for parsing
  const output = stdout + '\n' + stderr;
  const lines = output.split('\n');

  let currentTest: TestResult | null = null;
  let collectingError = false;
  let errorLines: string[] = [];
  let currentFile: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match file header: tests/example.test.ts: or src/foo.test.tsx:
    // Ensure it only matches valid file paths (no line numbers, pipes, or comment markers)
    const fileMatch = line.match(/^([\w./-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs)):$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Match test results: ✓ test name [0.12ms]
    const passMatch = line.match(/^✓\s+(.+?)\s+\[([0-9.]+)ms\]$/);
    if (passMatch) {
      if (currentTest && collectingError) {
        currentTest.failureMessage = errorLines.join('\n').trim();
        errorLines = [];
        collectingError = false;
      }

      const testName = passMatch[1].trim();
      const fullName = currentFile ? `${currentFile} > ${testName}` : testName;

      currentTest = {
        name: fullName,
        file: currentFile,
        status: 'passed',
        duration: parseFloat(passMatch[2])
      };
      tests.push(currentTest);
      passed++;
      continue;
    }

    // Match failed tests: ✗ test name [0.05ms]
    const failMatch = line.match(/^✗\s+(.+?)(?:\s+\[([0-9.]+)ms\])?$/);
    if (failMatch) {
      if (currentTest && collectingError) {
        currentTest.failureMessage = errorLines.join('\n').trim();
        errorLines = [];
      }

      const testName = failMatch[1].trim();
      const fullName = currentFile ? `${currentFile} > ${testName}` : testName;

      currentTest = {
        name: fullName,
        file: currentFile,
        status: 'failed',
        duration: failMatch[2] ? parseFloat(failMatch[2]) : undefined
      };
      tests.push(currentTest);
      failed++;
      collectingError = true;
      continue;
    }

    // Match failed tests in bail mode: (fail) test name [0.05ms]
    const bailFailMatch = line.match(/^\(fail\)\s+(.+?)(?:\s+\[([0-9.]+)ms\])?$/);
    if (bailFailMatch) {
      if (currentTest && collectingError) {
        currentTest.failureMessage = errorLines.join('\n').trim();
        errorLines = [];
      }

      const testName = bailFailMatch[1].trim();
      const fullName = currentFile ? `${currentFile} > ${testName}` : testName;

      currentTest = {
        name: fullName,
        file: currentFile,
        status: 'failed',
        duration: bailFailMatch[2] ? parseFloat(bailFailMatch[2]) : undefined
      };
      tests.push(currentTest);
      failed++;
      collectingError = true;
      continue;
    }

    // Match skipped tests: ⏭ test name
    const skipMatch = line.match(/^⏭\s+(.+)$/);
    if (skipMatch) {
      if (currentTest && collectingError) {
        currentTest.failureMessage = errorLines.join('\n').trim();
        errorLines = [];
        collectingError = false;
      }

      const testName = skipMatch[1].trim();
      const fullName = currentFile ? `${currentFile} > ${testName}` : testName;

      currentTest = {
        name: fullName,
        file: currentFile,
        status: 'skipped'
      };
      tests.push(currentTest);
      skipped++;
      continue;
    }

    // Collect error messages for failed tests
    if (collectingError && currentTest && line.trim()) {
      // Skip summary lines
      if (!line.match(/^\s*\d+\s+(pass|fail|skip)/)) {
        errorLines.push(line);
      }
    }
  }

  // Finalize last test's error message if any
  if (currentTest && collectingError && errorLines.length > 0) {
    currentTest.failureMessage = errorLines.join('\n').trim();
  }

  // Try to parse summary for totals (fallback if individual tests not parsed correctly)
  // Summary format:
  //  N pass
  //  M fail  (may be missing if 0)
  //  K skip  (may be missing if 0)
  //  P expect() calls
  // Ran N tests across M files. [123.00ms]

  // Match summary lines with flexible whitespace handling
  // Bun outputs lines like: " 2840 pass" or " 10 fail"
  // Or in bail mode: "Bailed out after 1 failure"
  const passSummary = output.match(/\s(\d+)\s+pass\b/);
  const failSummary = output.match(/\s(\d+)\s+fail\b/);
  const skipSummary = output.match(/\s(\d+)\s+skip\b/);
  const bailSummary = output.match(/Bailed out after (\d+) failures?/);

  if (passSummary) {
    const passCount = parseInt(passSummary[1], 10);
    passed = Math.max(passed, passCount);
  }

  if (failSummary) {
    const failCount = parseInt(failSummary[1], 10);
    failed = Math.max(failed, failCount);
  }

  if (skipSummary) {
    const skipCount = parseInt(skipSummary[1], 10);
    skipped = Math.max(skipped, skipCount);
  }

  if (bailSummary) {
    const bailFailCount = parseInt(bailSummary[1], 10);
    failed = Math.max(failed, bailFailCount);
  }

  // Also try to parse from "Ran N tests" line as ultimate fallback
  const ranTestsSummary = output.match(/Ran\s+(\d+)\s+tests?/);
  if (ranTestsSummary) {
    const totalFromRan = parseInt(ranTestsSummary[1], 10);
    // Use this as source of truth for total, and derive passed if needed
    const totalParsed = passed + failed + skipped;
    if (totalParsed !== totalFromRan && passed === 0 && failed === 0) {
      // No individual counts parsed, assume all passed
      passed = totalFromRan;
    }
  }

  return {
    tests,
    totalTests: passed + failed + skipped,
    passed,
    failed,
    skipped
  };
}
