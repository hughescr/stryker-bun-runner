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
    /** A failing test's error report, as bun printed it before the test's `(fail)` line; see failureMessageFrom. */
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
   * The summary* counts are sourced EXCLUSIVELY from bun's own summary block:
   * its ' N pass' / ' N fail' / ' N skip' / pending-count / ' N error' lines
   * (plus the 'Bailed out after N failures' bail variant), read with colour
   * codes stripped — never from per-line ✓/✗ matches, never from a line of a
   * test's own console output that merely looks like a summary line (see
   * {@link readBunSummary} for how the block is located), and never from the
   * 'Ran N tests' fallback that {@link parseSummaryLines} uses to backfill
   * `passed`/`failed`/`skipped` below ('Ran N tests' counts every status at
   * once). Each is 0 when its line is absent; bun prints the pass and fail
   * lines on every run, even when their count is 0.
   * Unlike `passed`/`failed`/`skipped` above (which are `Math.max(perLine,
   * summary)`), these are summary-only so that per-ATTEMPT output from
   * retried tests (bun prints one error block per failed retry attempt, but
   * only ever one summary-counted outcome per test) can never inflate them.
   * The dry-run completeness gate (bun-test-runner.ts) compares each with
   * the inspector's count of tests with that status.
   */
    summaryPassed:  number
    summaryFailed:  number
    summarySkipped: number
    summaryTodo:    number
    /**
   * Bun's ' N error' / ' N errors' summary line: errors raised OUTSIDE any
   * single test — a test file whose import graph throws or fails to parse, a
   * describe body that throws, an unhandled rejection between tests. Bun
   * prints these as an "# Unhandled error between tests" block with no
   * `(fail)` line, so this count is the only machine-readable trace of them
   * (a describe body that throws even reports ' 0 fail'). 0 when absent.
   */
    summaryErrors:  number
    /**
   * Whether bun got as far as printing its summary: the output holds a
   * 'Ran N tests' line or a ' N pass' line. False when it holds neither, which
   * on a run that was not killed from outside means the bun process left
   * early (a test or hook called process.exit, or the process crashed) and
   * every summary* count above is 0 for lack of a summary rather than because
   * nothing happened.
   */
    summaryPrinted: boolean
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
export const fileHeaderRe = new RegExp(String.raw`^(?:::group::)?([^:]+${TEST_FILE_SUFFIX_PATTERN}):$`, 'i');

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
    const roots = new Set(testFiles.map(file => path.resolve(file)));
    // A header is in the run when it IS a listed entry or lies below one (a directory entry): that is, when it or one of
    // its parent directories is in the set. A walk up its few parents replaces comparing it with every entry.
    const isRunFile = (file: string): boolean => {
        let candidate = path.resolve(file);
        while(!roots.has(candidate)) {
            const parent = path.dirname(candidate);
            if(parent === candidate) {
                return false;
            }
            candidate = parent;
        }
        return true;
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

/** The longest failureMessage the parser returns: a longer report keeps its start and says how much it left out. */
export const MAX_FAILURE_MESSAGE_LENGTH = 4000;

interface TestLineParseResult {
    test?: TestResult
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
            }
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
            }
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
 * A line that reports a test which did not fail, in bun 1.4's piped form or its FORCE_COLOR form
 * (colour codes removed): `(pass) name [0.03ms]` / `✓ name`, `(skip) name` / `» name`, the
 * pending-test line / `✎ name`, and older bun's `⏭ name`. Such a line ends the output a later
 * failing test's error report can be in. (The `✓` and `⏭` forms are also read as tests by
 * parseTestLine; nothing scores passing tests from the per-line output, so the others are not.)
 */
const NON_FAILING_RESULT_LINE = /^(?:\((?:pass|skip|todo)\)|[✓»✎⏭]) +\S/;

/**
 * A line of bun's code frame, which opens its report of an error: `12 | expect(a).toBe(b);`
 * (`12 |` alone for a blank source line).
 */
const CODE_FRAME_LINE = /^\s*\d+ \|(?: |$)/;

/**
 * The heading line of bun's report of an error, which opens the report when bun has no source to
 * frame: `error: message` for an Error, `TypeError: …`, `AssertionError [ERR_ASSERTION]: …`.
 */
const ERROR_HEADING_LINE = /^(?:error|\w*Error)(?: \[[^\]]*\])?: /;

/**
 * A note bun prints right AFTER a `(fail)` line, about that test: `  ^ this test timed out after
 * 5000ms.`, `  ^ this test is marked as failing but it passed. …`. The caret under a code frame
 * stands alone on its line, so it never matches.
 */
