/**
 * Failing tests are read from bun's output whether or not it is coloured.
 *
 * Under FORCE_COLOR (set in the environment Stryker runs in, it reaches every bun child) bun
 * colours its test lines even when piped: `✗ name [0.29ms]` arrives as
 * `ESC[0mESC[31m✗ESC[0m ESC[0mmathESC[2m >ESC[0mESC[1m subtracts wrongESC[0m …`. Matched raw, no
 * such line was a failing test, so every killed mutant got an empty killedBy and Stryker's
 * incremental mode could never reuse its verdict. The fixtures are real bun 1.4.2 output; see
 * tests/helpers/bun-output-fixtures.ts.
 */

import { describe, expect, it } from 'bun:test';
import { parseBunTestOutput } from '../../src/parsers/console-parser.js';
import {
    EDGE_CASES_COLOUR_ALL,
    EDGE_CASES_COLOUR_ONLY_FAILURES,
    EDGE_CASES_PLAIN_ALL,
    EDGE_CASES_PLAIN_ONLY_FAILURES,
    TWO_FILES_COLOUR_ALL,
    TWO_FILES_COLOUR_ONLY_FAILURES,
    TWO_FILES_COLOUR_ONLY_FAILURES_BAIL,
    TWO_FILES_PLAIN_ALL,
    TWO_FILES_PLAIN_ONLY_FAILURES,
    TWO_FILES_PLAIN_ONLY_FAILURES_BAIL,
    type BunOutput
} from '../helpers/bun-output-fixtures.js';

const RUN_FILES = ['tests/a.test.ts', 'tests/b.test.ts'];

function failedTests(output: BunOutput, testFiles?: readonly string[]): { name: string, file: string | undefined }[] {
    return parseBunTestOutput(output.stdout, output.stderr, testFiles).tests
        .filter(test => test.status === 'failed')
        .map(test => ({ name: test.name, file: test.file }));
}

describe('failing tests in real bun 1.4.2 output, with and without FORCE_COLOR', () => {
    const TWO_FILES_FAILED = [
        { name: 'tests/a.test.ts > math > subtracts wrong', file: 'tests/a.test.ts' },
        { name: 'tests/a.test.ts > math > throws', file: 'tests/a.test.ts' },
        { name: 'tests/b.test.ts > b fails', file: 'tests/b.test.ts' },
    ];

    it.each([
        ['plain, every test printed', TWO_FILES_PLAIN_ALL],
        ['plain, onlyFailures', TWO_FILES_PLAIN_ONLY_FAILURES],
        ['FORCE_COLOR, every test printed', TWO_FILES_COLOUR_ALL],
        ['FORCE_COLOR, onlyFailures', TWO_FILES_COLOUR_ONLY_FAILURES],
    ])('%s: every failing test, under its file', (_label, output) => {
        expect(failedTests(output)).toEqual(TWO_FILES_FAILED);
        expect(failedTests(output, RUN_FILES)).toEqual(TWO_FILES_FAILED);
    });

    it.each([
        ['plain', TWO_FILES_PLAIN_ONLY_FAILURES_BAIL],
        ['FORCE_COLOR', TWO_FILES_COLOUR_ONLY_FAILURES_BAIL],
    ])('%s with --bail: the one failing test, and the bail count', (_label, output) => {
        const result = parseBunTestOutput(output.stdout, output.stderr, RUN_FILES);

        expect(failedTests(output, RUN_FILES)).toEqual([TWO_FILES_FAILED[0]]);
        expect(result.failed).toBe(1);
        expect(result.summaryFailed).toBe(1);
        expect(result.summaryPrinted).toBe(true);
    });

    it.each([
        ['plain, every test printed', EDGE_CASES_PLAIN_ALL],
        ['plain, onlyFailures', EDGE_CASES_PLAIN_ONLY_FAILURES],
        ['FORCE_COLOR, every test printed', EDGE_CASES_COLOUR_ALL],
        ['FORCE_COLOR, onlyFailures', EDGE_CASES_COLOUR_ONLY_FAILURES],
    ])('%s: a thrown string, a per-test timeout and an error from an earlier test\'s timer are failing tests too', (_label, output) => {
        expect(failedTests(output).map(test => test.name)).toEqual([
            'tests/c.test.ts > thrown string',
            'tests/c.test.ts > slow',
            'tests/c.test.ts > after slow',
            'tests/d.test.ts > d second',
        ]);
    });

    it('reads a coloured failing test\'s duration, colour codes and all', () => {
        const durations = parseBunTestOutput(TWO_FILES_COLOUR_ONLY_FAILURES.stdout, TWO_FILES_COLOUR_ONLY_FAILURES.stderr).tests.map(test => test.duration);
        // `ESC[0mESC[2m[0.34msESC[0mESC[2m]ESC[0m`, and bun bolds a duration of 10 ms or more: `ESC[2m[ESC[1m20.13ms`.
        expect(durations).toEqual([0.34, 0.09, 0.22]);
        expect(parseBunTestOutput(EDGE_CASES_COLOUR_ONLY_FAILURES.stdout, EDGE_CASES_COLOUR_ONLY_FAILURES.stderr).tests[1].duration).toBe(20.11);
    });

    it('reads the same counts from coloured and plain output', () => {
        const counts = (output: BunOutput): Record<string, unknown> => {
            const { tests: _tests, ...rest } = parseBunTestOutput(output.stdout, output.stderr);
            return rest;
        };

        expect(counts(TWO_FILES_COLOUR_ONLY_FAILURES)).toEqual(counts(TWO_FILES_PLAIN_ONLY_FAILURES));
        expect(counts(TWO_FILES_COLOUR_ONLY_FAILURES)).toEqual({
            totalTests:     6,
            passed:         2,
            failed:         3,
            skipped:        1,
            summaryPassed:  2,
            summaryFailed:  3,
            summarySkipped: 1,
            summaryTodo:    0,
            summaryErrors:  0,
            summaryPrinted: true,
        });
    });

    it('takes a coloured file header as a header, and a coloured test line as a test', () => {
        // Bun 1.4.2 prints the header itself without colour, but a reset code can open any line.
        const stderr = '\u001B[0mtests/a.test.ts:\u001B[0m\n\u001B[0m\u001B[31m(fail)\u001B[0m first \u001B[2m[1.00ms]\u001B[0m\n';

        expect(failedTests({ stdout: '', stderr })).toEqual([{ name: 'tests/a.test.ts > first', file: 'tests/a.test.ts' }]);
    });
});
