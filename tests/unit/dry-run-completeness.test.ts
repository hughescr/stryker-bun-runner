/**
 * Unit tests for the dry-run completeness checks (src/dry-run-completeness.ts).
 *
 * Every count is exact: each check compares two records of the same run that
 * bun 1.3.7, 1.3.14 and 1.4.2 were observed to keep in lockstep on healthy
 * runs (see the module's doc comment for the evidence), so any difference is
 * reported, however small.
 */

import { describe, it, expect } from 'bun:test';
import { findDryRunDataLoss, type DryRunCompletenessFacts } from '../../src/dry-run-completeness.js';
import type { TestInfo } from '../../src/inspector/types.js';

function testInfo(id: number, status: TestInfo['status'], extra: Partial<TestInfo> = {}): TestInfo {
    return { id, name: `t${id}`, fullName: `t${id}`, type: 'test', status, ...extra };
}

/** A healthy run: 3 passing tests (one retried twice), 1 skipped, 1 pending, a describe, matching coverage. */
function healthyFacts(): DryRunCompletenessFacts {
    return {
        executionOrder: [2, 3, 3, 3, 4],
        testHierarchy:  [
            { id: 1, name: 'suite', fullName: 'suite', type: 'describe' },
            testInfo(2, 'pass', { parentId: 1 }),
            testInfo(3, 'pass'),
            testInfo(4, 'pass'),
            testInfo(5, 'skip'),
            testInfo(6, 'todo'),
            // Filtered out by test.only: found, never started, never ended.
            testInfo(7, undefined),
        ],
        summary:               { passed: 3, skipped: 1, todo: 1, printed: true },
        coverageKeys:          { keyCount: 5, unmatchedKeyCount: 0 },
        coveredTestIds:        ['a > t2', 'a > t3'],
        resultTestIds:         ['a > t2', 'a > t3', 'a > t4'],
        duplicateFoundIdCount: 0,
    };
}

