/**
 * The summary counts (pass, fail, skip, pending, error) are read only from bun's
 * own summary block, so a test's console output cannot fake them.
 *
 * Fixtures are byte-exact captures of real `bun test` runs (bun 1.4.2 and 1.3.7,
 * stdout and stderr on separate pipes, as the runner collects them) of a file
 * whose first test logs lookalike lines (` 3 skip` on stdout, ` 4 pass` on
 * stderr, and a sentence containing a pending-test count), and whose other tests
 * are one skipped, one pending and one passing test. The real counts are
 * 2 pass, 1 skip, 1 pending, 0 fail. Only the colour codes differ between the
 * plain, FORCE_COLOR and `--dots` captures.
 */

import { describe, it, expect } from 'bun:test';
import { parseBunTestOutput } from '../../src/parsers/console-parser.js';

const ESC = '\u001B';

describe('parseBunTestOutput summary block', () => {
    describe('real bun 1.4.2 output of a passing test that only logs a lookalike line (bun prints no skip or todo line)', () => {
        it('a test logging "you have 3 todo items" has no todo tests', () => {
            const result = parseBunTestOutput(
                'bun test v1.4.2 (744846f84)\nyou have 3 todo items\n',
                '\na.test.ts:\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [9.00ms]\n'
            );

            expect(result.summaryTodo).toBe(0);
            expect(result.summaryPassed).toBe(1);
        });

        it('a test logging the whole lines " 7 pass", " 2 fail" and " 3 skip" (and "Ran 99 tests" on stderr)', () => {
            const result = parseBunTestOutput(
                'bun test v1.4.2 (744846f84)\n\n 7 pass\n 2 fail\n 3 skip\n',
                'Ran 99 tests\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [26.00ms]\n'
            );

            expect(result.summarySkipped).toBe(0);
            expect(result.summaryPassed).toBe(1);
            expect(result.summaryFailed).toBe(0);
            expect(result.passed).toBe(1);
            expect(result.failed).toBe(0);
        });
    });

    describe('real bun output whose tests print lookalike summary lines', () => {
        it('bun 1.4.2 plain output (the case that made the dry run fail on "you have 3 todo items")', () => {
            const stdout = 'bun test v1.4.2 (744846f84)\nyou have 3 todo items\n 3 skip\n';
            const stderr = '\na.test.ts:\n 4 pass\n\n 2 pass\n 1 skip\n 1 todo\n 0 fail\n 1 expect() calls\nRan 4 tests across 1 file. [7.00ms]\n';
            const result = parseBunTestOutput(stdout, stderr);

            expect(result.summaryPassed).toBe(2);
            expect(result.summarySkipped).toBe(1);
            expect(result.summaryTodo).toBe(1);
            expect(result.summaryFailed).toBe(0);
            expect(result.summaryErrors).toBe(0);
            expect(result.summaryPrinted).toBe(true);
        });

        it('bun 1.4.2 under FORCE_COLOR, where stdout and stderr share one stream', () => {
            const output = `${ESC}[0m${ESC}[1mbun test ${ESC}[0m${ESC}[2mv1.4.2 (744846f84)${ESC}[0m\n${ESC}[0m\n`
              + 'a.test.ts:\nyou have 3 todo items\n 3 skip\n'
              + `${ESC}[0m${ESC}[31m 4 pass${ESC}[0m\n\n`
              + `${ESC}[0m${ESC}[32m 2 pass${ESC}[0m\n ${ESC}[0m${ESC}[33m1 skip${ESC}[0m\n ${ESC}[0m${ESC}[35m1 todo${ESC}[0m\n`
              + `${ESC}[0m${ESC}[2m 0 fail${ESC}[0m\n 1 expect() calls\n`
              + `Ran 4 tests across 1 file. ${ESC}[0m${ESC}[2m[${ESC}[1m9.00ms${ESC}[0m${ESC}[2m]${ESC}[0m\n`;
            const result = parseBunTestOutput(output, '');

            expect(result.summaryPassed).toBe(2);
            expect(result.summarySkipped).toBe(1);
            expect(result.summaryTodo).toBe(1);
            expect(result.summaryFailed).toBe(0);
        });

        it('bun 1.4.2 with --dots (no leading space on the summary lines)', () => {
            const output = `${ESC}[0m${ESC}[1mbun test ${ESC}[0m${ESC}[2mv1.4.2 (744846f84)${ESC}[0m\n${ESC}[0m\n`
              + 'a.test.ts:\nyou have 3 todo items\n 3 skip\n'
              + `${ESC}[0m${ESC}[31m 4 pass${ESC}[0m\n`
              + `${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[0m${ESC}[33m.${ESC}[2m${ESC}[0m${ESC}[35m.${ESC}[0m${ESC}[0m${ESC}[32m.${ESC}[0m\n\n`
              + `${ESC}[0m${ESC}[32m2 pass${ESC}[0m\n${ESC}[0m${ESC}[33m1 skip${ESC}[0m\n${ESC}[0m${ESC}[35m1 todo${ESC}[0m\n`
              + `${ESC}[0m${ESC}[2m0 fail${ESC}[0m\n1 expect() calls\n`
              + `Ran 4 tests across 1 file. ${ESC}[0m${ESC}[2m[${ESC}[1m9.00ms${ESC}[0m${ESC}[2m]${ESC}[0m\n`;
            const result = parseBunTestOutput(output, '');

            expect(result.summaryPassed).toBe(2);
            expect(result.summarySkipped).toBe(1);
            expect(result.summaryTodo).toBe(1);
            expect(result.summaryFailed).toBe(0);
        });

        it('bun 1.3.7 plain output', () => {
            const stdout = 'bun test v1.3.7 (ba426210)\nyou have 3 todo items\n 3 skip\n';
            const stderr = '\na.test.ts:\n 4 pass\n\n 2 pass\n 1 skip\n 1 todo\n 0 fail\n 1 expect() calls\nRan 4 tests across 1 file. [20.00ms]\n';
            const result = parseBunTestOutput(stdout, stderr);

            expect(result.summaryPassed).toBe(2);
            expect(result.summarySkipped).toBe(1);
            expect(result.summaryTodo).toBe(1);
        });
    });

    describe('lookalike lines cannot reach the counts', () => {
        it.each([
            ['todo', ' 3 todo', 'summaryTodo'],
            ['skip', ' 3 skip', 'summarySkipped'],
            ['fail', ' 3 fail', 'summaryFailed'],
            ['error', ' 3 errors', 'summaryErrors'],
        ] as const)('a %s lookalike directly above the block, with no blank line to separate it', (_word, lookalike, field) => {
            // The test's line has no trailing newline, so bun's own leading newline ends it
            // instead of leaving a blank line: the lookalike is adjacent to the real " 2 pass".
            const stderr = `${lookalike}\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [5.00ms]\n`;
            const result = parseBunTestOutput('', stderr);

            expect(result[field]).toBe(0);
            expect(result.summaryPassed).toBe(2);
        });

        it('a pass lookalike above the block, however large', () => {
            const result = parseBunTestOutput(' 100 pass\n', ' 100 pass\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [5.00ms]\n');

            expect(result.summaryPassed).toBe(2);
            expect(result.passed).toBe(2);
        });

        it('lookalike skip, todo, fail and error lines above the block with the real block lacking some of them', () => {
            const stderr = ' 9 skip\n 8 todo\n 7 fail\n 6 error\n\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [5.00ms]\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summarySkipped).toBe(0);
            expect(result.summaryTodo).toBe(0);
            expect(result.summaryFailed).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });

        it('lines printed after the "Ran N tests" line (for example by an exit handler)', () => {
            const stderr = ' 2 pass\n 0 fail\nRan 2 tests across 1 file. [5.00ms]\n 9 pass\n 3 todo\n 4 skip\n 5 fail\n 6 errors\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(2);
            expect(result.summaryFailed).toBe(0);
            expect(result.summaryTodo).toBe(0);
            expect(result.summarySkipped).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });

        it('a "Ran N tests" lookalike above the real one', () => {
            const result = parseBunTestOutput('', 'Ran 99 tests across 1 file.\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [5.00ms]\n');

            expect(result.summaryPassed).toBe(2);
            expect(result.summaryPrinted).toBe(true);
        });

        it('a whole summary block printed by a test, above the real block', () => {
            const stdout = '\n 7 pass\n 2 fail\n 3 skip\n 4 todo\n 5 errors\nRan 99 tests across 1 file. [1.00ms]\n';
            const stderr = '\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n';
            const result = parseBunTestOutput(stdout, stderr);

            expect(result.summaryPassed).toBe(1);
            expect(result.summaryFailed).toBe(0);
            expect(result.summarySkipped).toBe(0);
            expect(result.summaryTodo).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });

        it('prose that merely contains a count and a summary word is not a summary line', () => {
            // Inside the block's own region, so only the line grammar can reject them. The prose
            // pass lines sit nearer the Ran line than the real " 2 pass", and must not become
            // the start of the block (which would lose the real " 0 fail" line above them).
            const stderr = [
                ' 2 pass',
                ' 1 fail',
                'you have 3 todo items', '3 skip it', 'x 3 skip', 'about 3 todo', '3 skipped', '3 failed', '3 todos', '3 errorsX', 'x 5 error',
                '3 passes', '3 pass:', 'x 4 pass', '9 failures',
                'Ran 2 tests across 1 file. [5.00ms]',
            ].join('\n');
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(2);
            expect(result.summaryFailed).toBe(1);
            expect(result.summaryTodo).toBe(0);
            expect(result.summarySkipped).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });

        it('count lines with trailing prose inside the block region are rejected', () => {
            const stderr = ' 2 pass\n 5 skip for now\n 6 todo list\n 7 fail soon\n 8 errors found\nRan 2 tests across 1 file. [5.00ms]\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summarySkipped).toBe(0);
            expect(result.summaryTodo).toBe(0);
            expect(result.summaryFailed).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });
    });

    describe('the shapes of a real summary block', () => {
        it('reads every count of a block that has all of them', () => {
            const stderr = '\n 17 pass\n 5 skip\n 2 todo\n 3 fail\n 1 error\n 40 expect() calls\nRan 28 tests across 3 files. [49.00ms]\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(17);
            expect(result.summarySkipped).toBe(5);
            expect(result.summaryTodo).toBe(2);
            expect(result.summaryFailed).toBe(3);
            expect(result.summaryErrors).toBe(1);
        });

        it('reads the plural form of errors, with tab separators and trailing whitespace', () => {
            const result = parseBunTestOutput('', '\n\t3\tpass \t\n 0 fail\n \t12 errors \t\nRan 3 tests across 1 file. [5.00ms]\n');

            expect(result.summaryPassed).toBe(3);
            expect(result.summaryErrors).toBe(12);
        });

        it('treats a missing line as 0', () => {
            const result = parseBunTestOutput('', '\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n');

            expect(result.summarySkipped).toBe(0);
            expect(result.summaryTodo).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });

        it('copes with lines bun adds between the counts (filtered out, snapshots, seed)', () => {
            // bun 1.4.2 (separate lines) and bun 1.3.7 (one combined line), -t / --seed / snapshot runs.
            const stderr14 = ' --seed=3511791909\n 3 pass\n 1 skip\n 3 filtered out\n 0 fail\n 1 error\nsnapshots: +2 added\n 2 expect() calls\nRan 4 tests across 1 file. [7.00ms]\n';
            const stderr13 = ' 3 pass\n 1 skip\n 0 fail\n 1 error\n 2 snapshots, 2 expect() calls\nRan 4 tests across 1 file. [15.00ms]\n';

            const a = parseBunTestOutput('', stderr14);
            expect(a.summaryPassed).toBe(3);
            expect(a.summarySkipped).toBe(1);
            expect(a.summaryFailed).toBe(0);
            expect(a.summaryErrors).toBe(1);

            const b = parseBunTestOutput('', stderr13);
            expect(b.summaryPassed).toBe(3);
            expect(b.summarySkipped).toBe(1);
            expect(b.summaryErrors).toBe(1);
        });

        it('reads a block that follows a coverage table', () => {
            const stderr = '-----|-----\nAll files | 100\n-----|-----\n\n 5 pass\n 0 fail\n 5 expect() calls\nRan 5 tests across 2 files. [32.19s]\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(5);
        });

        it('reads the block when the whole output is on stdout and stderr is empty', () => {
            const result = parseBunTestOutput('\n 4 pass\n 1 fail\nRan 5 tests across 1 file. [5.00ms]\n', '');

            expect(result.summaryPassed).toBe(4);
            expect(result.summaryFailed).toBe(1);
        });

        it('reads the block when the output uses carriage return plus newline line ends', () => {
            const result = parseBunTestOutput('', '\r\n 4 pass\r\n 1 fail\r\nRan 5 tests across 1 file. [5.00ms]\r\n');

            expect(result.summaryPassed).toBe(4);
            expect(result.summaryFailed).toBe(1);
        });

        it('a run that failed to load (0 pass, 1 fail, 1 error)', () => {
            const stderr = '\n# Unhandled error between tests\n-------------------------------\nerror: Cannot find module\n-------------------------------\n\n\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file. [6.00ms]\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(0);
            expect(result.summaryFailed).toBe(1);
            expect(result.summaryErrors).toBe(1);
        });
    });

    describe('bail output (bun prints no counts, only the Ran line and the "Bailed out" line)', () => {
        it('reads the bail line that follows the Ran line', () => {
            const result = parseBunTestOutput('', '✗ bad [0.56ms]\nRan 1 test across 1 file. [9.00ms]\nBailed out after 3 failures\n');

            expect(result.failed).toBe(3);
            expect(result.summaryFailed).toBe(3);
            expect(result.summaryPrinted).toBe(true);
        });

        it('ignores a test-printed pass lookalike separated from the Ran line by a blank line', () => {
            const stderr = ' 5 pass\n\n✗ bad [0.56ms]\nRan 1 test across 1 file. [9.00ms]\nBailed out after 1 failure\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(0);
            expect(result.summaryFailed).toBe(1);
        });

        it('treats a line holding only whitespace (such as the carriage return of a CRLF line end) as blank', () => {
            const stderr = ' 5 pass\r\n\r\n✗ bad [0.56ms]\r\nRan 1 test across 1 file. [9.00ms]\r\nBailed out after 1 failure\r\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.summaryPassed).toBe(0);
            expect(result.summaryFailed).toBe(1);
        });

        it('ignores a "Bailed out after" lookalike printed before the Ran line', () => {
            const stderr = 'Bailed out after 9 failures\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n';
            const result = parseBunTestOutput('', stderr);

            expect(result.failed).toBe(0);
            expect(result.summaryFailed).toBe(0);
        });

        it('takes the last bail line', () => {
            const result = parseBunTestOutput('', 'Ran 2 tests across 1 file.\nBailed out after 2 failures\nBailed out after 5 failures\n');

            expect(result.failed).toBe(5);
        });

        it('only accepts a whole bail line', () => {
            const result = parseBunTestOutput('', 'Ran 2 tests across 1 file.\nit Bailed out after 7 failures\nBailed out after 8 failures!\n');

            expect(result.failed).toBe(0);
        });

        it('reads a bail line when there is no Ran line at all (a cut-off run)', () => {
            const result = parseBunTestOutput('', '(fail) a [1ms]\nBailed out after 4 failures\n');

            expect(result.failed).toBe(4);
        });
    });

    describe('summaryPrinted (did bun get as far as printing its summary?)', () => {
        it('is true for a block with a Ran line', () => {
            expect(parseBunTestOutput('', ' 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n').summaryPrinted).toBe(true);
        });

        it('is true for a Ran line alone (bail output, a run with no pass line)', () => {
            expect(parseBunTestOutput('', 'Ran 1 test across 1 file. [5.00ms]\n').summaryPrinted).toBe(true);
        });

        it('is true for a pass line with no Ran line (older and cut-off outputs)', () => {
            expect(parseBunTestOutput('', ' 1 pass\n 0 fail\n').summaryPrinted).toBe(true);
        });

        it('is false for output with neither, such as a run that called process.exit (bun 1.3.7 and 1.4.2 print nothing more)', () => {
            const stderr = '\nx.test.ts:\n';
            expect(parseBunTestOutput('bun test v1.4.2 (744846f84)\n', stderr).summaryPrinted).toBe(false);
        });

        it('is false for empty output', () => {
            expect(parseBunTestOutput('', '').summaryPrinted).toBe(false);
        });

        it('is false when only non-pass lookalikes are printed, and they count for nothing', () => {
            const result = parseBunTestOutput(' 3 skip\n 2 todo\n 1 fail\n 4 errors\n', '');

            expect(result.summaryPrinted).toBe(false);
            expect(result.summarySkipped).toBe(0);
            expect(result.summaryTodo).toBe(0);
            expect(result.summaryFailed).toBe(0);
            expect(result.summaryErrors).toBe(0);
        });
    });

    describe('totals derived from the Ran line', () => {
        it('uses the Ran total as the pass count when the block holds no pass or fail count', () => {
            const result = parseBunTestOutput('', 'Ran 4 tests across 1 file. [5.00ms]\n');

            expect(result.passed).toBe(4);
            expect(result.summaryPassed).toBe(0);
        });

        it('does not touch the counts when they already add up to the Ran total', () => {
            const result = parseBunTestOutput('', ' 0 pass\n 3 skip\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n');

            expect(result.passed).toBe(0);
            expect(result.skipped).toBe(3);
        });
    });
});
