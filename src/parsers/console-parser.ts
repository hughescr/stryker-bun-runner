/**
 * Console output parser for Bun test results
 * Parses Bun's console output to extract test results
 */

import path from 'node:path';
import { stripAnsi } from '../process-runner.js';
import { TEST_FILE_SUFFIX_PATTERN } from '../utils/test-name-pattern.js';

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
    /**
   * Bun's ' N error' / ' N errors' summary line: errors raised OUTSIDE any
   * single test — a test file whose import graph throws or fails to parse, a
   * describe body that throws, an unhandled rejection between tests. Bun
   * prints these as an "# Unhandled error between tests" block with no
   * `(fail)` line, so this count is the only machine-readable trace of them
   * (a describe body that throws even reports ' 0 fail'). 0 when absent.
   */
    summaryErrors:  number
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
 * is the shared TEST_FILE_SUFFIX_PATTERN so this grammar can never drift from the
 * prefix-stripping in buildTestNamePattern.
 */
const fileHeaderRe = new RegExp(String.raw`^(?:::group::)?([^:]+${TEST_FILE_SUFFIX_PATTERN}):$`, 'i');

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
 * Which file-header lines to believe, given the test files the run handed bun.
 *
 * Bun prints a failing test's error block BEFORE its `(fail)` line, and a
 * test's own console output shares the stream, so a header-shaped line can
 * appear between a file's real header and its `(fail)` line: an expect() diff
 * of a string holding one (`+ tests/foo.test.ts:`), or the output of a nested
 * bun run that a test logs. Taken as a header it would prefix the failing test
 * with the wrong file, and the name would match no dry-run test id.
 *
 * Bun prints headers only for the files it runs, relative to the cwd. An entry
 * of `testFiles` may also be a DIRECTORY (`bun.testFiles` allows one): bun then
 * runs, and prints a header for, every test file below it. So a header belongs
 * to the run when it resolves to a listed entry or to a path below one (both
 * resolved against the cwd, as bun does; a file entry has nothing below it, so
 * no file-system access is needed to tell the two apart). When the output names
 * at least one such file in a header, only headers naming files of the run are
 * believed. When none does (no list, or output this list cannot vouch for, such
 * as paths printed in a form that does not resolve to the same file), every
 * header is believed, as without a list.
 */
function headerFilter(lines: readonly string[], testFiles: readonly string[] | undefined): (file: string) => boolean {
    if(testFiles === undefined) {
        return () => true;
    }
    const roots = testFiles.map(file => path.resolve(file));
    const isRunFile = (file: string): boolean => {
        const resolved = path.resolve(file);
        return roots.some((root) => {
            const relative = path.relative(root, resolved);
            // '' is the entry itself; anything starting '..' is outside it.
            return relative !== '..' && !relative.startsWith(`..${path.sep}`);
        });
    };
    const namesRunFile = lines.some((line) => {
        const file = parseFilePath(line);
        return file !== null && isRunFile(file);
    });
    return namesRunFile ? isRunFile : () => true;
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
 * The count captured by the LAST match of `pattern` (capture group 1) in
 * `text`, or `undefined` when nothing matches. `pattern` must carry the `g`
 * flag.
 *
 * Bun prints its summary after everything else, so when a test's own console
 * output contains a line shaped like a summary line (` 3 pass`, `0 errors`,
 * `Ran 9 tests`), the last match is the real one. Every summary count shares
 * this helper so that none of them can drift back to first-match.
 */
function lastCount(text: string, pattern: RegExp): number | undefined {
    const last = [...text.matchAll(pattern)].at(-1);
    return last ? Number.parseInt(last[1], 10) : undefined;
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
    const passSummary = lastCount(output, /\s(\d+)\s+pass\b/g);
    // Stryker disable next-line Regex: word boundaries are defensive for summary parsing
    const failSummary = lastCount(output, /\s(\d+)\s+fail\b/g);
    // Stryker disable next-line Regex: word boundaries are defensive for summary parsing
    const skipSummary = lastCount(output, /\s(\d+)\s+skip\b/g);
    // Stryker disable next-line Regex: character classes are defensive for optional plural
    const bailSummary = lastCount(output, /Bailed out after (\d+) failures?/g);

    if(passSummary !== undefined) {
        counts.passed = passSummary;
    }

    if(failSummary !== undefined) {
        counts.failed = failSummary;
    }

    if(skipSummary !== undefined) {
        counts.skipped = skipSummary;
    }

    if(bailSummary !== undefined) {
        counts.failed = Math.max(counts.failed, bailSummary);
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
    const totalFromRan = lastCount(output, /Ran\s+(\d+)\s+tests?/g);
    if(totalFromRan !== undefined) {
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
 * Read bun's ' N error(s)' summary line — see {@link ParsedTestResults.summaryErrors}.
 *
 * Matched only as a WHOLE line (optional indentation, the count, the word,
 * nothing else) so failure-message prose such as "expected 2 errors" can never
 * be mistaken for it. ANSI codes are stripped first: under FORCE_COLOR bun
 * emits ' \x1B[0m\x1B[31m1 error\x1B[0m', putting the colour code between the
 * leading space and the digit (unlike its ' N pass' / ' N fail' lines, whose
 * colour code precedes the space).
 *
 * The LAST matching line wins: bun prints its summary after everything else, so
 * a test that logs a whole line like `0 errors` earlier in the output must not
 * mask (or fake) the real count.
 */
function parseSummaryErrors(output: string): number {
    return lastCount(stripAnsi(output), /^[\t ]*(\d+)[\t ]+errors?[\t ]*$/gm) ?? 0;
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
 *
 * @param testFiles - The test files the run handed bun, when it handed it any:
 *          header lines naming other files are then ignored (see {@link headerFilter})
 */
export function parseBunTestOutput(stdout: string, stderr: string, testFiles?: readonly string[]): ParsedTestResults {
    const tests: TestResult[] = [];
    const counters: TestCounters = { passed: 0, failed: 0, skipped: 0 };

    // Combine stdout and stderr for parsing
    const output = `${stdout}\n${stderr}`;
    const lines = output.split('\n');
    const isHeaderFile = headerFilter(lines, testFiles);

    let currentTest: TestResult | null = null;
    // Stryker disable next-line BooleanLiteral: initial false state is defensive; finalizeErrorMessage guards against empty errorLines
    let collectingError = false;
    let errorLines: string[] = [];
    let currentFile: string | undefined;

    for(const line of lines) {
        // Check if line is a file path
        const filePath = parseFilePath(line);
        if(filePath && isHeaderFile(filePath)) {
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
        summarySkipped: summaryCounts.skipped,
        summaryErrors:  parseSummaryErrors(output)
    };
}
