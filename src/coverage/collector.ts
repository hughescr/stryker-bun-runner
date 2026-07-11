/**
 * Coverage collector
 * Collects and processes coverage data from test runs
 */

import { readFile, unlink } from 'node:fs/promises';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { CoverageFileData, LateHitEntry } from './types.js';

/**
 * Convert an array of mutant IDs to CoverageData format
 *
 * CoverageData is Record<mutantId, hitCount>
 * We don't track hit counts, so we just set each to 1
 */
function arrayToCoverageData(mutantIds: string[]): Record<string, number> {
    const coverage: Record<string, number> = {};
    for(const mutantId of mutantIds) {
        coverage[mutantId] = 1;
    }
    return coverage;
}

/**
 * Merge coverage data from multiple test files
 *
 * Takes multiple coverage objects and merges them into one.
 * For perTest data, combines all test IDs.
 * For static data, unions all covered mutants.
 */
function mergeCoverageData(dataList: CoverageFileData[]): CoverageFileData {
    const merged: CoverageFileData = {
        perTest:  {},
        // Stryker disable next-line ArrayDeclaration: Initial value overwritten at line 60, mutation is equivalent
        'static': [],
    };

    const staticSet = new Set<string>();

    for(const data of dataList) {
    // Merge perTest data
        for(const [testId, mutantIds] of Object.entries(data.perTest)) {
            // Stryker disable next-line ConditionalExpression: equivalent mutant — mutating to true makes the first occurrence union an empty set then add all mutantIds, yielding the same result as direct assignment
            if(testId in merged.perTest) {
                // Union mutant IDs if duplicate test ID (shouldn't happen, but be safe)
                const existingSet = new Set(merged.perTest[testId]);
                for(const mutantId of mutantIds) {
                    existingSet.add(mutantId);
                }
                merged.perTest[testId] = [...existingSet];
            } else {
                merged.perTest[testId] = mutantIds;
            }
        }

        // Merge static data
        for(const mutantId of data.static) {
            staticSet.add(mutantId);
        }
    }

    merged.static = [...staticSet];
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
        const mergedData = mergeCoverageData(dataList);

        // Convert to Stryker's MutantCoverage format
        // Stryker expects Record<mutantId, hitCount> not string[]
        const perTest: Record<string, Record<string, number>> = {};
        for(const [testId, mutantIds] of Object.entries(mergedData.perTest)) {
            perTest[testId] = arrayToCoverageData(mutantIds);
        }

        const staticCoverage = arrayToCoverageData(mergedData.static);

        return {
            perTest,
            'static': staticCoverage,
        };
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
