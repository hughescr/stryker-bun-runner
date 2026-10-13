/**
 * Likely killers first: the order a static (full-suite) mutant run hands bun its
 * test files.
 *
 * With `--bail` a run stops at its first failing test, so the time a killed
 * mutant costs is the time spent in the files that run before the one that
 * kills it. Cheapest-first (the dry-run duration of each file) is the baseline
 * order. A static mutant runs every test file, and most of them never call into
 * the mutated module, so this module ranks the files by how likely each is to
 * kill it, and keeps cheapest-first between files with the same rank:
 *
 * 1. Files whose tests executed this mutant in the dry run, then the rest.
 * 2. Among those, the files whose tests executed more of the source file's
 *    mutants first (so a file that executed none comes after one that executed
 *    some): usually the module's own unit tests.
 * 3. Then the test file named after the source file (`src/foo.ts` →
 *    `foo.test.ts`).
 *
 * Every input comes from the dry run (or Stryker), so a mutant's order is the
 * same in every worker and in every run over the same dry run. See
 * docs/internals.md, "Mutant runs", for what a different order can and cannot
 * change.
 */

import path from 'node:path';
import { TEST_FILE_SUFFIX_RE } from './test-name-pattern.js';

/**
 * The instrumenter's mutant switch, `stryMutAct_9fa48("<id>")`: every mutant in an
 * instrumented file has one (@stryker-mutator/instrumenter, util/syntax-helpers.js).
 * Pinned against the installed instrumenter's real output by a unit test.
 */
// Stryker disable next-line Regex: version-coupled to the instrumenter's helper name; covered by the real-instrumenter test in likely-killer-order.test.ts
const MUTANT_SWITCH_RE = /stryMutAct_9fa48\("([^"\\]+)"\)/g;

/** The ids of the mutants an instrumented source file contains, from its mutant switches. */
export function mutantIdsInInstrumentedSource(code: string): Set<string> {
    return new Set(Array.from(code.matchAll(MUTANT_SWITCH_RE), match => match[1]));
}

/** How {@link TestFileCoverage} is persisted: a file table, and per mutant the indices of its files. */
export interface TestFileCoverageJson {
    files:   string[]
    mutants: Record<string, number[]>
}

/**
 * Which test files' tests executed which mutants in the dry run.
 *
 * Built from the raw per-test coverage: the preload keys each test's entry
 * `<project file>@@test-<n>` (see splitCounterKey in coverage-mapper.ts), so the
 * file is the key's prefix and no pairing with inspector tests is needed. Raw
 * coverage still holds the per-test hits of static mutants, which the coverage
 * handed to Stryker strips ("static wins"); those are what rank a static mutant's
 * own files first. Keys without `@@` (the legacy `test-<n>` format) name no file
 * and are left out.
 */
export class TestFileCoverage {
    private constructor(
        private readonly files: readonly string[],
        private readonly byMutant: ReadonlyMap<string, readonly number[]>
    ) {}

    /** From the dry run's raw per-test coverage; undefined when no entry names a file. */
    public static fromPerTest(perTest: Readonly<Record<string, Readonly<Record<string, number>>>>): TestFileCoverage | undefined {
        const files: string[] = [];
        const fileIndex = new Map<string, number>();
        const byMutant = new Map<string, Set<number>>();
        for(const [key, counts] of Object.entries(perTest)) {
            const sepIdx = key.lastIndexOf('@@');
            if(sepIdx === -1) {
                continue;
            }
            const file = key.slice(0, sepIdx);
            let index = fileIndex.get(file);
            if(index === undefined) {
                index = files.push(file) - 1;
                fileIndex.set(file, index);
            }
            for(const mutantId of Object.keys(counts)) {
                let indices = byMutant.get(mutantId);
                if(indices === undefined) {
                    indices = new Set();
                    byMutant.set(mutantId, indices);
                }
                indices.add(index);
            }
        }
        return files.length === 0 ? undefined : new TestFileCoverage(files, new Map([...byMutant].map(([mutantId, indices]) => [mutantId, [...indices]])));
    }

