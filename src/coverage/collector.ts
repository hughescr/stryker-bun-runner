/**
 * Coverage collector
 * Collects and processes coverage data from test runs
 */

import { readFile, unlink } from 'node:fs/promises';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { CoverageFileData, LateHitEntry } from './types.js';

/**
 * Add every hit count in `from` into `into`, summing the counts of a mutant
 * both already hold.
 */
function addHitCounts(into: Record<string, number>, from: Record<string, number>): void {
    for(const [mutantId, count] of Object.entries(from)) {
        into[mutantId] = (into[mutantId] ?? 0) + count;
    }
}

/**
 * Merge the coverage lines of one run into Stryker's MutantCoverage.
 *
 * The real hit counts are kept: Stryker sums them per mutant (static plus every
 * perTest entry) and gives each mutant run a hitLimit of 100 × that sum. Where
 * two lines report the same test id (shouldn't happen, but be safe) or the same
 * static mutant, their counts are summed — each line is a separate record of
 * hits, and dropping one would understate the limit.
 */
function mergeCoverageData(dataList: CoverageFileData[]): MutantCoverage {
    const merged: MutantCoverage = { perTest: {}, 'static': {} };
    for(const data of dataList) {
        for(const [testId, counts] of Object.entries(data.perTest)) {
            merged.perTest[testId] ??= {};
            addHitCounts(merged.perTest[testId], counts);
        }
        addHitCounts(merged.static, data.static);
    }
    return merged;
}

/**
 * Read and parse the coverage data file written by the preload script.
 *
 * The file uses JSON lines format (one JSON object per line) to support
 * atomic appends from multiple test files running in parallel. Malformed
 * lines are skipped (with a logged warning) rather than failing the whole
 * read; a missing/unreadable file yields an empty array.
 *
 * @param coverageFile - Path to the coverage data file
 * @param logger - Optional logger for diagnostic warnings
 * @returns Parsed coverage entries, one per JSON line successfully parsed
 */
async function readCoverageFileData(
    coverageFile: string,
    logger?: Pick<Logger, 'warn'>
): Promise<CoverageFileData[]> {
    try {
        const content = await readFile(coverageFile, 'utf8');

        // Parse JSON lines format (one JSON object per line)
        // Stryker disable next-line MethodExpression: Removing .trim() is equivalent because .filter() removes empty lines anyway
        const trimmed = content.trim();
        // Stryker disable next-line MethodExpression,ConditionalExpression,EqualityOperator: equivalent mutants — removing .filter() or always-true/>=0 condition passes empty lines to JSON.parse which throws and skips them; result is identical
        const lines = trimmed.split('\n').filter(line => line.length > 0);
        const dataList: CoverageFileData[] = [];

        for(const line of lines) {
            try {
                const data = JSON.parse(line) as CoverageFileData;
                dataList.push(data);
            } catch (parseError) {
                // Skip invalid lines - log but don't fail
                const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                // Stryker disable next-line all: Logging statement
                logger?.warn('[Stryker Coverage] Failed to parse coverage line: %s', errorMsg);
            }
        }

        return dataList;
    } catch{
        // No coverage file - coverage wasn't enabled or no mutants were covered
        // This is not an error condition, just return an empty list
        return [];
    }
}

/**
 * Collect coverage data from a test run
 *
 * Reads the coverage data file written by the preload script and converts it
 * to Stryker's MutantCoverage format.
 *
 * @param coverageFile - Path to the coverage data file
 * @param logger - Optional logger for diagnostic warnings
 * @returns MutantCoverage object, or undefined if no coverage was collected
 */
export async function collectCoverage(
    coverageFile: string,
    logger?: Pick<Logger, 'warn'>
): Promise<MutantCoverage | undefined> {
    try {
        const dataList = await readCoverageFileData(coverageFile, logger);

        if(dataList.length === 0) {
            // No valid coverage data found
            return undefined;
        }

        // Merge all coverage data from different test files
        return mergeCoverageData(dataList);
    } catch{
    // No coverage file - coverage wasn't enabled or no mutants were covered
    // This is not an error condition, just return undefined
        return undefined;
    }
}

/**
 * Collect cross-test async coverage-bleed observations from a test run.
 *
 * Reads the same JSON-lines coverage file as {@link collectCoverage} and
 * flattens the `lateHits` entries recorded by every test file's preload
 * instance. Performs its own file read (rather than sharing one with
 * collectCoverage) — the coverage file is small and dry-run-only, so the
 * extra read is cheap and keeps collectCoverage's signature/behavior (and
 * its existing test suite) unchanged.
 *
 * @param coverageFile - Path to the coverage data file
 * @param logger - Optional logger for diagnostic warnings
 * @returns All lateHits entries across every JSON line, or [] if none were recorded
 */
export async function collectLateHits(
    coverageFile: string,
    logger?: Pick<Logger, 'warn'>
): Promise<LateHitEntry[]> {
    const dataList = await readCoverageFileData(coverageFile, logger);
    return dataList.flatMap(data => data.lateHits ?? []);
}

/**
 * Clean up coverage file
 *
 * Removes the coverage data file after it has been processed.
 */
export async function cleanupCoverageFile(coverageFile: string): Promise<void> {
    try {
        await unlink(coverageFile);
    } catch{
    // Ignore errors - file may not exist or may have already been deleted
    }
}
