/**
 * Console output parser for Bun test results
 * Parses Bun's console output to extract test results
 */

export interface TestResult {
    name:            string
    file?:           string
    status:          'passed' | 'failed' | 'skipped'
    duration?:       number
    failureMessage?: string
}

export interface ParsedTestResults {
    tests:      TestResult[]
    totalTests: number
    passed:     number
    failed:     number
    skipped:    number
    duration?:  number
}

/**
 * Parse file path from line
 */
function parseFilePath(line: string): string | null {
    // Match file header: tests/example.test.ts: or src/foo.test.tsx:
    // Ensure it only matches valid file paths (no line numbers, pipes, or comment markers)
    const fileMatch = /^([\w./-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs)):$/.exec(line);
    return fileMatch ? fileMatch[1] : null;
}

interface TestLineParseResult {
    test?:                   TestResult
    startedCollectingError?: boolean
}

/**
 * Parse individual test result line
 */
function parseTestLine(line: string, currentFile: string | undefined): TestLineParseResult {
    // Match test results: ✓ test name [0.12ms]
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- bounded line input
    const passMatch = /^✓ +(.+) \[([0-9.]+)ms\]$/.exec(line);
    if(passMatch) {
        const testName = passMatch[1].trim();
        const fullName = currentFile ? `${currentFile} > ${testName}` : testName;
        return {
            test: {
                name:     fullName,
                file:     currentFile,
                status:   'passed',
                duration: parseFloat(passMatch[2])
            }
        };
    }

    // Match failed tests: ✗ test name [0.05ms] (timing is optional)
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- bounded line input
    const failMatch = /^✗ +(.+?)(?: \[([0-9.]+)ms\])?$/.exec(line);
    if(failMatch) {
        const testName = failMatch[1].trim();
        const fullName = currentFile ? `${currentFile} > ${testName}` : testName;
        return {
            test: {
                name:     fullName,
                file:     currentFile,
                status:   'failed',
                duration: failMatch[2] ? parseFloat(failMatch[2]) : undefined
            },
            startedCollectingError: true
        };
    }

    // Match failed tests in bail mode: (fail) test name [0.05ms] (timing is optional)
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- bounded line input
    const bailFailMatch = /^\(fail\) +(.+?)(?: \[([0-9.]+)ms\])?$/.exec(line);
    if(bailFailMatch) {
        const testName = bailFailMatch[1].trim();
        const fullName = currentFile ? `${currentFile} > ${testName}` : testName;
        return {
            test: {
                name:     fullName,
                file:     currentFile,
                status:   'failed',
                duration: bailFailMatch[2] ? parseFloat(bailFailMatch[2]) : undefined
            },
            startedCollectingError: true
        };
    }

    // Match skipped tests: ⏭ test name
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- bounded line input
    const skipMatch = /^⏭ +(.+)$/.exec(line);
    if(skipMatch) {
        const testName = skipMatch[1].trim();
        const fullName = currentFile ? `${currentFile} > ${testName}` : testName;
        return {
            test: {
                name:   fullName,
                file:   currentFile,
                status: 'skipped'
            }
        };
    }

    return {};
}

/**
 * Finalize error message for current test
 */
function finalizeErrorMessage(currentTest: TestResult | null, errorLines: string[]): void {
    if(currentTest && errorLines.length > 0) {
        currentTest.failureMessage = errorLines.join('\n').trim();
    }
}

/**
 * Check if line should be collected as error message
 */
function shouldCollectErrorLine(line: string): boolean {
    if(!line.trim()) {
        return false;
    }
    // Skip summary lines
    return !(/^\s*\d+\s+(?:pass|fail|skip)/.exec(line));
}

interface TestCounters {
    passed:  number
    failed:  number
    skipped: number
}

/**
 * Update test counters based on test status
 */
