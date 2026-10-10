/**
 * parseBunTestOutput with the list of test files the run handed bun.
 *
 * Bun prints a failing test's error block BEFORE its `(fail)` line, and a test's
 * own console output lands in the same stream. Either can hold a line shaped
 * like a file header (`tests/foo.test.ts:`): an expect() diff of a string that
 * contains one, or a nested bun run's output that a test logs. Without the run's
 * file list the parser takes such a line as a new file and prefixes the real
 * failing test with it, so its name matches no dry-run test id and the mutant is
 * scored Killed with an empty killedBy. The outputs below are shaped like real
 * bun 1.4.2 output (see tests/00-integration/file-order-integration.test.ts for
 * the real thing).
 */

import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { parseBunTestOutput } from '../../src/parsers/console-parser.js';

/** Bun 1.4.2 stderr for a --bail run whose failing assertion diff contains a header-shaped line. */
const DIFF_WITH_HEADER_LINE = [
    '',
    'tests/unit/runner.test.ts:',
    '5110 |                     expect(result.errorMessage).toBe(\'x\');',
    '                                                       ^',
    'error: expect(received).toBe(expected)',
    '',
    '- "x"',
    '+ "bun test v1.4.2',
    '+ ',
    '+ tests/foo.test.ts:',
    '+ ✓ my test [1ms]"',
    '',
    '      at <anonymous> (/sandbox/tests/unit/runner.test.ts:5110:49)',
    '(fail) Runner > returns Error [3.56ms]',
    'Ran 2 tests across 1 file. [98.00ms]',
    'Bailed out after 1 failure',
].join('\n');

/** A test that logged a nested bun run's output (headers and all) before failing. */
const LOGGED_NESTED_RUN = [
    '',
    'tests/00-integration/inspector.test.ts:',
    'Logs: DEBUG: child output',
    '',
    'fixture.test.ts:',
    '(fail) inner fixture test [1.00ms]',
    '',
    '505 |         expect(result.status).toBe(DryRunStatus.Complete);',
    'error: expect(received).toBe(expected)',
    '(fail) Inspector Integration > large synthetic suite [7000.00ms]',
    'Ran 1 test across 1 file. [7.77s]',
    'Bailed out after 1 failure',
].join('\n');

function failedNames(stderr: string, testFiles?: readonly string[]): string[] {
    return parseBunTestOutput('', stderr, testFiles).tests.filter(t => t.status === 'failed').map(t => t.name);
}

describe('parseBunTestOutput with the run\'s test files', () => {
    it('ignores a header-shaped diff line that names no file of the run', () => {
        expect(failedNames(DIFF_WITH_HEADER_LINE, ['tests/unit/runner.test.ts'])).toEqual(['tests/unit/runner.test.ts > Runner > returns Error']);
    });

    it('without the file list, is misled by that line (the behaviour the list fixes)', () => {
        expect(failedNames(DIFF_WITH_HEADER_LINE)).toEqual(['+ tests/foo.test.ts > Runner > returns Error']);
    });

    it('ignores the headers of a nested run a test logged, keeping the outer file for every later line', () => {
        expect(failedNames(LOGGED_NESTED_RUN, ['tests/00-integration/inspector.test.ts'])).toEqual([
            'tests/00-integration/inspector.test.ts > inner fixture test',
            'tests/00-integration/inspector.test.ts > Inspector Integration > large synthetic suite',
        ]);
    });

    it('matches headers against absolute run files (bun prints them relative to the cwd)', () => {
        const absolute = path.resolve('tests/unit/runner.test.ts');

        expect(failedNames(DIFF_WITH_HEADER_LINE, [absolute])).toEqual(['tests/unit/runner.test.ts > Runner > returns Error']);
    });

    it('still switches between the run\'s own files', () => {
        const stderr = 'tests/a.test.ts:\n(fail) one [1ms]\n\ntests/b.test.ts:\n(fail) two [1ms]\n';

        expect(failedNames(stderr, ['tests/b.test.ts', 'tests/a.test.ts'])).toEqual(['tests/a.test.ts > one', 'tests/b.test.ts > two']);
    });

    it('records the run file on each test it parses', () => {
        const [test] = parseBunTestOutput('', DIFF_WITH_HEADER_LINE, ['tests/unit/runner.test.ts']).tests;

        expect(test.file).toBe('tests/unit/runner.test.ts');
    });

    it('accepts every header when no header names a run file (output it cannot vouch for)', () => {
        const stderr = 'tests/other.test.ts:\n(fail) one [1ms]\n';

        expect(failedNames(stderr, ['tests/a.test.ts'])).toEqual(['tests/other.test.ts > one']);
    });

    it('accepts every header for an empty file list (bun discovered the files itself)', () => {
        expect(failedNames(DIFF_WITH_HEADER_LINE, [])).toEqual(['+ tests/foo.test.ts > Runner > returns Error']);
    });

    it('finds a run file\'s header in stdout too', () => {
        const result = parseBunTestOutput('tests/a.test.ts:\n(fail) one [1ms]\n', 'tests/x.test.ts:\n', ['tests/a.test.ts']);

        expect(result.tests.map(t => t.name)).toEqual(['tests/a.test.ts > one']);
    });
});
