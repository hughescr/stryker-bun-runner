/**
 * Likely killers first: the order a bailing mutant run hands bun its test files.
 *
 * With `--bail` a run stops at its first failing test, so the time a killed
 * mutant costs is the time spent in the files that run before the one that
 * kills it. Cheapest-first (the dry-run duration of each file) is the baseline
 * order. This module ranks a mutant's files by how likely each is to kill it,
 * and keeps cheapest-first between files with the same rank:
 *
 * 1. Dry-run coverage: files whose tests executed this mutant, then files whose
 *    tests executed another mutant of the same source file, then the rest. A
 *    full-suite (static) run gains the most: most of its files never touch the
 *    mutated module.
 * 2. Kills: how many of this source file's mutants each file has killed in this
 *    worker so far, most first.
 * 3. Name: the test file named after the source file (`src/foo.ts` →
 *    `foo.test.ts`), a prior that needs no history.
 *
 * A reorder can change a mutant's status, not just its `killedBy`: a run's
 * verdict comes from the first file in which the mutant does anything but pass.
 * When the mutant fails a test in one file and hangs (or trips the hit limit, or
 * crashes bun) in another, the order decides between Killed and Timeout.
 * {@link KillHistory} therefore marks a source file unsettled the first time one
 * of its mutants ends in Timeout or Error in this worker, and that file's later
 * mutants keep the cheapest-first order. See docs/internals.md, "Mutant runs".
 */

import path from 'node:path';
import { TEST_FILE_SUFFIX_RE } from './test-name-pattern.js';

/**
 * The instrumenter's mutant switch, `stryMutAct_9fa48("<id>")`: every mutant in an
 * instrumented file has one (@stryker-mutator/instrumenter, util/syntax-helpers.js;
 * the same helper name since Stryker 4, and in 9 and 10).
 */
// Stryker disable next-line Regex: version-coupled to the instrumenter's helper name; covered by 'collects every mutant id of an instrumented file'
const MUTANT_SWITCH_RE = /stryMutAct_9fa48\("([^"\\]+)"\)/g;

/** The ids of the mutants an instrumented source file contains, from its mutant switches. */
export function mutantIdsInInstrumentedSource(code: string): Set<string> {
    return new Set(Array.from(code.matchAll(MUTANT_SWITCH_RE), match => match[1]));
}

/**
 * Per test file, the ids of the mutants its tests executed, from the dry run's raw
 * per-test coverage. The preload keys each test's entry `<project file>@@test-<n>`
 * (see splitCounterKey in coverage-mapper.ts), so the file is the key's prefix and
 * no pairing with inspector tests is needed. Raw coverage still holds the per-test
 * hits of static mutants, which the coverage handed to Stryker strips ("static
 * wins"); those are what rank a static mutant's own files first. Keys without
 * `@@` (the legacy `test-<n>` format) name no file and are left out.
 */
export function mutantsByTestFile(perTest: Readonly<Record<string, Readonly<Record<string, number>>>>): Map<string, Set<string>> {
    const byFile = new Map<string, Set<string>>();
    for(const [key, counts] of Object.entries(perTest)) {
        const sepIdx = key.lastIndexOf('@@');
        if(sepIdx === -1) {
            continue;
        }
        const file = key.slice(0, sepIdx);
        let mutants = byFile.get(file);
        if(mutants === undefined) {
            mutants = new Set();
            byFile.set(file, mutants);
        }
        for(const mutantId of Object.keys(counts)) {
            mutants.add(mutantId);
        }
    }
    return byFile;
}

/** True when `testFile` is named after `sourceFile`: `src/foo.ts` and `tests/foo.test.ts` or `foo.spec.tsx`. Case-insensitive. */
export function isNamedAfter(testFile: string, sourceFile: string): boolean {
    const testStem = path.basename(testFile).replace(TEST_FILE_SUFFIX_RE, '');
    const sourceStem = path.parse(sourceFile).name;
    return testStem.toLowerCase() === sourceStem.toLowerCase();
}

/** What this worker's earlier mutant runs showed for one source file. */
interface SourceFileRecord {
    /** Per test file (project-relative, the test id prefix), the mutants of this source file it killed. */
    kills:     Map<string, number>
    /** A run for one of its mutants ended in Timeout or Error: keep the cheapest-first order. */
    unsettled: boolean
}

/**
 * Per mutated source file, which test files killed its mutants in this worker, and
 * whether any of its mutant runs ended in Timeout or Error.
 *
 * It lives as long as the runner: a worker recycled by `maxTestRunnerReuse` starts
 * again from nothing, and nothing is shared between workers.
 */
export class KillHistory {
    private readonly bySource = new Map<string, SourceFileRecord>();

    private recordFor(sourceFile: string): SourceFileRecord {
        let record = this.bySource.get(sourceFile);
        if(record === undefined) {
            record = { kills: new Map(), unsettled: false };
            this.bySource.set(sourceFile, record);
        }
        return record;
    }

    /** Credit one kill of a `sourceFile` mutant to each of `testFiles` (each counted once). */
    public recordKill(sourceFile: string, testFiles: Iterable<string>): void {
        const { kills } = this.recordFor(sourceFile);
        for(const testFile of new Set(testFiles)) {
            kills.set(testFile, (kills.get(testFile) ?? 0) + 1);
        }
    }

    /** A `sourceFile` mutant's run ended in Timeout or Error. Permanent for this worker. */
    public recordUnsettled(sourceFile: string): void {
        this.recordFor(sourceFile).unsettled = true;
    }

    public isUnsettled(sourceFile: string): boolean {
        return this.bySource.get(sourceFile)?.unsettled === true;
    }

    /** How many `sourceFile` mutants `testFile` has killed. */
    public kills(sourceFile: string, testFile: string): number {
        return this.bySource.get(sourceFile)?.kills.get(testFile) ?? 0;
    }
}

/** How a test file ranks for one mutant run; lower sorts first. */
export interface KillerRank {
    /** 0: its tests executed the mutant in the dry run; 1: another mutant of the same source file; 2: neither, or unknown. */
    coverage:   0 | 1 | 2
    /** Kills of the source file's mutants in this worker. */
    kills:      number
    /** Named after the source file. */
    namedAfter: boolean
}

/** Compare two ranks: coverage, then more kills, then the name match. 0 when they are equal. */
export function compareKillerRanks(a: KillerRank, b: KillerRank): number {
    return (a.coverage - b.coverage) || (b.kills - a.kills) || (Number(b.namedAfter) - Number(a.namedAfter));
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
