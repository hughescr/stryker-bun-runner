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

    it('finds each mutant\'s bucket without searching every bucket per mutant (a 40,000-test suite stays well inside the test timeout)', () => {
        // A suite's size: one bucket per test, each mutant in a different one. Searching the
        // buckets once per mutant is quadratic: about 8 × 10⁸ lookups here, over 40 s, which
        // added 30 s to the dry run of a real 15,000-test, 40,000-mutant project.
        const MUTANTS = 40_000;
        const perTest: Record<string, Record<string, number>> = {};
        for(let i = 0; i < MUTANTS; i++) {
            perTest[`t${i}`] = { [String(i)]: 2 };
        }
        const raw: MutantCoverage = { 'static': {}, perTest };
        const mapped: MutantCoverage = { 'static': {}, perTest: { ...perTest, [`t${MUTANTS - 1}`]: { [String(MUTANTS - 1)]: 1 } } };

        const result = restoreHitTotals(raw, mapped);

        expect(result.perTest[`t${MUTANTS - 1}`]).toEqual({ [String(MUTANTS - 1)]: 2 });
        expect(Object.keys(result.perTest)).toHaveLength(MUTANTS);
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

describe('retry merging', () => {
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

describe('file-prefixed mapping in one pass', () => {
    /** Deterministic pseudo-random numbers (a 32-bit LCG), so a failure reproduces. */
    function lcg(seed: number): (below: number) => number {
        let state = seed;
        return (below) => {
            state = ((state * 1_664_525) + 1_013_904_223) % 4_294_967_296;
            return state % below;
        };
    }

    /**
     * A random dry run: files of tests, some retried (started again at once), the
     * per-start coverage keys the preload records, some keys past the last start (orphaned),
     * and a static bucket some of whose mutants the tests also hit.
     */
    function randomRun(seed: number): { raw: MutantCoverage, executionOrder: number[], hierarchy: Map<number, TestInfo>, names: Map<string, string | undefined> } {
        const random = lcg(seed);
        const hierarchy = new Map<number, TestInfo>();
        const executionOrder: number[] = [];
        const keys: string[] = [];
        const names = new Map<string, string | undefined>();
        let id = 0;
        for(let f = 0; f < 3; f++) {
            const file = `tests/f${f}.test.ts`;
            let position = 0;
            for(let t = 0, tests = 1 + random(5); t < tests; t++) {
                id++;
                hierarchy.set(id, { id, name: `t${t}`, fullName: `t${t}`, type: 'test', url: fileUrl(file) });
                for(let attempt = 0, attempts = 1 + (random(4) === 0 ? 1 + random(2) : 0); attempt < attempts; attempt++) {
                    executionOrder.push(id);
                    position++;
                    keys.push(`${file}@@test-${position}`);
                    names.set(`${file}@@test-${position}`, `${file} > t${t}`);
                }
            }
        }
        // Keys with no start of their own: past the end of the global order, so orphaned.
        for(let extra = 0, extras = random(3); extra < extras; extra++) {
            keys.push(`tests/f0.test.ts@@test-${100 + extra}`);
            names.set(`tests/f0.test.ts@@test-${100 + extra}`, undefined);
        }
        const perTest: Record<string, Record<string, number>> = {};
        for(const key of keys) {
            const counts: Record<string, number> = {};
            for(let m = 0, mutants = random(5); m < mutants; m++) {
                const mutantId = String(1 + random(12));
                counts[mutantId] = (counts[mutantId] ?? 0) + 1 + random(4);
            }
            perTest[key] = counts;
        }
        const staticCounts: Record<string, number> = {};
        for(let m = 0, mutants = random(4); m < mutants; m++) {
            staticCounts[String(1 + random(12))] = 1 + random(3);
        }
        return { raw: { 'static': staticCounts, perTest }, executionOrder, hierarchy, names };
    }

    /** What the mapping did in three passes: credit keys to tests, strip static mutants, restore the raw hit totals. */
    function referenceMapping(raw: MutantCoverage, names: Map<string, string | undefined>): MutantCoverage {
        const remapped: Record<string, Record<string, number>> = {};
        const counterIds = Object.keys(raw.perTest).toSorted((a, b) => Number(a.split('@@test-')[1]) - Number(b.split('@@test-')[1]));
        for(const key of counterIds) {
            const name = names.get(key);
            if(name === undefined) {
                continue;
            }
            const into = remapped[name] ??= {};
            for(const [mutantId, hits] of Object.entries(raw.perTest[key])) {
                into[mutantId] = (into[mutantId] ?? 0) + hits;
            }
        }
        const staticIds = new Set(Object.keys(raw.static));
        const stripped: Record<string, Record<string, number>> = {};
        for(const [name, counts] of Object.entries(remapped)) {
            const kept = Object.fromEntries(Object.entries(counts).filter(([mutantId]) => !staticIds.has(mutantId)));
            if(Object.keys(kept).length > 0) {
                stripped[name] = kept;
            }
        }
        return restoreHitTotals(raw, { 'static': raw.static, perTest: stripped });
    }

    it('gives the same coverage, in the same order, as crediting, stripping static mutants and restoring hit totals one after the other', () => {
        let orphanedRuns = 0;
        for(let seed = 1; seed <= 300; seed++) {
            const { raw, executionOrder, hierarchy, names } = randomRun(seed);
            const rawBefore = structuredClone(raw);

            const { coverage, orphanedKeyCount } = mapCoverageToInspectorIds(raw, executionOrder, hierarchy);

            const expected = referenceMapping(raw, names);
            expect({ seed, coverage: JSON.stringify(coverage) }).toEqual({ seed, coverage: JSON.stringify(expected) });
            expect(raw).toEqual(rawBefore);
            orphanedRuns += orphanedKeyCount > 0 ? 1 : 0;
        }
        // The generator did produce the orphaned keys whose hits must still be counted.
        expect(orphanedRuns).toBeGreaterThan(50);
    });

    it('keeps a static mutant\'s hits from every test, a retry included, on static, and drops a test left with no mutant', () => {
        const rawCoverage: MutantCoverage = {
            'static': { '1': 2 },
            perTest:  {
                'tests/a.test.ts@@test-1': { '1': 3 },
                'tests/a.test.ts@@test-2': { '1': 1, '2': 4 },
                'tests/a.test.ts@@test-3': { '1': 5, '2': 1 },
            },
        };
        const testHierarchy = new Map<number, TestInfo>([
            [1, { id: 1, name: 'only static', fullName: 'only static', type: 'test', url: fileUrl('tests/a.test.ts') }],
            [2, { id: 2, name: 'retried', fullName: 'retried', type: 'test', url: fileUrl('tests/a.test.ts') }],
        ]);

        const { coverage } = mapCoverageToInspectorIds(rawCoverage, [1, 2, 2], testHierarchy);

        expect(coverage).toEqual({ 'static': { '1': 11 }, perTest: { 'tests/a.test.ts > retried': { '2': 5 } } });
    });

    it('adds an orphaned key\'s hits to the first test that holds the mutant, and leaves out a mutant only it holds', () => {
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  {
                'tests/a.test.ts@@test-1': { '1': 1 },
                'tests/a.test.ts@@test-2': { '1': 2 },
                'tests/a.test.ts@@test-3': { '1': 4, '9': 7 },
            },
        };
        const testHierarchy = new Map<number, TestInfo>([
            [1, { id: 1, name: 'one', fullName: 'one', type: 'test', url: fileUrl('tests/a.test.ts') }],
            [2, { id: 2, name: 'two', fullName: 'two', type: 'test', url: fileUrl('tests/a.test.ts') }],
        ]);

        const { coverage, orphanedKeyCount } = mapCoverageToInspectorIds(rawCoverage, [1, 2], testHierarchy);

        expect(orphanedKeyCount).toBe(1);
        expect(coverage).toEqual({ 'static': {}, perTest: { 'tests/a.test.ts > one': { '1': 5 }, 'tests/a.test.ts > two': { '1': 2 } } });
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

describe('record sharing with the raw coverage', () => {
    const testHierarchy = new Map<number, TestInfo>([
        [1, { id: 1, name: 'plain', fullName: 'plain', type: 'test', url: fileUrl('tests/a.test.ts') }],
        [2, { id: 2, name: 'static-hit', fullName: 'static-hit', type: 'test', url: fileUrl('tests/a.test.ts') }],
    ]);

    it('hands on the raw record of a test credited with one key and no static mutant, and copies one that holds a static mutant', () => {
        // Copying every record hit by hit costs the dry run of a large suite tens of milliseconds
        // in allocation and garbage collection; only a record that must change is copied.
        const rawCoverage: MutantCoverage = {
            'static': { '9': 1 },
            perTest:  {
                'tests/a.test.ts@@test-1': { '1': 2 },
                'tests/a.test.ts@@test-2': { '2': 3, '9': 4 },
            },
        };
        const snapshot = structuredClone(rawCoverage);

        const { coverage } = mapCoverageToInspectorIds(rawCoverage, [1, 2], testHierarchy);

        expect(coverage).toEqual({
            'static': { '9': 5 },
            perTest:  { 'tests/a.test.ts > plain': { '1': 2 }, 'tests/a.test.ts > static-hit': { '2': 3 } },
        });
        expect(coverage!.perTest['tests/a.test.ts > plain']).toBe(rawCoverage.perTest['tests/a.test.ts@@test-1']);
        expect(coverage!.perTest['tests/a.test.ts > static-hit']).not.toBe(rawCoverage.perTest['tests/a.test.ts@@test-2']);
        expect(rawCoverage).toEqual(snapshot);
    });

    it('never writes into a shared record when an orphaned key adds hits to it', () => {
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  {
                'tests/a.test.ts@@test-1':    { '1': 2 },
                'tests/gone.test.ts@@test-1': { '1': 30 },
            },
        };
        const snapshot = structuredClone(rawCoverage);

        const { coverage } = mapCoverageToInspectorIds(rawCoverage, [1], testHierarchy);

        expect(coverage!.perTest).toEqual({ 'tests/a.test.ts > plain': { '1': 32 } });
        expect(rawCoverage).toEqual(snapshot);
    });
});

describe('legacy mapping of a test whose every mutant is static', () => {
    it('leaves no empty perTest entry for it', () => {
        const rawCoverage: MutantCoverage = {
            'static': { '5': 1 },
            perTest:  { 'test-1': { '5': 2 }, 'test-2': { '6': 1 } },
        };
        const testHierarchy = new Map<number, TestInfo>([
            [1, { id: 1, name: 'only-static', fullName: 'only-static', type: 'test' }],
            [2, { id: 2, name: 'own-mutant', fullName: 'own-mutant', type: 'test' }],
        ]);

        const { coverage } = mapCoverageToInspectorIds(rawCoverage, [1, 2], testHierarchy);

        expect(coverage).toEqual({ 'static': { '5': 3 }, perTest: { 'own-mutant': { '6': 1 } } });
    });
});
