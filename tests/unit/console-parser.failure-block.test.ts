/**
 * A failing test's failureMessage is the error report bun printed for it.
 *
 * Bun prints a failing test's report (the code frame, the error, the diff and the stack) BEFORE
 * its `(fail)` line, and only a per-test timeout's or a passing `.failing` test's `  ^ …` line
 * after it. The parser used to collect the lines AFTER each `(fail)` line, so a killed mutant's
 * failureMessage (Stryker's statusReason) was the next test's report, or bun's summary and bail
 * lines. The fixtures are real bun 1.4.2 output; see tests/helpers/bun-output-fixtures.ts.
 */

import { describe, expect, it } from 'bun:test';
import { MAX_FAILURE_MESSAGE_LENGTH, parseBunTestOutput } from '../../src/parsers/console-parser.js';
import {
    EDGE_CASES_COLOUR_ALL,
    EDGE_CASES_COLOUR_ONLY_FAILURES,
    EDGE_CASES_PLAIN_ALL,
    EDGE_CASES_PLAIN_ONLY_FAILURES,
    HOOKS_PLAIN_ONLY_FAILURES,
    TWO_FILES_COLOUR_ALL,
    TWO_FILES_COLOUR_ONLY_FAILURES,
    TWO_FILES_COLOUR_ONLY_FAILURES_BAIL,
    TWO_FILES_PLAIN_ALL,
    TWO_FILES_PLAIN_ONLY_FAILURES,
    TWO_FILES_PLAIN_ONLY_FAILURES_BAIL,
    TWO_FILES_B_FAILS_REPORT,
    TWO_FILES_SUBTRACTS_WRONG_REPORT,
    TWO_FILES_THROWS_REPORT,
    type BunOutput
} from '../helpers/bun-output-fixtures.js';

/** Each failing test's name and failureMessage. */
function failures(output: BunOutput): [string, string | undefined][] {
    return parseBunTestOutput(output.stdout, output.stderr).tests
        .filter(test => test.status === 'failed')
        .map(test => [test.name, test.failureMessage]);
}

const SUBTRACTS_REPORT = TWO_FILES_SUBTRACTS_WRONG_REPORT;
const THROWS_REPORT = TWO_FILES_THROWS_REPORT;
const B_FAILS_REPORT = TWO_FILES_B_FAILS_REPORT;

