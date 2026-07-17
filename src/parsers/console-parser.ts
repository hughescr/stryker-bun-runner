/**
 * Console output parser for Bun test results
 * Parses Bun's console output to extract test results
 */

import { TEST_FILE_EXT_PATTERN } from '../utils/test-name-pattern.js';

export interface TestResult {
    name:            string
    file?:           string
    status:          'passed' | 'failed' | 'skipped'
    duration?:       number
    failureMessage?: string
}

export interface ParsedTestResults {
    tests:          TestResult[]
    totalTests:     number
    passed:         number
    failed:         number
    skipped:        number
    duration?:      number
    /**
   * `summaryPassed`/`summaryFailed` are sourced EXCLUSIVELY from bun's genuine
   * ' N pass' / ' N fail' summary lines (plus the 'Bailed out after N
   * failures' bail variant) — never from per-line ✓/✗ matches, and, just as
   * importantly, never from the 'Ran N tests' fallback that {@link
   * parseSummaryLines} uses to backfill `passed`/`failed`/`skipped` below. The
   * 'Ran N tests' line counts skipped and not-yet-implemented tests too, while the dry-run
   * completeness gate's inspector-side count deliberately excludes them —
   * letting that fallback flow into these fields could false-fire the gate on
   * a healthy run with a meaningful skip count whenever detailed pass/fail
   * lines are absent from degraded console output. When only the fallback is
   * available, summaryPassed/summaryFailed stay 0 (and `summarySkipped` is
   * unaffected, since it's never touched by that fallback either) —
   * structurally disarming the gate's Signal A, which is the safe direction.
   * Unlike `passed`/`failed`/`skipped` above (which are `Math.max(perLine,
   * summary)`), these are summary-only so that per-ATTEMPT output from
   * retried tests (bun prints one error block per failed retry attempt, but
   * only ever one summary-counted outcome per test) can never inflate them.
   * Added for the dry-run completeness gate's Signal A (see
   * bun-test-runner.ts); existing consumers of passed/failed/skipped are
   * untouched.
   */
    summaryPassed:  number
    summaryFailed:  number
    summarySkipped: number
}

/**
 * File-header line grammar: `tests/example.test.ts:`, optionally prefixed with
 * the GitHub Actions `::group::` workflow command — bun (bun-main lineage,
 * 1.4.0-canary+) prints each test-file header as `::group::tests/foo.test.ts:`
 * when GITHUB_ACTIONS is set (and CLAUDECODE is unset). The capture group is
 * the clean path, prefix excluded.
 *
 * The path may contain any character EXCEPT `:` and both ends are anchored, so
 * stack-trace lines (`at tests/foo.test.ts:12:5`) and line-number-suffixed
 * lines (`tests/foo.test.ts:12:`) can never match. The extension alternation
 * is the shared TEST_FILE_EXT_PATTERN so this grammar can never drift from the
 * prefix-stripping in buildTestNamePattern.
 */
const fileHeaderRe = new RegExp(String.raw`^(?:::group::)?([^:]+\.${TEST_FILE_EXT_PATTERN}):$`);

/**
 * GitHub Actions workflow-command lines (`::group::Section`, `::endgroup::`,
 * `::error file=…`, annotations, matchers, masks) that bun-main emits when
 * GITHUB_ACTIONS is set. These must never reach parseTestLine or
 * failure-message collection.
 *
 * Stryker disable next-line Regex: the command-name alternation and terminator class are defensive — each realistic command shape is behaviorally pinned in console-parser tests, and unmatched lines merely fall through to the (harmless) error-line collector
 */
const workflowCommandRe = /^::(?:group|endgroup|error|warning|notice|debug|add-mask|add-matcher|remove-matcher)(?:::|\s|$)/;

/**
 * Parse file path from line
 */
function parseFilePath(line: string): string | null {
    // Match file header: tests/example.test.ts: or ::group::tests/example.test.ts:
    // Ensure it only matches valid file paths (no line numbers, pipes, or comment markers)
    const fileMatch = fileHeaderRe.exec(line);
    return fileMatch ? fileMatch[1] : null;
}