describe('findDryRunDataLoss', () => {
    it('finds nothing on a healthy run with retries, skipped, todo and .only-filtered tests', () => {
        expect(findDryRunDataLoss(healthyFacts())).toEqual([]);
    });

    it('finds nothing when no coverage file was read (judged separately by the coverage check)', () => {
        expect(findDryRunDataLoss({ ...healthyFacts(), coverageKeys: undefined })).toEqual([]);
    });

    describe('bun summary vs inspector, per status', () => {
        it('reports fewer passing tests from the inspector than bun counted, by exactly one', () => {
            const facts = healthyFacts();
            facts.summary = { ...facts.summary, passed: 4 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'bun\'s summary counts 4 passing test(s), but the Bun inspector reported 3: test events were lost or merged on the way from bun to the runner',
            ]);
        });

        it('reports more passing tests from the inspector than bun counted', () => {
            const facts = healthyFacts();
            facts.summary = { ...facts.summary, passed: 2 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'bun\'s summary counts 2 passing test(s), but the Bun inspector reported 3: test events were lost or merged on the way from bun to the runner',
            ]);
        });

        it('reports a skipped-count mismatch', () => {
            const facts = healthyFacts();
            facts.summary = { ...facts.summary, skipped: 2 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'bun\'s summary counts 2 skipped test(s), but the Bun inspector reported 1: test events were lost or merged on the way from bun to the runner',
            ]);
        });

        it('reports a todo-count mismatch', () => {
            const facts = healthyFacts();
            facts.summary = { ...facts.summary, todo: 0 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'bun\'s summary counts 0 todo test(s), but the Bun inspector reported 1: test events were lost or merged on the way from bun to the runner',
            ]);
        });

        it('counts tests only, never a describe block that carries a status', () => {
            const facts = healthyFacts();
            facts.testHierarchy = [...facts.testHierarchy, { id: 8, name: 'd', fullName: 'd', type: 'describe', status: 'pass' }];
            expect(findDryRunDataLoss(facts)).toEqual([]);
        });
    });

    describe('bun printed no summary at all', () => {
        const NO_SUMMARY = 'bun printed no test summary (no \' N pass\' or \' N fail\' lines): the test process most likely exited before it finished, '
          + 'for example because a test or hook called process.exit, or because it crashed, so the tests after that point never ran and their results and coverage are missing';

        it('says so, and does not blame lost inspector events', () => {
            // The shape of a test that calls process.exit: the inspector saw one test start and none end,
            // and bun's summary counts are all 0 because there is no summary to count.
            const facts: DryRunCompletenessFacts = {
                executionOrder:        [1],
                testHierarchy:         [testInfo(1, undefined), testInfo(2, undefined)],
                summary:               { passed: 0, skipped: 0, todo: 0, printed: false },
                coverageKeys:          { keyCount: 1, unmatchedKeyCount: 0 },
                coveredTestIds:        [],
                resultTestIds:         [],
                duplicateFoundIdCount: 0,
            };
            expect(findDryRunDataLoss(facts)).toEqual([NO_SUMMARY]);
        });

        it('reports it as the only problem, since every other comparison is meaningless without a summary', () => {
            const facts = healthyFacts();
            facts.summary = { passed: 0, skipped: 0, todo: 0, printed: false };
            facts.coverageKeys = { keyCount: 1, unmatchedKeyCount: 1 };
            facts.duplicateFoundIdCount = 2;
            expect(findDryRunDataLoss(facts)).toEqual([NO_SUMMARY]);
        });

        it('says nothing extra when the summary was printed', () => {
            expect(findDryRunDataLoss(healthyFacts())).not.toContain(NO_SUMMARY);
        });
    });

    describe('inspector end statuses', () => {
        it.each(['pass', 'fail', 'timeout', 'skip', 'todo', 'skipped_because_label'] as const)('accepts the status %s bun can emit', (status) => {
            const facts = healthyFacts();
            // Extra tests with this status, kept out of the per-status count comparison below.
            facts.testHierarchy = [...facts.testHierarchy, testInfo(20, status)];
            const problems = findDryRunDataLoss(facts).filter(p => p.includes('does not recognise'));
            expect(problems).toEqual([]);
        });

        it('reports a status the runner does not know, naming it and how many tests ended with it', () => {
            const facts = healthyFacts();
            facts.testHierarchy = [
                ...facts.testHierarchy,
                testInfo(20, 'flaky' as TestInfo['status']),
                testInfo(21, 'flaky' as TestInfo['status']),
                testInfo(22, 'exploded' as TestInfo['status']),
            ];
            expect(findDryRunDataLoss(facts)[0]).toBe(
                '3 test(s) ended with a status this runner does not recognise ("flaky", "exploded"): '
                + 'the Bun inspector protocol has changed, so their results cannot be trusted'
            );
        });

        it('ignores a describe block with an unknown status, as it ignores every describe status', () => {
            const facts = healthyFacts();
            facts.testHierarchy = [...facts.testHierarchy, { id: 8, name: 'd', fullName: 'd', type: 'describe', status: 'flaky' as TestInfo['status'] }];
            expect(findDryRunDataLoss(facts)).toEqual([]);
        });

        it('does not count a test with no status as unknown', () => {
            expect(findDryRunDataLoss(healthyFacts())).toEqual([]);
        });
    });

    describe('inspector start/end consistency', () => {
        it('reports a test that started but never ended', () => {
            const facts = healthyFacts();
            facts.testHierarchy = facts.testHierarchy.map(t => (t.id === 4 ? { ...t, status: undefined } : t));
            facts.summary = { ...facts.summary, passed: 2 };
            expect(findDryRunDataLoss(facts)).toEqual([
                '1 test(s) started but never reported a result: their TestReporter.end events were lost',
            ]);
        });

        it('reports passing and failing tests that never started', () => {
            const facts = healthyFacts();
            facts.executionOrder = [3, 3, 3];
            facts.testHierarchy = [...facts.testHierarchy, testInfo(9, 'fail')];
            facts.coverageKeys = { keyCount: 3, unmatchedKeyCount: 0 };
            expect(findDryRunDataLoss(facts)).toEqual([
                '3 test(s) reported a pass or fail result without a TestReporter.start event: those start events were lost, so their coverage cannot be paired with them',
            ]);
        });

        it('does not report a skipped or todo test that never started (bun starts neither)', () => {
            const facts = healthyFacts();
            expect(facts.testHierarchy.filter(t => t.status === 'skip' || t.status === 'todo')).toHaveLength(2);
            expect(findDryRunDataLoss(facts)).toEqual([]);
        });

        it('accepts a todo test that started (bun --todo runs it, and its beforeEach records a coverage key)', () => {
            const facts = healthyFacts();
            facts.executionOrder = [...facts.executionOrder, 6];
            facts.coverageKeys = { keyCount: 6, unmatchedKeyCount: 0 };
            expect(findDryRunDataLoss(facts)).toEqual([]);
        });
    });

    describe('coverage keys vs test starts', () => {
        it('reports one coverage key fewer than test starts', () => {
            const facts = healthyFacts();
            facts.coverageKeys = { keyCount: 4, unmatchedKeyCount: 0 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'the coverage preload recorded 4 per-test coverage key(s), one per test run (retries included), but the Bun inspector reported 5 test start(s): per-test coverage would be credited to the wrong tests',
            ]);
        });

        it('reports one coverage key more than test starts', () => {
            const facts = healthyFacts();
            facts.coverageKeys = { keyCount: 6, unmatchedKeyCount: 1 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'the coverage preload recorded 6 per-test coverage key(s), one per test run (retries included), but the Bun inspector reported 5 test start(s): per-test coverage would be credited to the wrong tests',
                '1 of 6 per-test coverage key(s) matched no test the inspector reported, so their coverage would be dropped',
            ]);
        });

        it('reports unmatched coverage keys even when the totals agree', () => {
            const facts = healthyFacts();
            facts.coverageKeys = { keyCount: 5, unmatchedKeyCount: 2 };
            expect(findDryRunDataLoss(facts)).toEqual([
                '2 of 5 per-test coverage key(s) matched no test the inspector reported, so their coverage would be dropped',
            ]);
        });

        it('reports a coverage file with no per-test keys at all when tests ran', () => {
            const facts = healthyFacts();
            facts.coverageKeys = { keyCount: 0, unmatchedKeyCount: 0 };
            expect(findDryRunDataLoss(facts)).toEqual([
                'the coverage preload recorded 0 per-test coverage key(s), one per test run (retries included), but the Bun inspector reported 5 test start(s): per-test coverage would be credited to the wrong tests',
            ]);
        });
    });

    describe('coverage credited to names that are not tests', () => {
        it('lists every unknown id when there are at most five', () => {
            const facts = healthyFacts();
            facts.coveredTestIds = ['a > t2', 'x1', 'x2', 'x3', 'x4', 'x5'];
            expect(findDryRunDataLoss(facts)).toEqual([
                'coverage was recorded under 5 test id(s) that this dry run does not report as tests (x1, x2, x3, x4, x5), so Stryker would ignore that coverage',
            ]);
        });

        it('lists the first five unknown ids and counts the rest', () => {
            const facts = healthyFacts();
            facts.coveredTestIds = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'a > t3'];
            expect(findDryRunDataLoss(facts)).toEqual([
                'coverage was recorded under 7 test id(s) that this dry run does not report as tests (x1, x2, x3, x4, x5, and 2 more), so Stryker would ignore that coverage',
            ]);
        });
    });

    describe('inspector found events', () => {
        it('reports a test id that bun reported as found more than once', () => {
            const facts = healthyFacts();
            facts.duplicateFoundIdCount = 1;
            expect(findDryRunDataLoss(facts)).toEqual([
                '1 TestReporter.found event(s) reused a test id already seen, merging distinct tests under one id',
            ]);
        });

        it('reports tests and describe blocks whose parent describe block was never found', () => {
            const facts = healthyFacts();
            facts.testHierarchy = [
                ...facts.testHierarchy,
                { id: 10, name: 'inner', fullName: 'inner', type: 'describe', parentId: 99 },
                { ...testInfo(11, undefined), parentId: 98 },
            ];
            expect(findDryRunDataLoss(facts)).toEqual([
                '2 test(s) or describe block(s) name a parent describe block whose TestReporter.found event never arrived, so their names lack part of the describe path',
            ]);
        });
    });

    it('reports every problem it finds, in a fixed order', () => {
        const facts: DryRunCompletenessFacts = {
            executionOrder:        [1],
            testHierarchy:         [testInfo(1, undefined), testInfo(2, 'pass', { parentId: 50 })],
            summary:               { passed: 2, skipped: 0, todo: 0, printed: true },
            coverageKeys:          { keyCount: 2, unmatchedKeyCount: 1 },
            coveredTestIds:        ['ghost'],
            resultTestIds:         [],
            duplicateFoundIdCount: 3,
        };
        expect(findDryRunDataLoss(facts)).toEqual([
            'bun\'s summary counts 2 passing test(s), but the Bun inspector reported 1: test events were lost or merged on the way from bun to the runner',
            '1 test(s) started but never reported a result: their TestReporter.end events were lost',
            '1 test(s) reported a pass or fail result without a TestReporter.start event: those start events were lost, so their coverage cannot be paired with them',
            'the coverage preload recorded 2 per-test coverage key(s), one per test run (retries included), but the Bun inspector reported 1 test start(s): per-test coverage would be credited to the wrong tests',
            '1 of 2 per-test coverage key(s) matched no test the inspector reported, so their coverage would be dropped',
            'coverage was recorded under 1 test id(s) that this dry run does not report as tests (ghost), so Stryker would ignore that coverage',
            '3 TestReporter.found event(s) reused a test id already seen, merging distinct tests under one id',
            '1 test(s) or describe block(s) name a parent describe block whose TestReporter.found event never arrived, so their names lack part of the describe path',
        ]);
    });
});