function updateCounters(test: TestResult, counters: TestCounters, parseResult: TestLineParseResult): boolean {
    if(test.status === 'passed') {
        counters.passed++;
        return false; // not collecting error
    } else if(test.status === 'failed') {
        counters.failed++;
        return parseResult.startedCollectingError ?? false;
    } else if(test.status === 'skipped') {
        counters.skipped++;
        return false; // not collecting error
    }
    return false;
}

interface SummaryCounts {
    passed:  number
    failed:  number
    skipped: number
}

/**
 * Parse summary lines from output
 */
function parseSummaryLines(output: string): SummaryCounts {
    const counts = { passed: 0, failed: 0, skipped: 0 };

    // Match summary lines with flexible whitespace handling
    // Bun outputs lines like: " 2840 pass" or " 10 fail"
    // Or in bail mode: "Bailed out after 1 failure"
    const passSummary = /\s(\d+)\s+pass\b/.exec(output);
    const failSummary = /\s(\d+)\s+fail\b/.exec(output);
    const skipSummary = /\s(\d+)\s+skip\b/.exec(output);
    const bailSummary = /Bailed out after (\d+) failures?/.exec(output);

    if(passSummary) {
        counts.passed = parseInt(passSummary[1], 10);
    }

    if(failSummary) {
        counts.failed = parseInt(failSummary[1], 10);
    }

    if(skipSummary) {
        counts.skipped = parseInt(skipSummary[1], 10);
    }

    if(bailSummary) {
        counts.failed = Math.max(counts.failed, parseInt(bailSummary[1], 10));
    }

    // Also try to parse from "Ran N tests" line as ultimate fallback
    const ranTestsSummary = /Ran\s+(\d+)\s+tests?/.exec(output);
    if(ranTestsSummary) {
        const totalFromRan = parseInt(ranTestsSummary[1], 10);
        // Use this as source of truth for total, and derive passed if needed
        const totalParsed = counts.passed + counts.failed + counts.skipped;
        if(totalParsed !== totalFromRan && counts.passed === 0 && counts.failed === 0) {
            // No individual counts parsed, assume all passed
            counts.passed = totalFromRan;
        }
    }

    return counts;
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
    const counters: TestCounters = { passed: 0, failed: 0, skipped: 0 };

    // Combine stdout and stderr for parsing
    const output = stdout + '\n' + stderr;
    const lines = output.split('\n');

    let currentTest: TestResult | null = null;
    let collectingError = false;
    let errorLines: string[] = [];
    let currentFile: string | undefined;

    for(const line of lines) {
        // Check if line is a file path
        const filePath = parseFilePath(line);
        if(filePath) {
            currentFile = filePath;
            continue;
        }

        // Try to parse as a test result line
        const parseResult = parseTestLine(line, currentFile);
        if(parseResult.test) {
            // Finalize previous test's error message if needed
            if(currentTest && collectingError) {
                finalizeErrorMessage(currentTest, errorLines);
                errorLines = [];
            }

            currentTest = parseResult.test;
            tests.push(currentTest);

            // Update counters based on test status
            collectingError = updateCounters(currentTest, counters, parseResult);
            continue;
        }

        // Collect error messages for failed tests
        if(collectingError && currentTest && shouldCollectErrorLine(line)) {
            errorLines.push(line);
        }
    }

    // Finalize last test's error message if any
    if(currentTest && collectingError) {
        finalizeErrorMessage(currentTest, errorLines);
    }

    // Parse summary lines and use them as fallback for counts
    const summaryCounts = parseSummaryLines(output);
    counters.passed = Math.max(counters.passed, summaryCounts.passed);
    counters.failed = Math.max(counters.failed, summaryCounts.failed);
    counters.skipped = Math.max(counters.skipped, summaryCounts.skipped);

    return {
        tests,
        totalTests: counters.passed + counters.failed + counters.skipped,
        passed:     counters.passed,
        failed:     counters.failed,
        skipped:    counters.skipped
    };
}