const AFTER_FAIL_NOTE_LINE = /^\s+\^ \S/;

/** `message`, cut to {@link MAX_FAILURE_MESSAGE_LENGTH} characters with a note of what was cut. */
function capFailureMessage(message: string): string {
    return message.length > MAX_FAILURE_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}\n… (${message.length - MAX_FAILURE_MESSAGE_LENGTH} more characters)`
        : message;
}

/**
 * A failing test's failureMessage, from the lines between the previous file header, test line or
 * failing test's note and its own `(fail)` line, or undefined when bun printed nothing there.
 *
 * Bun prints a failing test's report BEFORE its `(fail)` line: a code frame, the error heading,
 * the expected/received diff, the stack. Without `onlyFailures` it comes right after the previous
 * test's line. With it (mutant runs) no line marks where a passing test ended, so what a passing
 * test, or the failing test itself, printed on stderr can come first; the message therefore starts
 * at the first code-frame line, or without one at the first error heading, and keeps the whole
 * block only when it has neither. GitHub Actions workflow commands are left out.
 */
function failureMessageFrom(block: readonly string[]): string | undefined {
    const report = block.filter(line => !isWorkflowCommandLine(line));
    const frameStart = report.findIndex(line => CODE_FRAME_LINE.test(line));
    const start = frameStart === -1 ? report.findIndex(line => ERROR_HEADING_LINE.test(line)) : frameStart;
    const message = report.slice(Math.max(start, 0)).join('\n').trim();
    return message === '' ? undefined : capFailureMessage(message);
}

interface TestCounters {
    passed:  number
    failed:  number
    skipped: number
}

/** What {@link parseBunTestOutput} has read so far, line by line. */
interface LineReader {
    readonly lines:        readonly string[]
    readonly isHeaderFile: (file: string) => boolean
    readonly tests:        TestResult[]
    readonly counters:     TestCounters
    currentFile:           string | undefined
    /**
     * Where the output a failing test's error report can be in starts: the line after the last
     * file header, test line or failing test's note (see failureMessageFrom).
     */
    blockStart:            number
    /**
     * The failing test whose `(fail)` line (or a note after it) is the line just read: bun prints a
     * timeout's or a passing `.failing` test's `  ^ …` note right after that line.
     */
    lastFailed:            TestResult | undefined
}

/** Record a test line's test, with its failure message when it failed. */
function recordTest(reader: LineReader, test: TestResult, index: number): void {
    if(test.status === 'failed') {
        const failureMessage = failureMessageFrom(reader.lines.slice(reader.blockStart, index));
        if(failureMessage !== undefined) {
            test.failureMessage = failureMessage;
        }
        reader.lastFailed = test;
    }
    reader.tests.push(test);
    reader.counters[test.status]++;
    reader.blockStart = index + 1;
}

/** Read line `index` of the output. */
function readLine(reader: LineReader, index: number): void {
    const line = reader.lines[index];
    const filePath = parseFilePath(line);
    if(filePath && reader.isHeaderFile(filePath)) {
        reader.currentFile = filePath;
        reader.blockStart = index + 1;
        reader.lastFailed = undefined;
        return;
    }

    // Skip GHA workflow-command lines (checked AFTER the header match above,
    // so a ::group::-prefixed file header is consumed as a header first) —
    // they must neither parse as test lines nor end up in failure messages.
    if(isWorkflowCommandLine(line)) {
        return;
    }

    if(reader.lastFailed && AFTER_FAIL_NOTE_LINE.test(line)) {
        const note = line.trim();
        const before = reader.lastFailed.failureMessage;
        reader.lastFailed.failureMessage = capFailureMessage(before === undefined ? note : `${before}\n${note}`);
        reader.blockStart = index + 1;
        return;
    }
    reader.lastFailed = undefined;

    const { test } = parseTestLine(line, reader.currentFile);
    if(test) {
        recordTest(reader, test, index);
    } else if(NON_FAILING_RESULT_LINE.test(line)) {
        reader.blockStart = index + 1;
    }
}

interface SummaryCounts {
    passed:        number
    failed:        number
    skipped:       number
    todo:          number
    errors:        number
    /** Whether bun got as far as printing its summary — see {@link ParsedTestResults.summaryPrinted}. */
    printed:       boolean
    /**
   * `passed`/`failed` as populated ONLY by genuine ' N pass' / ' N fail' (and
   * 'Bailed out after N failures') summary lines — never by the 'Ran N tests'
   * fallback below. See {@link ParsedTestResults.summaryPassed} for why this
   * distinction matters for the dry-run completeness gate.
   */
    genuinePassed: number
    genuineFailed: number
}

/** `Ran 4 tests across 1 file. [7.00ms]` (`Ran 1 test across…` for one): bun's last summary line. */
export const RAN_LINE = /^\s*Ran\s+(\d+)\s+tests?\b/;
/** The first line of bun's summary block. It is printed on every run that reaches the summary, even with a count of 0. */
const PASS_LINE = /^\s*\d+\s+pass\s*$/;
/** One count line of the summary block: the pass, skip, pending-test, fail and error(s) counts, e.g. ` 2 pass` or ` 2 errors`. */
const COUNT_LINE = /^\s*(\d+)\s+(pass|skip|todo|fail|errors?)\s*$/;
/** `Bailed out after 1 failure`: printed after the Ran line when --bail stops the run. */
const BAIL_LINE = /^\s*Bailed out after (\d+) failures?\s*$/;

/**
 * The last line at or before index `from` that matches `pattern`, with its
 * index, or `undefined`. With `stopAtBlank` the search gives up at the first
 * blank line it reaches.
 */
function lastLineMatching(
    lines: readonly string[],
    from: number,
    pattern: RegExp,
    stopAtBlank: boolean
): { index: number, match: RegExpExecArray } | undefined {
    for(let index = from; index >= 0; index--) {
        const match = pattern.exec(lines[index]);
        if(match) {
            return { index, match };
        }
        if(stopAtBlank && !lines[index].trim()) {
            return undefined;
        }
    }
    return undefined;
}

type CountWord = 'pass' | 'skip' | 'todo' | 'fail' | 'error';

/**
 * The counts of bun's own summary block, with 0 for every line it did not
 * print (bun prints the skip, pending-test and error lines only when their
 * count is not 0).
 */
interface BunSummary extends Record<CountWord, number> {
    /** The `N` of the `Ran N tests` line, when there is one. */
    ran:     number | undefined
    /** The `N` of the `Bailed out after N failures` line, when there is one. */
    bailed:  number | undefined
    /** Whether the output holds a `Ran N tests` line or a ` N pass` line. */
    printed: boolean
}

/**
 * Read bun's summary block out of the run's output. Everything a summary count
 * is taken from comes through here, and ONLY from the block itself.
 *
 * A test's own console output shares the stream and can print lines shaped
 * exactly like summary lines (a whole line of ` 3 skip`, ` 3 pass`, ` 3 fail`
 * or ` 3 errors`, a pending-test count, or `Ran 9 tests`). Reading counts
 * anywhere in the output would let a test fake them (a test logging a pending
 * count made the dry run fail on every run); bun prints its summary after
 * everything a test can log, so the block is located from the end. Bun 1.3.7,
 * 1.3.14 and 1.4.2 all print, with every reporter and with or without colour
 * (`--dots` drops the leading space):
 *
 * ```
 *  2 pass            <- always printed; the first line of the block
 *  1 skip            <- only when not 0
 *  1 (pending)       <- the pending-test count, only when not 0
 *  0 fail            <- always printed
 *  1 error           <- only when not 0
 *  1 expect() calls  <- (and "N filtered out", "snapshots: …" lines, in places)
 * Ran 4 tests across 1 file. [7.00ms]
 * Bailed out after 1 failure   <- only when --bail stopped the run; no counts then
 * ```
 *
 * So the block runs from the ` N pass` line nearest above the LAST `Ran N tests`
 * line (the search gives up at a blank line, so it cannot wander into the
 * test output of a --bail run, which prints no counts) to the Ran line.
 * Lines after the Ran line are not counted, except the bail line. A run with no
 * Ran line (cut off before the summary; older tests' fixtures) uses the last
 * ` N pass` line to the end of the output instead, and a run with neither has
 * no summary at all: every count is 0 and `printed` is false.
 *
 * Within the block each line must be a WHOLE count line, so a failure message
 * such as "expected 2 errors" cannot be mistaken for one. ANSI codes are
 * stripped first: under FORCE_COLOR the colour code sits before the leading
 * space of the pass and fail lines but between the space and the digit of the
 * others.
 */
function readBunSummary(output: string): BunSummary {
    const lines = stripAnsi(output).split('\n');
    const lastIndex = lines.length - 1;

    const ran = lastLineMatching(lines, lastIndex, RAN_LINE, false);
    const pass = ran
        ? lastLineMatching(lines, ran.index - 1, PASS_LINE, true)
        : lastLineMatching(lines, lastIndex, PASS_LINE, false);

    const summary: BunSummary = {
        pass:    0,
        skip:    0,
        todo:    0,
        fail:    0,
        error:   0,
        ran:     ran && Number.parseInt(ran.match[1], 10),
        bailed:  undefined,
        printed: ran !== undefined || pass !== undefined,
    };

    if(pass) {
        for(const line of lines.slice(pass.index, ran?.index ?? lines.length)) {
            const match = COUNT_LINE.exec(line);
            if(match) {
                summary[match[2] === 'errors' ? 'error' : match[2] as CountWord] = Number.parseInt(match[1], 10);
            }
        }
    }

    for(const line of lines.slice(ran?.index ?? 0)) {
        const match = BAIL_LINE.exec(line);
        if(match) {
            summary.bailed = Number.parseInt(match[1], 10);
        }
    }

    return summary;
}

/**
 * Parse summary lines from output
 */
function parseSummaryLines(output: string): SummaryCounts {
    const bun = readBunSummary(output);
    const counts = { passed: bun.pass, failed: bun.fail, skipped: bun.skip };

    // Or in bail mode: "Bailed out after 1 failure"
    if(bun.bailed !== undefined) {
        counts.failed = Math.max(counts.failed, bun.bailed);
    }

    // Snapshot the genuine-only counts NOW, before the 'Ran N tests' fallback below can
    // inflate `counts.passed`. 'Ran N tests' includes skipped and pending tests, while the
    // dry-run completeness gate compares each status's count with the inspector's own.
    const genuinePassed = counts.passed;
    const genuineFailed = counts.failed;

    // Also try to parse from "Ran N tests" line as ultimate fallback
    if(bun.ran !== undefined) {
        // Use this as source of truth for total, and derive passed if needed
        // Stryker disable next-line ArithmeticOperator: condition requires passed=0 and failed=0, making arithmetic mutations equivalent
        const totalParsed = counts.passed + counts.failed + counts.skipped;
        if(totalParsed !== bun.ran && counts.passed === 0 && counts.failed === 0) {
            // No individual counts parsed, assume all passed
            counts.passed = bun.ran;
        }
    }

    return { ...counts, todo: bun.todo, errors: bun.error, printed: bun.printed, genuinePassed, genuineFailed };
}

/**
 * Parse Bun test console output
 *
 * Example Bun output (bun 1.4, piped; under FORCE_COLOR `✓`/`✗`/`»` replace
 * `(pass)`/`(fail)`/`(skip)`, and every line is read without its colour codes):
 * ```
 * bun test v1.4.2 (744846f84)
 *
 * tests/example.test.ts:
 * (pass) should pass [0.12ms]
 * 3 |     expect(1).toBe(2);
 *                   ^
 * error: expect(received).toBe(expected)
 *       at <anonymous> (/project/tests/example.test.ts:3:15)
 * (fail) should fail [0.05ms]
 * (skip) should skip
 *
 *  1 pass
 *  1 skip
 *  1 fail
 *  2 expect() calls
 * Ran 3 tests across 1 file. [7.00ms]
 * ```
 *
 * A failing test's report comes BEFORE its `(fail)` line and becomes its
 * failureMessage (see {@link failureMessageFrom}). With `onlyFailures` (mutant
 * runs) bun prints no `(pass)` or `(skip)` line.
 *
 * @param testFiles - The test files the run handed bun, when it handed it any:
 *          header lines naming other files are then ignored (see {@link headerFilter})
 */
export function parseBunTestOutput(stdout: string, stderr: string, testFiles?: readonly string[]): ParsedTestResults {
    const tests: TestResult[] = [];
    const counters: TestCounters = { passed: 0, failed: 0, skipped: 0 };

    // Combine stdout and stderr for parsing
    const output = `${stdout}\n${stderr}`;
    // Every line is matched without its colour codes. Under FORCE_COLOR (which reaches the child
    // from the environment Stryker runs in) bun colours its test lines even when piped:
    // `ESC[0mESC[31m✗ESC[0m ESC[0mmathESC[2m >ESC[0mESC[1m adds…`, which no pattern below matches raw.
    // Stripped line by line, so an unterminated escape sequence a test printed cannot swallow a newline.
    const lines = output.split('\n').map(line => stripAnsi(line));
    const reader: LineReader = {
        lines,
        isHeaderFile: headerFilter(lines, testFiles),
        tests,
        counters,
        currentFile:  undefined,
        blockStart:   0,
        lastFailed:   undefined,
    };
    for(let index = 0; index < lines.length; index++) {
        readLine(reader, index);
    }

    // Parse summary lines and use them as fallback for counts. Only bun's own summary
    // block counts (see readBunSummary), read without colour codes.
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
        summaryTodo:    summaryCounts.todo,
        summaryErrors:  summaryCounts.errors,
        summaryPrinted: summaryCounts.printed
    };
}
