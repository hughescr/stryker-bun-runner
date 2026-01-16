/**
 * Coverage collector
 * Collects and processes coverage data from test runs
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import { readFile, unlink } from 'node:fs/promises';
import type { CoverageFileData } from './types.js';

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
            // Stryker disable next-line ConditionalExpression: new Set(undefined) works, mutation is equivalent
            if(!merged.perTest[testId]) {
                merged.perTest[testId] = mutantIds;
            } else {
                // Union mutant IDs if duplicate test ID (shouldn't happen, but be safe)
                const existingSet = new Set(merged.perTest[testId]);
                for(const mutantId of mutantIds) {
                    existingSet.add(mutantId);
                }
                merged.perTest[testId] = Array.from(existingSet);
            }
        }

        // Merge static data
        for(const mutantId of data.static) {
            staticSet.add(mutantId);
        }
    }

    merged.static = Array.from(staticSet);
    return merged;
}

/**
 * Collect coverage data from a test run
 *
 * Reads the coverage data file written by the preload script and converts it
 * to Stryker's MutantCoverage format.
 *
 * The file uses JSON lines format (one JSON object per line) to support
 * atomic appends from multiple test files running in parallel.
 *
 * @param coverageFile - Path to the coverage data file
 * @returns MutantCoverage object, or undefined if no coverage was collected
 */
export async function collectCoverage(
    coverageFile: string
): Promise<MutantCoverage | undefined> {
    try {
        const content = await readFile(coverageFile, 'utf-8');

        // Parse JSON lines format (one JSON object per line)
        // Stryker disable next-line MethodExpression: Removing .trim() is equivalent because .filter() removes empty lines anyway
        const trimmed = content.trim();
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
                // eslint-disable-next-line no-console -- intentional warning for debug purposes
                console.warn(`[Stryker Coverage] Failed to parse coverage line: ${errorMsg}`);
            }
        }

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
