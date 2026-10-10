/**
 * Unit tests for coverage-mapper internals that the public mapping entry points
 * cannot reach: the internal-invariant guard in restoreHitTotals, and mapping
 * details that stay observable only in less common shapes (several tests holding
 * the same mutant, a placeholder-looking test name).
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import { describe, it, expect } from 'bun:test';
import { mapCoverageToInspectorIds, restoreHitTotals } from '../../src/coverage/coverage-mapper.js';
import type { TestInfo } from '../../src/inspector/types.js';

const fileUrl = (file: string) => `file:///.stryker-tmp/sandbox-X/${file}`;

describe('restoreHitTotals invariants', () => {
    it('adds each mutant\'s shortfall to one bucket that already holds it', () => {
        const raw: MutantCoverage    = { 'static': { '1': 4 }, perTest: { a: { '1': 6, '2': 3 }, b: { '2': 5 } } };
        const mapped: MutantCoverage = { 'static': { '1': 4 }, perTest: { a: { '2': 3 }, b: { '2': 1 } } };

        const result = restoreHitTotals(raw, mapped);

        expect(result).toEqual({ 'static': { '1': 10 }, perTest: { a: { '2': 7 }, b: { '2': 1 } } });
    });

    it('does not modify its inputs', () => {
        const raw: MutantCoverage    = { 'static': {}, perTest: { a: { '1': 9 } } };
        const mapped: MutantCoverage = { 'static': {}, perTest: { a: { '1': 2 } } };

        restoreHitTotals(raw, mapped);

        expect(mapped).toEqual({ 'static': {}, perTest: { a: { '1': 2 } } });
        expect(raw).toEqual({ 'static': {}, perTest: { a: { '1': 9 } } });
    });

    it('leaves a mutant whose mapped total equals its raw total alone (a shortfall of exactly zero is fine)', () => {
        const raw: MutantCoverage = { 'static': { '1': 2 }, perTest: { a: { '2': 3 } } };

        expect(restoreHitTotals(raw, raw)).toEqual(raw);
    });

    it('throws a clear internal-invariant error when a mapped mutant has more hits than its raw total', () => {
        // A future mapping change that copies an entry would inflate the mapped total. Subtracting
        // would then give a negative "shortfall", driving counts to <= 0 or NaN, which Stryker core's
        // `count > 0` filter silently drops. Crash instead of corrupting attribution.
        const raw: MutantCoverage    = { 'static': {}, perTest: { a: { '7': 2 } } };
        const mapped: MutantCoverage = { 'static': {}, perTest: { a: { '7': 2 }, 'a-copy': { '7': 2 } } };

        expect(() => restoreHitTotals(raw, mapped)).toThrow(
            'Internal invariant violated: mutant 7 has 4 mapped hits but only 2 raw hits'
        );
    });

    it('throws a clear internal-invariant error when a mapped mutant is absent from the raw coverage', () => {
        const raw: MutantCoverage    = { 'static': {}, perTest: { a: { '1': 2 } } };
        const mapped: MutantCoverage = { 'static': { '99': 1 }, perTest: { a: { '1': 2 } } };

        expect(() => restoreHitTotals(raw, mapped)).toThrow(
            'Internal invariant violated: mutant 99 has 1 mapped hits but no raw hits'
        );
    });
});

describe('retry merging in buildRemappedPerTest', () => {
    it('sums the hit counts a retry adds to a mutant the test already held, keeping them on that test', () => {
        // Mutant 30 is held by test one AND by the retried test two. Subtracting the retry's
        // hits instead of adding them would be hidden by restoreHitTotals for a single holder,
        // but with two holders the shortfall lands on the first one and shows up as wrong
        // per-test attribution.
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  {
                'tests/a.test.ts@@test-1': { '30': 1 },
                'tests/a.test.ts@@test-2': { '30': 13 },
                // a retry of the last test (its second start), merged into it
                'tests/a.test.ts@@test-3': { '30': 19 },
            },
        };
        const testHierarchy = new Map<number, TestInfo>([
            [1, { id: 1, name: 'one', fullName: 'one', type: 'test', url: fileUrl('tests/a.test.ts') }],
            [2, { id: 2, name: 'two', fullName: 'two', type: 'test', url: fileUrl('tests/a.test.ts') }],
        ]);

        const { coverage } = mapCoverageToInspectorIds(rawCoverage, [1, 2, 2], testHierarchy);

        expect(coverage).toEqual({
            'static': {},
            perTest:  {
                'tests/a.test.ts > one': { '30': 1 },
                'tests/a.test.ts > two': { '30': 32 },
            },
        });
    });
});

describe('legacy mapping with unknown inspector ids', () => {
    it('does not treat a test literally named "unknown-<id>" as a duplicate of a missing-info placeholder', () => {
        // Legacy (test-N) keys, no url on the hierarchy entry so the unique name is the bare fullName.
        // Execution slot 0 is an inspector id with no hierarchy entry (skipped with a warning);
        // slot 1's real test happens to be titled exactly like the placeholder for slot 0.
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  { 'test-1': { '1': 1 }, 'test-2': { '2': 1 } },
        };
        const testHierarchy = new Map<number, TestInfo>([
            [8, { id: 8, name: 'unknown-5', fullName: 'unknown-5', type: 'test' }],
        ]);

        const { coverage } = mapCoverageToInspectorIds(rawCoverage, [5, 8], testHierarchy);

        expect(coverage!.perTest).toEqual({ 'unknown-5': { '2': 1 } });
    });
});
