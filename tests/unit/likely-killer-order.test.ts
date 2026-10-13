/**
 * The pieces of the likely-killers-first file order for static mutant runs.
 *
 * - The mutant ids of an instrumented source file come from its mutant switches,
 *   pinned against the installed Stryker instrumenter's real output.
 * - The dry run's raw per-test coverage gives, per test file, the mutants its tests
 *   executed (static mutants' per-test hits included), persisted compactly as a
 *   file table plus per-mutant file indices.
 * - Ranks sort by coverage, then how many of the source file's mutants a file
 *   covers, then a name match; equal ranks keep the given (cheapest-first) order.
 */

import type { Logger } from '@stryker-mutator/api/logging';
import type { Instrumenter as InstrumenterClass } from '@stryker-mutator/instrumenter';
import { describe, it, expect, mock } from 'bun:test';
import {
    TestFileCoverage, compareKillerRanks, mutantIdsInInstrumentedSource, namedAfter, orderLikelyKillersFirst, type KillerRank
} from '../../src/utils/likely-killer-order.js';

/**
 * Stryker's instrumenter (a dependency of @stryker-mutator/core), loaded at run time: a
 * static import makes eslint's import-x resolver walk the instrumenter's own dynamic
 * imports, which it cannot resolve.
 */
const INSTRUMENTER_MODULE = '@stryker-mutator/instrumenter';

const rank = (overrides: Partial<KillerRank> = {}): KillerRank => ({ coverage: 2, sourceMutants: 0, namedAfter: false, ...overrides });

describe('mutantIdsInInstrumentedSource', () => {
    it('collects every mutant id of a file instrumented by the installed Stryker instrumenter', async () => {
        const logger = { debug: mock(), info: mock(), warn: mock(), error: mock(), trace: mock(), fatal: mock(), isDebugEnabled: () => false, isTraceEnabled: () => false } as unknown as Logger;
        const source = [
            'export const NAME = "lib";',
            'export function sum(values: number[]): number {',
            '    let total = 0;',
            '    for(let i = 0; i < values.length; i++) { total += values[i]; }',
            '    return total > 10 ? total : -total;',
            '}',
        ].join('\n');

        const { Instrumenter } = await import(INSTRUMENTER_MODULE) as { Instrumenter: typeof InstrumenterClass };

        const result = await new Instrumenter(logger).instrument([{ name: 'src/lib.ts', content: source, mutate: true }], { plugins: null, excludedMutations: [], ignorers: [] });

        expect(result.mutants.length).toBeGreaterThan(5);
        expect(mutantIdsInInstrumentedSource(result.files[0].content)).toEqual(new Set(result.mutants.map(mutant => mutant.id)));
    });

    it('finds none in a file that was not instrumented', () => {
        expect(mutantIdsInInstrumentedSource('export const x = 1; // stryMutAct("1")')).toEqual(new Set());
    });
});

