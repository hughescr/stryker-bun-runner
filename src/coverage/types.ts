/**
 * Coverage data type definitions
 */

/**
 * Raw coverage data collected during test execution
 * Maps test ID -> (mutant ID -> number of times that mutant was hit during the test)
 *
 * The counts are the instrumenter's own, unchanged: Stryker sums them per
 * mutant to size each mutant run's hitLimit (infinite-loop protection).
 */
export type PerTestCoverageData = Record<string, Record<string, number>>;

/**
 * A single gap-window coverage-bleed observation: mutant coverage that was
 * recorded in the static bucket between one test's afterEach and the next
 * test's beforeEach, proving code executed after a test ended (most likely a
 * fire-and-forget async chain from that test still running, or benign
 * beforeAll/fixture code for the next test).
 */
export interface LateHitEntry {
    /** Counter-key id ('relativeFile@@test-N') of the test that had just ended when the bleed was observed */
    testId:    string
    /** Mutant ids whose static-bucket count increased during the gap window */
    mutantIds: string[]
}

/**
 * Coverage data written to file by preload script
 */
export interface CoverageFileData {
    /** Coverage data per test */
    perTest:   PerTestCoverageData
    /** Mutants executed outside of tests (during module load), with their hit counts */
    'static':  Record<string, number>
    /** Cross-test async coverage-bleed observations detected during this run (dry-run only); omitted when none were observed */
    lateHits?: LateHitEntry[]
}
