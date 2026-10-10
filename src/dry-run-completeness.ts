/**
 * Dry-run completeness checks: every test bun ran, and every per-test coverage
 * key the preload recorded, must be accounted for before a dry run may be
 * reported Complete.
 *
 * A dry run produces three independent records of the same test run: bun's
 * console summary, the inspector's TestReporter events, and the coverage
 * preload's per-test keys (one per beforeEach). Each check below compares two
 * of them EXACTLY, with no absolute or percentage slack: any difference means
 * data was lost or merged somewhere between bun and the runner, and a dry run
 * built on it would hand Stryker coverage that is silently missing or credited
 * to the wrong tests. Failing the dry run is preferred to that.
 *
 * The things that legitimately make the records differ are part of each
 * comparison, not tolerated as slack. Observed with real bun 1.3.7, 1.3.14 and
 * 1.4.2 children on fixture projects:
 * - A skipped test (`test.skip`, `skipIf`, `if(false)`, `describe.skip`) and a
 *   pending test get a TestReporter.end but no start, and run no beforeEach;
 *   bun counts them on its skip and pending summary lines. They are compared
 *   per status, and never expected to start.
 * - A pending test run by bun's include-pending flag gets a start and a
 *   beforeEach (so a coverage key) and still ends with the pending status.
 * - A retried test (`{ retry: N }`) gets one start, and one beforeEach, per
 *   attempt, and one end; bun counts it once. So coverage keys are compared
 *   with start events (attempts), and status counts with distinct tests.
 * - Tests filtered out by `.only` get a found event but neither start nor end,
 *   and bun does not count them at all.
 * - `test.each`/`describe.each` rows, duplicate titles, `test.failing`,
 *   `test.concurrent` and tests defined in a helper module behave like any
 *   other test.
 * - bun prints its summary lines (pass, skip, pending, fail counts) with every
 *   reporter, `--dots` and `--only-failures` included; the pass and fail lines
 *   even when their count is 0.
 * A run with failing tests never reaches these checks (the caller skips them),
 * so hook failures, which bun counts as failures with no inspector events, do
 * not need a rule here.
 */

import type { TestInfo } from './inspector/types.js';

/** bun's own console summary counts. */
export interface BunSummaryCounts {
    passed:  number
    skipped: number
    todo:    number
}

/** Per-test coverage keys read from the dry run's coverage file. */
export interface CoverageKeyCounts {
    /** Keys in the coverage file's perTest record (one per beforeEach, so one per test attempt). */
    keyCount:          number
    /** Keys that could not be paired with any test the inspector reported. */
    unmatchedKeyCount: number
}

/** Everything the completeness checks compare. */
export interface DryRunCompletenessFacts {
    /** Inspector TestReporter.start ids, in order, one per attempt. */
    executionOrder:        readonly number[]
    /** Every test and describe block the inspector reported as found. */
    testHierarchy:         readonly TestInfo[]
    summary:               BunSummaryCounts
    /** Undefined when no coverage file was read (judged separately, see checkCoverageData). */
    coverageKeys:          CoverageKeyCounts | undefined
    /** Test ids the final coverage credits (its perTest keys). */
    coveredTestIds:        readonly string[]
    /** Test ids of the dry run's results. */
    resultTestIds:         readonly string[]
    /** TestReporter.found events that reused an id already seen. */
    duplicateFoundIdCount: number
}

/** How many unknown covered test ids are named in a message before the rest are only counted. */
const MAX_UNKNOWN_IDS_LISTED = 5;

const STATUS_COUNTS = [
    { status: 'pass', label: 'passing', summaryKey: 'passed' },
    { status: 'skip', label: 'skipped', summaryKey: 'skipped' },
    { status: 'todo', label: 'todo', summaryKey: 'todo' },
] as const;