describe('failureMessage from real bun 1.4.2 output', () => {
    it.each([
        ['plain, every test printed', TWO_FILES_PLAIN_ALL],
        ['plain, onlyFailures', TWO_FILES_PLAIN_ONLY_FAILURES],
        ['FORCE_COLOR, every test printed', TWO_FILES_COLOUR_ALL],
        ['FORCE_COLOR, onlyFailures', TWO_FILES_COLOUR_ONLY_FAILURES],
    ])('%s: each failing test gets the report printed before its (fail) line', (_label, output) => {
        expect(failures(output)).toEqual([
            ['tests/a.test.ts > math > subtracts wrong', SUBTRACTS_REPORT],
            ['tests/a.test.ts > math > throws', THROWS_REPORT],
            ['tests/b.test.ts > b fails', B_FAILS_REPORT],
        ]);
    });

    it.each([
        ['plain', TWO_FILES_PLAIN_ONLY_FAILURES_BAIL],
        ['FORCE_COLOR', TWO_FILES_COLOUR_ONLY_FAILURES_BAIL],
    ])('%s with --bail: the report, not the Ran and Bailed out lines after it', (_label, output) => {
        expect(failures(output)).toEqual([['tests/a.test.ts > math > subtracts wrong', SUBTRACTS_REPORT]]);
    });

    const EDGE_FAILURES: [string, string][] = [
        // Not the `error: chatter that looks like an error` a passing test printed before it.
        ['tests/c.test.ts > thrown string', [
            "1 | import { expect, it } from 'bun:test';",
            "2 | it('chatty pass', () => { console.log('chatter line 1'); console.error('error: chatter that looks like an error'); expect(1).toBe(1); });",
            "3 | it.todo('later');",
            "4 | it('thrown string', () => { throw 'just a string'; });",
            '                                      ^',
            'error: just a string',
            '      at <anonymous> (/project/tests/c.test.ts:4:35)',
        ].join('\n')],
        // Bun prints a timeout's line after the (fail) line, and nothing before it.
        ['tests/c.test.ts > slow', '^ this test timed out after 20ms.'],
        // ...and the timeout line is not part of the next test's report.
        ['tests/c.test.ts > after slow', [
            "1 | import { expect, it } from 'bun:test';",
            "2 | it('chatty pass', () => { console.log('chatter line 1'); console.error('error: chatter that looks like an error'); expect(1).toBe(1); });",
            "3 | it.todo('later');",
            "4 | it('thrown string', () => { throw 'just a string'; });",
            "5 | it('slow', async () => { await new Promise(r => setTimeout(r, 200)); }, 20);",
            "6 | it('after slow', () => { expect('a').toBe('b'); });",
            '                                         ^',
            'error: expect(received).toBe(expected)',
            '',
            'Expected: "b"',
            'Received: "a"',
            '',
            '      at <anonymous> (/project/tests/c.test.ts:6:38)',
        ].join('\n')],
        // Bun reports an error thrown by an earlier test's timer against the test running when it fires.
        ['tests/d.test.ts > d second', [
            "1 | import { expect, it } from 'bun:test';",
            "2 | it('d first', () => { setTimeout(() => { throw new Error('stray async error'); }, 0); });",
            '                                                                                ^',
            'error: stray async error',
            '      at <anonymous> (/project/tests/d.test.ts:2:77)',
        ].join('\n')],
    ];

    it.each([
        ['plain, every test printed', EDGE_CASES_PLAIN_ALL],
        ['plain, onlyFailures', EDGE_CASES_PLAIN_ONLY_FAILURES],
        ['FORCE_COLOR, every test printed', EDGE_CASES_COLOUR_ALL],
        ['FORCE_COLOR, onlyFailures', EDGE_CASES_COLOUR_ONLY_FAILURES],
    ])('%s: a thrown string, a timeout, and a passing test\'s console output and pending test before a failure', (_label, output) => {
        expect(failures(output)).toEqual(EDGE_FAILURES);
    });

    it('hook failures and a passing .failing test', () => {
        expect(failures(HOOKS_PLAIN_ONLY_FAILURES)).toEqual([
            ['tests/g.test.ts > hooks > (unnamed)', [
                "1 | import { afterEach, beforeAll, describe, expect, test } from 'bun:test';",
                "2 | describe('hooks', () => {",
                "3 |     beforeAll(() => { throw new Error('beforeAll threw'); });",
                '                                                           ^',
                'error: beforeAll threw',
                '      at <anonymous> (/project/tests/g.test.ts:3:56)',
            ].join('\n')],
            // Without the `a1 says hi` the test printed.
            ['tests/g.test.ts > after > a1', [
                "3 |     beforeAll(() => { throw new Error('beforeAll threw'); });",
                "4 |     test('h1', () => { expect(1).toBe(1); });",
                "5 |     test('h2', () => { expect(1).toBe(1); });",
                '6 | });',
                "7 | describe('after', () => {",
                "8 |     afterEach(() => { throw new Error('afterEach threw'); });",
                '                                                           ^',
                'error: afterEach threw',
                '      at <anonymous> (/project/tests/g.test.ts:8:56)',
            ].join('\n')],
            ['tests/g.test.ts > unexpectedly passes', '^ this test is marked as failing but it passed. Remove `.failing` if tested behavior now works'],
        ]);
    });
});