describe('TestFileCoverage', () => {
    const perTest = {
        'tests/a.test.ts@@test-1': { '1': 2, '2': 1 },
        'tests/a.test.ts@@test-2': { '3': 1, '2': 4 },
        'tests/b.test.ts@@test-1': { '2': 5 },
    };

    it('knows, per mutant, the files whose tests executed it', () => {
        const coverage = TestFileCoverage.fromPerTest(perTest)!;

        expect(coverage.filesCovering('2')).toEqual(new Set(['tests/a.test.ts', 'tests/b.test.ts']));
        expect(coverage.filesCovering('3')).toEqual(new Set(['tests/a.test.ts']));
        expect(coverage.filesCovering('99')).toEqual(new Set());
    });

    it('counts, per file, how many of a set of mutants its tests executed', () => {
        const coverage = TestFileCoverage.fromPerTest(perTest)!;

        expect(coverage.coverageCounts(['1', '2', '3', '99'])).toEqual(new Map([['tests/a.test.ts', 3], ['tests/b.test.ts', 1]]));
    });

    it('persists as a file table and per-mutant file indices, each pair once', () => {
        expect(TestFileCoverage.fromPerTest(perTest)!.toJSON()).toEqual({
            files:   ['tests/a.test.ts', 'tests/b.test.ts'],
            mutants: { '1': [0], '2': [0, 1], '3': [0] },
        });
    });

    it('reads back what it persists', () => {
        // Through JSON, as the registry carries it.
        const json = JSON.parse(JSON.stringify(TestFileCoverage.fromPerTest(perTest))) as unknown; // eslint-disable-line unicorn/prefer-structured-clone -- the round trip through JSON text is what is tested

        const coverage = TestFileCoverage.fromJson(json)!;

        expect(coverage.filesCovering('2')).toEqual(new Set(['tests/a.test.ts', 'tests/b.test.ts']));
        expect(coverage.toJSON()).toEqual(json as ReturnType<TestFileCoverage['toJSON']>);
    });

    it('splits a key at the last @@, so a file name holding @@ keeps it', () => {
        expect(TestFileCoverage.fromPerTest({ 'tests/x@@y.test.ts@@test-1': { '1': 1 } })!.filesCovering('1')).toEqual(new Set(['tests/x@@y.test.ts']));
    });

    it('leaves out legacy keys, which name no file, and is undefined when none names a file', () => {
        expect(TestFileCoverage.fromPerTest({ 'test-1': { '1': 1 }, 'tests/a.test.ts@@test-1': { '2': 1 } })!.toJSON()).toEqual({ files: ['tests/a.test.ts'], mutants: { '2': [0] } });
        expect(TestFileCoverage.fromPerTest({ 'test-1': { '1': 1 } })).toBeUndefined();
        expect(TestFileCoverage.fromPerTest({})).toBeUndefined();
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an array', [['tests/a.test.ts', ['1']]]],
        ['files that are not an array', { files: 'tests/a.test.ts', mutants: {} }],
        ['a file that is not a string', { files: [7], mutants: {} }],
        ['one file that is not a string among strings', { files: ['a', 7], mutants: {} }],
        ['mutants that are an array', { files: ['a'], mutants: [[0]] }],
        ['mutants that are null', { files: ['a'], mutants: null }],
        ['mutants that are a string', { files: ['a'], mutants: '' }],
        ['indices that are not an array', { files: ['a'], mutants: { '1': 0 } }],
        ['one mutant with indices that are not an array among valid ones', { files: ['a'], mutants: { '1': [0], '2': 0 } }],
        ['an index past the table', { files: ['a'], mutants: { '1': [1] } }],
        ['one index past the table among valid ones', { files: ['a', 'b'], mutants: { '1': [0, 2] } }],
        ['a negative index', { files: ['a'], mutants: { '1': [-1] } }],
        ['a fractional index', { files: ['a', 'b'], mutants: { '1': [0.5] } }],
    ])('rejects a persisted form that is %s', (_label, value) => {
        expect(TestFileCoverage.fromJson(value)).toBeUndefined();
    });
});

describe('namedAfter', () => {
    it.each([
        ['tests/foo.test.ts', '/p/src/foo.ts'],
        ['/p/tests/unit/foo.spec.tsx', 'src/foo.tsx'],
        ['foo_test.js', 'lib/Foo.js'],
    ])('matches %s to %s', (testFile, sourceFile) => {
        expect(namedAfter(sourceFile)(testFile)).toBe(true);
    });

    it.each([
        ['tests/foobar.test.ts', 'src/foo.ts'],
        ['tests/foo.test.ts', 'src/foo-utils.ts'],
        ['tests/foo.ts', 'src/bar.ts'],
    ])('does not match %s to %s', (testFile, sourceFile) => {
        expect(namedAfter(sourceFile)(testFile)).toBe(false);
    });
});

describe('compareKillerRanks', () => {
    it('puts better coverage first, whatever the source-file count and name', () => {
        expect(compareKillerRanks(rank({ coverage: 0 }), rank({ coverage: 1, sourceMutants: 9, namedAfter: true }))).toBeLessThan(0);
        expect(compareKillerRanks(rank({ coverage: 2 }), rank({ coverage: 1 }))).toBeGreaterThan(0);
    });

    it('puts more of the source file\'s mutants first among equal coverage, whatever the name', () => {
        expect(compareKillerRanks(rank({ coverage: 1, sourceMutants: 2 }), rank({ coverage: 1, sourceMutants: 1, namedAfter: true }))).toBeLessThan(0);
    });

    it('puts the name match first among equal coverage and counts', () => {
        expect(compareKillerRanks(rank({ namedAfter: true }), rank())).toBeLessThan(0);
        expect(compareKillerRanks(rank(), rank({ namedAfter: true }))).toBeGreaterThan(0);
    });

    it('finds equal ranks equal', () => {
        expect(compareKillerRanks(rank({ coverage: 1, sourceMutants: 3, namedAfter: true }), rank({ coverage: 1, sourceMutants: 3, namedAfter: true }))).toBe(0);
    });
});

describe('orderLikelyKillersFirst', () => {
    it('keeps the given order between files that rank the same, and leaves the input alone', () => {
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