/**
 * Check whether the line is a GitHub Actions workflow command.
 * Must be checked AFTER parseFilePath in the parse loop — a `::group::` file
 * header is also a workflow-command line and must win as a header.
 */
function isWorkflowCommandLine(line: string): boolean {
    return workflowCommandRe.test(line);
}

interface TestLineParseResult {
    test?:                   TestResult
    startedCollectingError?: boolean
}

/**
 * Build a full test name by prefixing with the current file if available
 */
function buildTestName(testName: string, currentFile: string | undefined): string {
    return currentFile ? `${currentFile} > ${testName}` : testName;
}

/**
 * Parse individual test result line
 */
function parseTestLine(line: string, currentFile: string | undefined): TestLineParseResult {
    // Match test results: ✓ test name [0.12ms]

    // Stryker disable next-line Regex: anchors and character classes are defensive; input is line-by-line parsed
    const passMatch = /^✓ +(\S.*?) \[([0-9.]+)ms\]$/.exec(line);
    if(passMatch) {
        return {
            test: {
                name:     buildTestName(passMatch[1].trim(), currentFile),
                file:     currentFile,
                status:   'passed',
                duration: Number.parseFloat(passMatch[2])
            }
        };
    }

    // Match failed tests: ✗ test name [0.05ms] (timing is optional)

    // Stryker disable next-line Regex: anchors and character classes are defensive; input is line-by-line parsed
    const failMatch = /^✗ +(\S.*?)(?: \[([0-9.]+)ms\])?$/.exec(line);
    if(failMatch) {
        return {
            test: {
                name:     buildTestName(failMatch[1].trim(), currentFile),
                file:     currentFile,
                status:   'failed',
                duration: failMatch[2] ? Number.parseFloat(failMatch[2]) : undefined
            },
            startedCollectingError: true
        };
    }

    // Match failed tests in bail mode: (fail) test name [0.05ms] (timing is optional)

    // Stryker disable next-line Regex: anchors and character classes are defensive; input is line-by-line parsed
    const bailFailMatch = /^\(fail\) +(\S.*?)(?: \[([0-9.]+)ms\])?$/.exec(line);
    if(bailFailMatch) {
        return {
            test: {
                name:     buildTestName(bailFailMatch[1].trim(), currentFile),
                file:     currentFile,
                status:   'failed',
                duration: bailFailMatch[2] ? Number.parseFloat(bailFailMatch[2]) : undefined
            },
            startedCollectingError: true
        };
    }

    // Match skipped tests: ⏭ test name

    // Stryker disable next-line Regex: anchors are defensive; input is line-by-line parsed
    const skipMatch = /^⏭ +(\S.*)$/.exec(line);
    if(skipMatch) {
        return {
            test: {
                name:   buildTestName(skipMatch[1].trim(), currentFile),
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
    // Stryker disable next-line Regex: anchors and character classes are defensive; line detection pattern
    return !(/^\s*\d+\s+(?:pass|fail|skip)/.test(line));
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
        // Stryker disable next-line BooleanLiteral: default value in coalesce has no behavioral impact
        return parseResult.startedCollectingError ?? false;
    // After checking 'passed' and 'failed', only 'skipped' remains (TypeScript union exhaustiveness)
    } else {
        counters.skipped++;
        return false; // not collecting error
    }
}

interface SummaryCounts {
    passed:        number
    failed:        number
    skipped:       number
    /**
   * `passed`/`failed` as populated ONLY by genuine ' N pass' / ' N fail' (and
   * 'Bailed out after N failures') summary lines — never by the 'Ran N tests'
   * fallback below. See {@link ParsedTestResults.summaryPassed} for why this
   * distinction matters for the dry-run completeness gate.
   */
    genuinePassed: number
    genuineFailed: number
}

/**
 * Parse summary lines from output
 */
function parseSummaryLines(output: string): SummaryCounts {
    const counts = { passed: 0, failed: 0, skipped: 0 };

    // Match summary lines with flexible whitespace handling
    // Bun outputs lines like: " 2840 pass" or " 10 fail"
    // Or in bail mode: "Bailed out after 1 failure"
    // Stryker disable next-line Regex: word boundaries are defensive for summary parsing
    const passSummary = /\s(\d+)\s+pass\b/.exec(output);
    // Stryker disable next-line Regex: word boundaries are defensive for summary parsing
    const failSummary = /\s(\d+)\s+fail\b/.exec(output);
    // Stryker disable next-line Regex: word boundaries are defensive for summary parsing
    const skipSummary = /\s(\d+)\s+skip\b/.exec(output);
    // Stryker disable next-line Regex: character classes are defensive for optional plural
    const bailSummary = /Bailed out after (\d+) failures?/.exec(output);

    if(passSummary) {
        counts.passed = Number.parseInt(passSummary[1], 10);
    }

    if(failSummary) {
        counts.failed = Number.parseInt(failSummary[1], 10);
    }

    if(skipSummary) {
        counts.skipped = Number.parseInt(skipSummary[1], 10);
    }

    if(bailSummary) {
        counts.failed = Math.max(counts.failed, Number.parseInt(bailSummary[1], 10));
    }

    // Snapshot the genuine-only counts NOW, before the 'Ran N tests' fallback below can
    // inflate `counts.passed`. 'Ran N tests' includes skipped and not-yet-implemented tests, while the
    // dry-run completeness gate's inspector-side count (nonSkippedExecutionCount)
    // excludes them — letting the fallback flow into summaryPassed/summaryFailed could
    // false-fire the gate (DryRunStatus.Error) on a healthy run with a meaningful skip
    // count whenever the detailed pass/fail summary lines are absent from degraded output.
    const genuinePassed = counts.passed;
    const genuineFailed = counts.failed;

    // Also try to parse from "Ran N tests" line as ultimate fallback
    // Stryker disable next-line Regex: character classes are defensive for optional plural
    const ranTestsSummary = /Ran\s+(\d+)\s+tests?/.exec(output);
    if(ranTestsSummary) {
        const totalFromRan = Number.parseInt(ranTestsSummary[1], 10);
        // Use this as source of truth for total, and derive passed if needed
        // Stryker disable next-line ArithmeticOperator: condition requires passed=0 and failed=0, making arithmetic mutations equivalent
        const totalParsed = counts.passed + counts.failed + counts.skipped;
        if(totalParsed !== totalFromRan && counts.passed === 0 && counts.failed === 0) {
            // No individual counts parsed, assume all passed
            counts.passed = totalFromRan;
        }
    }

    return { ...counts, genuinePassed, genuineFailed };
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
    const output = `${stdout}\n${stderr}`;
    const lines = output.split('\n');

    let currentTest: TestResult | null = null;
    // Stryker disable next-line BooleanLiteral: initial false state is defensive; finalizeErrorMessage guards against empty errorLines
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

        // Skip GHA workflow-command lines (checked AFTER the header match above,
        // so a ::group::-prefixed file header is consumed as a header first) —
        // they must neither parse as test lines nor collect into failure messages.
        if(isWorkflowCommandLine(line)) {
            continue;
        }

        // Try to parse as a test result line
        const parseResult = parseTestLine(line, currentFile);
        if(parseResult.test) {
            // Finalize previous test's error message if needed
            // Stryker disable next-line ConditionalExpression,LogicalOperator: finalizeErrorMessage guards against empty errorLines; condition is defensive
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

    // Finalize last test's error message if any. No conditional needed:
    // finalizeErrorMessage guards internally (null currentTest / empty
    // errorLines are no-ops), and errorLines is only ever non-empty while
    // collectingError is true.
    finalizeErrorMessage(currentTest, errorLines);

    // Parse summary lines and use them as fallback for counts
    const summaryCounts = parseSummaryLines(output);
    counters.passed = Math.max(counters.passed, summaryCounts.passed);
    counters.failed = Math.max(counters.failed, summaryCounts.failed);
    counters.skipped = Math.max(counters.skipped, summaryCounts.skipped);

    return {
        tests,
        totalTests:     counters.passed + counters.failed + counters.skipped,
        passed:         counters.passed,
        failed:         counters.failed,
        skipped:        counters.skipped,
        summaryPassed:  summaryCounts.genuinePassed,
        summaryFailed:  summaryCounts.genuineFailed,
        summarySkipped: summaryCounts.skipped
    };
}