describe('failureMessage boundaries', () => {
    const parse = (stderr: string): [string, string | undefined][] => failures({ stdout: '', stderr });

    it('starts at the start of the output when nothing came before the first failure', () => {
        expect(parse('error: first\n(fail) one [1.00ms]\n')).toEqual([['one', 'error: first']]);
    });

    it('starts after a passing, skipped or pending test\'s line, in either form', () => {
        for(const result of ['(pass) p [1.00ms]', '(skip) s', '(todo) t', '✓ p [1.00ms]', '» s', '✎ t']) {
            expect(parse(`console output\n${result}\nerror: mine\n(fail) f [1.00ms]\n`)).toEqual([['f', 'error: mine']]);
        }
    });

    it('starts at the first error heading when the report has no code frame, dropping what the test printed first', () => {
        expect(parse('a.test.ts:\nsome console output\nTypeError: x is not a function\n    at f (a.test.ts:1:1)\n(fail) f [1.00ms]\n'))
            .toEqual([['a.test.ts > f', 'TypeError: x is not a function\n    at f (a.test.ts:1:1)']]);
        expect(parse('AssertionError [ERR_ASSERTION]: no\n(fail) f [1.00ms]\n')).toEqual([['f', 'AssertionError [ERR_ASSERTION]: no']]);
    });

    it('keeps what the test printed when bun printed neither a code frame nor an error heading', () => {
        expect(parse('a.test.ts:\nonly this\n\nand this\n(fail) f [1.00ms]\n')).toEqual([['a.test.ts > f', 'only this\n\nand this']]);
    });

    it('has no failureMessage when bun printed nothing for the test', () => {
        expect(parse('a.test.ts:\n(fail) f [1.00ms]\n\n 0 pass\n 1 fail\n')).toEqual([['a.test.ts > f', undefined]]);
    });

    it('takes a `  ^ ` line only right after a (fail) line', () => {
        expect(parse('(fail) f [1.00ms]\n  ^ this test timed out after 5ms.\n  ^ and another note\n  ^ x\n(fail) g [1.00ms]\n')).toEqual([
            ['f', '^ this test timed out after 5ms.\n^ and another note\n^ x'],
            ['g', undefined],
        ]);
        // A caret line under a code frame, or one after other output, belongs to the next report.
        expect(parse('(fail) f [1.00ms]\nnoise\n  ^ not f\'s\n(fail) g [1.00ms]\n')).toEqual([['f', undefined], ['g', 'noise\n  ^ not f\'s']]);
    });

    it('appends a `  ^ ` line to the report printed before the (fail) line', () => {
        expect(parse('error: boom\n(fail) f [1.00ms]\n  ^ this test timed out after 5ms.\n')).toEqual([['f', 'error: boom\n^ this test timed out after 5ms.']]);
    });

    it('leaves GitHub Actions workflow commands out', () => {
        expect(parse('::group::a.test.ts:\n::warning file=x::careful\nerror: mine\n::endgroup::\n(fail) f [1.00ms]\n')).toEqual([['a.test.ts > f', 'error: mine']]);
    });

    it(`caps a long report at ${MAX_FAILURE_MESSAGE_LENGTH} characters, keeping its start`, () => {
        const diff = Array.from({ length: 2000 }, (_, i) => `+   "key${i}": ${i},`).join('\n');
        const [[, message]] = parse(`1 | expect(big).toEqual(other);\nerror: expect(received).toEqual(expected)\n${diff}\n(fail) f [1.00ms]\n`);

        const full = `1 | expect(big).toEqual(other);\nerror: expect(received).toEqual(expected)\n${diff}`;
        expect(message).toBe(`${full.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}\n… (${full.length - MAX_FAILURE_MESSAGE_LENGTH} more characters)`);
    });

    it('does not cap a report of exactly the maximum length', () => {
        const report = `error: ${'x'.repeat(MAX_FAILURE_MESSAGE_LENGTH - 7)}`;

        expect(parse(`${report}\n(fail) f [1.00ms]\n`)).toEqual([['f', report]]);
    });

    it('caps the report alone, so a note after an over-long report is kept whole and the count is the report\'s', () => {
        const report = `error: ${'x'.repeat(MAX_FAILURE_MESSAGE_LENGTH + 50)}`;

        expect(parse(`${report}\n(fail) f [1.00ms]\n  ^ this test timed out after 5ms.\n  ^ and a second note\n`)).toEqual([[
            'f',
            `${report.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}\n… (57 more characters)\n^ this test timed out after 5ms.\n^ and a second note`,
        ]]);
    });

    it('gives a timed-out test only its note when what came before it is other tests\' output', () => {
        // With onlyFailures, a passing test's stderr is all that precedes a timed-out test's line.
        expect(parse('a.test.ts:\nstderr from a passing test\n\nmore of it\n(fail) slow [20.13ms]\n  ^ this test timed out after 20ms.\n'))
            .toEqual([['a.test.ts > slow', '^ this test timed out after 20ms.']]);
    });

    it('keeps the report before a note when it has an error heading', () => {
        expect(parse('a.test.ts:\nnoise\nerror: boom\n(fail) f [1.00ms]\n  ^ this test timed out after 5ms.\n'))
            .toEqual([['a.test.ts > f', 'error: boom\n^ this test timed out after 5ms.']]);
    });
});