function compareStatusCounts(tests: readonly TestInfo[], summary: BunSummaryCounts): string[] {
    const problems: string[] = [];
    for(const { status, label, summaryKey } of STATUS_COUNTS) {
        const reported = tests.filter(t => t.status === status).length;
        if(reported !== summary[summaryKey]) {
            problems.push(
                `bun's summary counts ${summary[summaryKey]} ${label} test(s), but the Bun inspector reported ${reported}: `
                + 'test events were lost or merged on the way from bun to the runner'
            );
        }
    }
    return problems;
}

function compareStartsAndEnds(tests: readonly TestInfo[], executionOrder: readonly number[]): string[] {
    const problems: string[] = [];
    const started = new Set(executionOrder);
    const neverEnded = tests.filter(t => started.has(t.id) && t.status === undefined).length;
    if(neverEnded > 0) {
        problems.push(`${neverEnded} test(s) started but never reported a result: their TestReporter.end events were lost`);
    }
    const neverStarted = tests.filter(t => !started.has(t.id) && (t.status === 'pass' || t.status === 'fail')).length;
    if(neverStarted > 0) {
        problems.push(
            `${neverStarted} test(s) reported a pass or fail result without a TestReporter.start event: `
            + 'those start events were lost, so their coverage cannot be paired with them'
        );
    }
    return problems;
}

function compareCoverageKeys(coverageKeys: CoverageKeyCounts, startCount: number): string[] {
    const problems: string[] = [];
    if(coverageKeys.keyCount !== startCount) {
        problems.push(
            `the coverage preload recorded ${coverageKeys.keyCount} per-test coverage key(s), one per test run (retries included), `
            + `but the Bun inspector reported ${startCount} test start(s): per-test coverage would be credited to the wrong tests`
        );
    }
    if(coverageKeys.unmatchedKeyCount > 0) {
        problems.push(
            `${coverageKeys.unmatchedKeyCount} of ${coverageKeys.keyCount} per-test coverage key(s) matched no test the inspector reported, `
            + 'so their coverage would be dropped'
        );
    }
    return problems;
}

function findUnknownCoveredIds(coveredTestIds: readonly string[], resultTestIds: readonly string[]): string[] {
    const known = new Set(resultTestIds);
    const unknown = coveredTestIds.filter(id => !known.has(id));
    if(unknown.length === 0) {
        return [];
    }
    const listed = unknown.slice(0, MAX_UNKNOWN_IDS_LISTED);
    const more = unknown.length - listed.length;
    const names = more > 0 ? `${listed.join(', ')}, and ${more} more` : listed.join(', ');
    return [
        `coverage was recorded under ${unknown.length} test id(s) that this dry run does not report as tests (${names}), `
        + 'so Stryker would ignore that coverage',
    ];
}

function checkFoundEvents(testHierarchy: readonly TestInfo[], duplicateFoundIdCount: number): string[] {
    const problems: string[] = [];
    if(duplicateFoundIdCount > 0) {
        problems.push(`${duplicateFoundIdCount} TestReporter.found event(s) reused a test id already seen, merging distinct tests under one id`);
    }
    const ids = new Set(testHierarchy.map(t => t.id));
    const parentless = testHierarchy.filter(t => t.parentId !== undefined && !ids.has(t.parentId)).length;
    if(parentless > 0) {
        problems.push(
            `${parentless} test(s) or describe block(s) name a parent describe block whose TestReporter.found event never arrived, `
            + 'so their names lack part of the describe path'
        );
    }
    return problems;
}

/**
 * Every unexplained difference between the dry run's records, one sentence
 * each (counts, what is affected, and the likely cause), in a fixed order.
 * Empty when everything is accounted for.
 */
export function findDryRunDataLoss(facts: DryRunCompletenessFacts): string[] {
    const tests = facts.testHierarchy.filter(t => t.type === 'test');
    return [
        ...compareStatusCounts(tests, facts.summary),
        ...compareStartsAndEnds(tests, facts.executionOrder),
        ...(facts.coverageKeys ? compareCoverageKeys(facts.coverageKeys, facts.executionOrder.length) : []),
        ...findUnknownCoveredIds(facts.coveredTestIds, facts.resultTestIds),
        ...checkFoundEvents(facts.testHierarchy, facts.duplicateFoundIdCount),
    ];
}
