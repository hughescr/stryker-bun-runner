/**
 * The pieces of the likely-killers-first file order for bailing mutant runs.
 *
 * - The mutant ids of an instrumented source file come from its mutant switches.
 * - The dry run's raw per-test coverage gives, per test file, the mutants its tests
 *   executed (static mutants' per-test hits included).
 * - Ranks sort by coverage, then kills, then a name match; equal ranks keep the
 *   given (cheapest-first) order.
 * - The kill history credits kills per source file and marks a source file
 *   unsettled for good once one of its runs ends in Timeout or Error.
 */

import { describe, it, expect } from 'bun:test';
import {
    KillHistory, compareKillerRanks, isNamedAfter, mutantIdsInInstrumentedSource, mutantsByTestFile, orderLikelyKillersFirst, type KillerRank
} from '../../src/utils/likely-killer-order.js';

const rank = (overrides: Partial<KillerRank> = {}): KillerRank => ({ coverage: 2, kills: 0, namedAfter: false, ...overrides });

describe('mutantIdsInInstrumentedSource', () => {
    it('collects every mutant id of an instrumented file', () => {
        const code = [
            'function add(a, b) {',
            '  if (stryMutAct_9fa48("3")) { return a - b; } else { stryCov_9fa48("3", "4"); return stryMutAct_9fa48("4") ? a * b : a + b; }',
            '}',
            'const NAME = stryMutAct_9fa48("12") ? "" : (stryCov_9fa48("12"), "x");',
        ].join('\n');

        expect(mutantIdsInInstrumentedSource(code)).toEqual(new Set(['3', '4', '12']));
    });

    it('finds none in a file that was not instrumented', () => {
        expect(mutantIdsInInstrumentedSource('export const x = 1; // stryMutAct("1")')).toEqual(new Set());
    });
});

describe('mutantsByTestFile', () => {
    it('unions each test file\'s per-test entries, keyed by the file prefix of the raw key', () => {
        const perTest = {
            'tests/a.test.ts@@test-1': { '1': 2, '2': 1 },
            'tests/a.test.ts@@test-2': { '3': 1 },
            'tests/b.test.ts@@test-1': { '2': 5 },
        };

        expect(mutantsByTestFile(perTest)).toEqual(new Map([
            ['tests/a.test.ts', new Set(['1', '2', '3'])],
            ['tests/b.test.ts', new Set(['2'])],
        ]));
    });

    it('splits at the last @@, so a file name holding @@ keeps it', () => {
        expect(mutantsByTestFile({ 'tests/x@@y.test.ts@@test-1': { '1': 1 } })).toEqual(new Map([['tests/x@@y.test.ts', new Set(['1'])]]));
    });

    it('leaves out legacy keys, which name no file', () => {
        expect(mutantsByTestFile({ 'test-1': { '1': 1 }, 'tests/a.test.ts@@test-1': { '2': 1 } })).toEqual(new Map([['tests/a.test.ts', new Set(['2'])]]));
    });
});

describe('isNamedAfter', () => {
    it.each([
        ['tests/foo.test.ts', '/p/src/foo.ts'],
        ['/p/tests/unit/foo.spec.tsx', 'src/foo.tsx'],
        ['foo_test.js', 'lib/Foo.js'],
    ])('matches %s to %s', (testFile, sourceFile) => {
        expect(isNamedAfter(testFile, sourceFile)).toBe(true);
    });

    it.each([
        ['tests/foobar.test.ts', 'src/foo.ts'],
        ['tests/foo.test.ts', 'src/foo-utils.ts'],
        ['tests/foo.ts', 'src/bar.ts'],
    ])('does not match %s to %s', (testFile, sourceFile) => {
        expect(isNamedAfter(testFile, sourceFile)).toBe(false);
    });
});

describe('compareKillerRanks', () => {
    it('puts better coverage first, whatever the kills and name', () => {
        expect(compareKillerRanks(rank({ coverage: 0 }), rank({ coverage: 1, kills: 9, namedAfter: true }))).toBeLessThan(0);
        expect(compareKillerRanks(rank({ coverage: 2, kills: 9 }), rank({ coverage: 1 }))).toBeGreaterThan(0);
    });

    it('puts more kills first among equal coverage, whatever the name', () => {
        expect(compareKillerRanks(rank({ kills: 2 }), rank({ kills: 1, namedAfter: true }))).toBeLessThan(0);
    });

    it('puts the name match first among equal coverage and kills', () => {
        expect(compareKillerRanks(rank({ namedAfter: true }), rank())).toBeLessThan(0);
        expect(compareKillerRanks(rank(), rank({ namedAfter: true }))).toBeGreaterThan(0);
    });

    it('finds equal ranks equal', () => {
        expect(compareKillerRanks(rank({ coverage: 1, kills: 3, namedAfter: true }), rank({ coverage: 1, kills: 3, namedAfter: true }))).toBe(0);
    });
});

describe('orderLikelyKillersFirst', () => {
    it('keeps the given order between files that rank the same', () => {
        const files = ['c', 'a', 'd', 'b'];
        const ranks: Record<string, KillerRank> = { c: rank(), a: rank({ coverage: 1 }), d: rank(), b: rank({ coverage: 1 }) };

        const ordered = orderLikelyKillersFirst(files, file => ranks[file]);

        expect(ordered).toEqual(['a', 'b', 'c', 'd']);
        expect(files).toEqual(['c', 'a', 'd', 'b']);
    });

    it('leaves the order alone when nothing ranks differently', () => {
        expect(orderLikelyKillersFirst(['z', 'y', 'x'], () => rank())).toEqual(['z', 'y', 'x']);
    });
});

describe('KillHistory', () => {
    it('counts kills per source file and test file', () => {
        const history = new KillHistory();

        history.recordKill('src/a.ts', ['tests/x.test.ts']);
        history.recordKill('src/a.ts', ['tests/x.test.ts', 'tests/y.test.ts']);
        history.recordKill('src/b.ts', ['tests/y.test.ts']);

        expect(history.kills('src/a.ts', 'tests/x.test.ts')).toBe(2);
        expect(history.kills('src/a.ts', 'tests/y.test.ts')).toBe(1);
        expect(history.kills('src/b.ts', 'tests/x.test.ts')).toBe(0);
        expect(history.kills('src/c.ts', 'tests/x.test.ts')).toBe(0);
    });

    it('credits a file once per kill, however many of its tests failed', () => {
        const history = new KillHistory();

        history.recordKill('src/a.ts', ['tests/x.test.ts', 'tests/x.test.ts']);

        expect(history.kills('src/a.ts', 'tests/x.test.ts')).toBe(1);
    });

    it('marks only the named source file unsettled, and for good', () => {
        const history = new KillHistory();
        history.recordKill('src/a.ts', ['tests/x.test.ts']);

        history.recordUnsettled('src/a.ts');
        history.recordKill('src/a.ts', ['tests/x.test.ts']);

        expect(history.isUnsettled('src/a.ts')).toBe(true);
        expect(history.isUnsettled('src/b.ts')).toBe(false);
        expect(history.kills('src/a.ts', 'tests/x.test.ts')).toBe(2);
    });
});