    /**
     * From its persisted form, or undefined when `value` is absent or malformed (any
     * index that is not an integer naming a file in the table). It is advisory: it
     * orders files, it never selects them.
     */
    public static fromJson(value: unknown): TestFileCoverage | undefined {
        if(typeof value !== 'object' || value === null) {
            return undefined;
        }
        const { files, mutants } = value as Partial<Record<keyof TestFileCoverageJson, unknown>>;
        if(!Array.isArray(files) || !files.every(file => typeof file === 'string') || typeof mutants !== 'object' || mutants === null || Array.isArray(mutants)) {
            return undefined;
        }
        const isFileIndex = (index: unknown): boolean => Number.isInteger(index) && (index as number) >= 0 && (index as number) < files.length;
        const entries = Object.entries(mutants as Record<string, unknown>);
        if(!entries.every(([, indices]) => Array.isArray(indices) && indices.every(index => isFileIndex(index)))) {
            return undefined;
        }
        return new TestFileCoverage(files, new Map(entries as [string, number[]][]));
    }

    public toJSON(): TestFileCoverageJson {
        return { files: [...this.files], mutants: Object.fromEntries([...this.byMutant].map(([mutantId, indices]) => [mutantId, [...indices]])) };
    }

    /** The files whose tests executed `mutantId`. */
    public filesCovering(mutantId: string): Set<string> {
        return new Set((this.byMutant.get(mutantId) ?? []).map(index => this.files[index]));
    }

    /** Per file, how many of `mutantIds` its tests executed; files that executed none are left out. */
    public coverageCounts(mutantIds: Iterable<string>): Map<string, number> {
        const counts = new Map<string, number>();
        for(const mutantId of mutantIds) {
            for(const index of this.byMutant.get(mutantId) ?? []) {
                const file = this.files[index];
                counts.set(file, (counts.get(file) ?? 0) + 1);
            }
        }
        return counts;
    }
}

/**
 * A test that says whether a test file is named after `sourceFile`: `src/foo.ts`
 * and `tests/foo.test.ts` or `foo.spec.tsx`, case-insensitive. The source file's
 * stem is worked out once, not per test file. No test file is named after an
 * undefined source file.
 */
export function namedAfter(sourceFile: string | undefined): (testFile: string) => boolean {
    if(sourceFile === undefined) {
        return () => false;
    }
    const sourceStem = path.parse(sourceFile).name.toLowerCase();
    return testFile => path.basename(testFile).replace(TEST_FILE_SUFFIX_RE, '').toLowerCase() === sourceStem;
}

/** How a test file ranks for one mutant run; lower sorts first. */
export interface KillerRank {
    /**
     * 0: its tests executed the mutant in the dry run; 1: they did not, or unknown. Files that executed
     * the source file's other mutants come next through {@link sourceMutants}, so they need no rank here.
     */
    coverage:      0 | 1
    /** How many of the source file's mutants its tests executed in the dry run. */
    sourceMutants: number
    /** Named after the source file. */
    namedAfter:    boolean
}

/** Compare two ranks: coverage, then more of the source file's mutants, then the name match. 0 when they are equal. */
export function compareKillerRanks(a: KillerRank, b: KillerRank): number {
    return (a.coverage - b.coverage) || (b.sourceMutants - a.sourceMutants) || (Number(b.namedAfter) - Number(a.namedAfter));
}

/**
 * `files` (already cheapest first) with the likeliest killers moved to the front. The
 * sort is stable, so files that rank the same keep their cheapest-first order. `files`
 * itself is not modified.
 */
export function orderLikelyKillersFirst(files: readonly string[], rankOf: (file: string) => KillerRank): string[] {
    const ranks = new Map(files.map(file => [file, rankOf(file)]));
    return files.toSorted((a, b) => compareKillerRanks(ranks.get(a)!, ranks.get(b)!));
}
