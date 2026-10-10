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

    describe('when the run\'s list holds a directory (bun runs everything under it)', () => {
        const stderr = [
            'tests/other/x.test.ts:',
            '(pass) x [1ms]',
            '',
            'tests/unit/deep/y.test.ts:',
            '(fail) y [1ms]',
            '',
            'tests/unit/z.test.ts:',
            '(fail) z [1ms]',
        ].join('\n');
        const FAILED = ['tests/unit/deep/y.test.ts > y', 'tests/unit/z.test.ts > z'];

        it('believes the headers of files under the directory, however deep (the failure is not credited to the listed file)', () => {
            expect(failedNames(stderr, ['tests/other/x.test.ts', 'tests/unit'])).toEqual(FAILED);
        });

        it('accepts a directory spelled with a trailing slash, ./ or an absolute path', () => {
            for(const dir of ['tests/unit/', './tests/unit', path.resolve('tests/unit')]) {
                expect(failedNames(stderr, ['tests/other/x.test.ts', dir])).toEqual(FAILED);
            }
        });

        it('works when the directory is the only entry', () => {
            expect(failedNames(stderr, ['tests/unit'])).toEqual(FAILED);
        });

        it('still ignores a header outside both the files and the directories', () => {
            const stray = `${stderr}\n+ tests/stray.test.ts:\n(fail) w [1ms]`;

            expect(failedNames(stray, ['tests/other/x.test.ts', 'tests/unit'])).toEqual([...FAILED, 'tests/unit/z.test.ts > w']);
        });

        it('does not take a sibling whose name merely starts with the directory\'s', () => {
            const sibling = 'tests/unit/z.test.ts:\n(fail) z [1ms]\n\ntests/unit-extra/q.test.ts:\n(fail) q [1ms]\n';

            expect(failedNames(sibling, ['tests/unit'])).toEqual(['tests/unit/z.test.ts > z', 'tests/unit/z.test.ts > q']);
        });

        it('does not take a parent directory\'s file for a nested directory entry', () => {
            const parent = 'tests/unit/z.test.ts:\n(fail) z [1ms]\n\ntests/a.test.ts:\n(fail) a [1ms]\n';

            expect(failedNames(parent, ['tests/unit'])).toEqual(['tests/unit/z.test.ts > z', 'tests/unit/z.test.ts > a']);
        });

        it('does not take the parent of a listed directory for one of its files', () => {
            const parentNamedLikeATest = 'tests/a.test.ts:\n(fail) a [1ms]\n\ntests/dir.test.ts:\n(fail) b [1ms]\n';

            expect(failedNames(parentNamedLikeATest, ['tests/a.test.ts', 'tests/dir.test.ts/inner'])).toEqual(['tests/a.test.ts > a', 'tests/a.test.ts > b']);
        });

        it('treats a directory above the working directory as covering the files under it', () => {
            const outside = path.resolve('..', 'sibling', 'q.test.ts');
            const relative = path.relative(process.cwd(), outside);
            const out = `${relative}:\n(fail) q [1ms]\n/elsewhere/s.test.ts:\n(fail) r [1ms]\n`;

            expect(failedNames(out, [path.resolve('..')])).toEqual([`${relative} > q`, `${relative} > r`]);
        });
    });

    it('finds a run file\'s header in stdout too', () => {
        const result = parseBunTestOutput('tests/a.test.ts:\n(fail) one [1ms]\n', 'tests/x.test.ts:\n', ['tests/a.test.ts']);

        expect(result.tests.map(t => t.name)).toEqual(['tests/a.test.ts > one']);
    });
});
