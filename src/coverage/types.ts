/**
 * Coverage data type definitions
 */

import type { MutantCoverage, CoverageData } from '@stryker-mutator/api/core';

/**
 * Raw coverage data collected during test execution
 * Maps test ID -> array of mutant IDs that were executed
 *
 * Note: This is the simplified format we collect in the preload script.
 * It gets converted to CoverageData (Record<string, number>) later.
 */
export type PerTestCoverageData = Record<string, string[]>;

/**
 * Coverage data written to file by preload script
 */
export interface CoverageFileData {
    /** Coverage data per test */
    perTest:  PerTestCoverageData
    /** Mutants executed outside of tests (during module load) */
    'static': string[]
}

/**
 * Re-export types from Stryker API
 */
export type { MutantCoverage, CoverageData };
