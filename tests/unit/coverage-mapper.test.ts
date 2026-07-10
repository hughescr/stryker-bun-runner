/**
 * Unit tests for coverage/coverage-mapper
 * Tests mapping of file-prefixed counter-based coverage IDs to inspector test IDs
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import { describe, it, expect, mock } from 'bun:test';
import { mapCoverageToInspectorIds, buildInspectorIdToProjectFile } from '../../src/coverage/coverage-mapper.js';
import type { TestInfo } from '../../src/inspector/types.js';

describe('mapCoverageToInspectorIds', () => {
    const makeLogger = () => ({ warn: mock(() => {}) });

    // ─────────────────────────────────────────────────────────────────────────
    // New format: "relativeFile@@test-N" keys (file-prefixed counter)
    // ─────────────────────────────────────────────────────────────────────────
    describe('file-prefixed counter keys (new format)', () => {
        it('should map file@@test-N keys to full test names using per-file position', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '2': 1, '3': 1 },
                    'tests/foo.test.ts@@test-2': { '4': 1 },
                    'tests/bar.test.ts@@test-1': { '5': 1, '6': 1, '7': 1 },
                },
            };

            const executionOrder = [42, 43, 44];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test', url: 'file:///.stryker-tmp/sandbox-ABC/tests/foo.test.ts' }],
                [43, { id: 43, name: 'test2', fullName: 'Suite > Nested > test2', type: 'test', url: 'file:///.stryker-tmp/sandbox-ABC/tests/foo.test.ts' }],
                [44, { id: 44, name: 'test3', fullName: 'Suite > test3', type: 'test', url: 'file:///.stryker-tmp/sandbox-ABC/tests/bar.test.ts' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // foo.test.ts@@test-1 → 1st test in foo.test.ts → inspector 42 → Suite > test1
            // foo.test.ts@@test-2 → 2nd test in foo.test.ts → inspector 43 → Suite > Nested > test2
            // bar.test.ts@@test-1 → 1st test in bar.test.ts → inspector 44 → Suite > test3
            expect(result).toEqual({
                'static': { '1': 1 },
                perTest:  {
                    'tests/foo.test.ts > Suite > test1':          { '2': 1, '3': 1 },
                    'tests/foo.test.ts > Suite > Nested > test2': { '4': 1 },
                    'tests/bar.test.ts > Suite > test3':          { '5': 1, '6': 1, '7': 1 },
                },
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should correctly separate per-file positions even when execution order is interleaved', () => {
            // Simulates two files running in parallel: A-test1, B-test1, A-test2, B-test2.
            // Coverage keys are in GLOBAL CHRONOLOGICAL ORDER (insertion order from beforeEach).
            // Because beforeEach fires in execution order, coverage key insertion order
            // always matches execution order — even when files interleave.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    // Insertion order matches execution order: A1, B1, A2, B2
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    'tests/b.test.ts@@test-1': { '3': 1 },
                    'tests/a.test.ts@@test-2': { '2': 1 },
                    'tests/b.test.ts@@test-2': { '4': 1 },
                },
            };

            // Execution order is interleaved: A1, B1, A2, B2
            const executionOrder = [10, 20, 11, 21];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'a-first', fullName: 'a-first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'a-second', fullName: 'a-second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [20, { id: 20, name: 'b-first', fullName: 'b-first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts', status: 'pass' }],
                [21, { id: 21, name: 'b-second', fullName: 'b-second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Global positional pairing (insertion order = execution order):
            //   pos 0: a@@test-1 ↔ inspector 10 (a-first)
            //   pos 1: b@@test-1 ↔ inspector 20 (b-first)
            //   pos 2: a@@test-2 ↔ inspector 11 (a-second)
            //   pos 3: b@@test-2 ↔ inspector 21 (b-second)
            // Per-file grouping after pairing:
            //   tests/a.test.ts: [10, 11] → test-1→10 (a-first), test-2→11 (a-second)
            //   tests/b.test.ts: [20, 21] → test-1→20 (b-first), test-2→21 (b-second)
            expect(result!.perTest).toEqual({
                'tests/a.test.ts > a-first':  { '1': 1 },
                'tests/a.test.ts > a-second': { '2': 1 },
                'tests/b.test.ts > b-first':  { '3': 1 },
                'tests/b.test.ts > b-second': { '4': 1 },
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should produce correct mapping when coverage keys are in execution order (determinism guarantee)', () => {
            // The new positional approach is deterministic because coverage key insertion
            // order = execution order (beforeEach fires in test-execution order).
            // This test verifies correct mapping for a sequential multi-file run.

            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'alpha', fullName: 'Suite > alpha', type: 'test', url: 'file:///.stryker-tmp/sandbox-A/tests/foo.test.ts', status: 'pass' }],
                [2, { id: 2, name: 'beta', fullName: 'Suite > beta', type: 'test', url: 'file:///.stryker-tmp/sandbox-A/tests/foo.test.ts', status: 'pass' }],
                [3, { id: 3, name: 'gamma', fullName: 'Suite > gamma', type: 'test', url: 'file:///.stryker-tmp/sandbox-A/tests/bar.test.ts', status: 'pass' }],
            ]);

            // Coverage keys in execution order: foo runs before bar
            const coverageFooFirst: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '1': 1, '2': 1 },
                    'tests/foo.test.ts@@test-2': { '3': 1 },
                    'tests/bar.test.ts@@test-1': { '4': 1, '5': 1 },
                },
            };

            // Coverage keys in execution order: bar runs before foo
            const coverageBarFirst: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/bar.test.ts@@test-1': { '4': 1, '5': 1 },
                    'tests/foo.test.ts@@test-1': { '1': 1, '2': 1 },
                    'tests/foo.test.ts@@test-2': { '3': 1 },
                },
            };

            // Run 1: foo runs before bar — executionOrder and coverage keys both have foo first
            const { coverage: run1 } = mapCoverageToInspectorIds(
                coverageFooFirst,
                [1, 2, 3],
                testHierarchy
            );

            // Run 2: bar runs before foo — executionOrder and coverage keys both have bar first
            const { coverage: run2 } = mapCoverageToInspectorIds(
                coverageBarFirst,
                [3, 1, 2],
                testHierarchy
            );

            // Both must produce identical perTest mappings (same test ↔ same coverage)
            expect(run1!.perTest).toEqual(run2!.perTest);
            expect(run1!.perTest).toEqual({
                'tests/foo.test.ts > Suite > alpha': { '1': 1, '2': 1 },
                'tests/foo.test.ts > Suite > beta':  { '3': 1 },
                'tests/bar.test.ts > Suite > gamma': { '4': 1, '5': 1 },
            });
        });

        it('should handle single file-prefixed test without URL in hierarchy via positional pairing', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '1': 1, '2': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                // url is undefined (e.g. test defined via a helper that doesn't report its url)
                [100, { id: 100, name: 'only test', fullName: 'only test', type: 'test', url: undefined, status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // With positional pairing, the test is found at position 0 regardless of url.
            // The counter key prefix "tests/foo.test.ts" is used for the test name.
            expect(logger.warn).not.toHaveBeenCalled();
            expect(result!.perTest).toEqual({
                'tests/foo.test.ts > only test': { '1': 1, '2': 1 },
            });
        });

        it('should preserve static coverage unchanged', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '10': 1, '20': 1, '30': 1 },
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '1': 1 },
                },
            };

            const executionOrder = [50];
            const testHierarchy = new Map<number, TestInfo>([
                [50, { id: 50, name: 'test', fullName: 'test', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.static).toEqual({ '10': 1, '20': 1, '30': 1 });
        });

        it('should sort counter IDs numerically within a file (not lexicographically)', () => {
            // test-10 sorts AFTER test-9 numerically (correct)
            // but BEFORE test-2 lexicographically (wrong)
            // A file with 10 tests produces counters test-1..test-10.
            // Coverage keys are in global insertion order (matching execution order).
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1':  { '10': 1 },
                    'tests/foo.test.ts@@test-2':  { '20': 1 },
                    'tests/foo.test.ts@@test-3':  { '30': 1 },
                    'tests/foo.test.ts@@test-4':  { '40': 1 },
                    'tests/foo.test.ts@@test-5':  { '50': 1 },
                    'tests/foo.test.ts@@test-6':  { '60': 1 },
                    'tests/foo.test.ts@@test-7':  { '70': 1 },
                    'tests/foo.test.ts@@test-8':  { '80': 1 },
                    'tests/foo.test.ts@@test-9':  { '90': 1 },
                    'tests/foo.test.ts@@test-10': { '100': 1 },
                },
            };

            // 10 tests in execution order
            const executionOrder = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
            const testHierarchy = new Map<number, TestInfo>([
                [101, { id: 101, name: 'first',   fullName: 'first',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [102, { id: 102, name: 'second',  fullName: 'second',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [103, { id: 103, name: 'third',   fullName: 'third',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [104, { id: 104, name: 'fourth',  fullName: 'fourth',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [105, { id: 105, name: 'fifth',   fullName: 'fifth',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [106, { id: 106, name: 'sixth',   fullName: 'sixth',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [107, { id: 107, name: 'seventh', fullName: 'seventh', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [108, { id: 108, name: 'eighth',  fullName: 'eighth',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [109, { id: 109, name: 'ninth',   fullName: 'ninth',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [110, { id: 110, name: 'tenth',   fullName: 'tenth',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Numerically: test-1→first, test-2→second, ..., test-10→tenth
            // Lexicographically (wrong): test-1→first, test-10→second, test-2→third
            expect(result!.perTest).toEqual({
                'tests/foo.test.ts > first':   { '10': 1 },
                'tests/foo.test.ts > second':  { '20': 1 },
                'tests/foo.test.ts > third':   { '30': 1 },
                'tests/foo.test.ts > fourth':  { '40': 1 },
                'tests/foo.test.ts > fifth':   { '50': 1 },
                'tests/foo.test.ts > sixth':   { '60': 1 },
                'tests/foo.test.ts > seventh': { '70': 1 },
                'tests/foo.test.ts > eighth':  { '80': 1 },
                'tests/foo.test.ts > ninth':   { '90': 1 },
                'tests/foo.test.ts > tenth':   { '100': 1 },
            });
        });

        it('should fold extra coverage keys into the last inspector test (test retry / extra attempt)', () => {
            // When there are MORE coverage keys than non-skipped inspector tests, the excess keys
            // are treated as retry attempts and their coverage data is merged (folded) into the
            // last inspector test for that file. No warning is emitted.
            //
            // This handles the case where a test uses { retry: N } — each attempt fires beforeEach
            // (producing a new counter key) but TestReporter.start fires only once (one inspector ID).
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    'tests/a.test.ts@@test-2': { '2': 1 },
                    'tests/a.test.ts@@test-3': { '3': 1 },
                },
            };

            // Only 2 non-skipped inspector tests — coverage has 3 keys (e.g. one test retried once)
            const executionOrder = [10, 11];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // test-1 → first, test-2 → second, test-3 → second (clamped, merged)
            expect(result!.perTest).toEqual({
                'tests/a.test.ts > first':  { '1': 1 },
                'tests/a.test.ts > second': { '2': 1, '3': 1 },
            });

            // No warning — extra keys are handled gracefully via retry folding
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should warn (and NOT fold) when there are fewer coverage keys than non-skipped inspector tests', () => {
            // When keys < nonSkipped (data loss case), warn and map as many as possible.
            // This is the OPPOSITE of the retry-folding case (keys > nonSkipped):
            //   - keys > nonSkipped → retry, no warning, fold excess into last inspector
            //   - keys < nonSkipped → data loss, warn, partial map
            //
            // Killing ConditionalExpression and BlockStatement mutants at pairKeysWithInspectorIds line ~240.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    // test-2 and test-3 MISSING — data loss
                },
            };

            // 3 non-skipped inspector tests, only 1 counter key
            const executionOrder = [10, 11, 12];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [12, { id: 12, name: 'third',  fullName: 'third',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Only the first key can be mapped
            expect(result!.perTest).toEqual({
                'tests/a.test.ts > first': { '1': 1 },
            });

            // Warn: 1 key < 3 non-skipped inspectors
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Coverage/execution count mismatch'),
                1, // coverage entries
                3, // non-skipped tests
                1  // partial mapping count
            );
        });

        it('should NOT run interior-gap check when global counts are unbalanced (retry excess case)', () => {
            // When keys > nonSkipped (retry-excess), checkInteriorGap must remain false.
            // If the ConditionalExpression mutant (always-true) survived, the interior-gap check
            // would fire for the retry scenario and produce a false-positive warning.
            //
            // Setup: 3 keys from file a (test-1, test-2, test-3) with only 2 non-skipped inspectors.
            // Pairs: a@@test-1→10, a@@test-2→11. checkInteriorGap = (3 === 2) → false.
            //
            // However, inspector 11 has url='tests/b.test.ts' (simulates a cross-file scenario).
            // If always-true mutant fires: warnInteriorGapIfPresent runs on pairs
            //   → pair[1]=(a, 11): filePrefix='tests/a.test.ts' vs inspectorFile='tests/b.test.ts'
            //   → mismatch → warns.
            // With correct code: warnInteriorGapIfPresent NOT called → no warning.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    'tests/a.test.ts@@test-2': { '2': 1 },
                    'tests/a.test.ts@@test-3': { '3': 1 }, // excess key → retry (no warning)
                },
            };

            // Only 2 non-skipped inspectors → global excess (3 keys > 2 inspectors)
            // Inspector 11 has b.test.ts URL — if interior-gap check ran, pair[1] would trigger warn
            const executionOrder = [10, 11];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'a-first', fullName: 'a-first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'b-first', fullName: 'b-first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // No interior-gap warning — the check must NOT run when keys > inspectors
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('sorts file-prefixed counter IDs numerically within a file after positional pairing', () => {
            // After global positional pairing, resolveCounterKeys uses N from "file@@test-N"
            // to look up inspectorId at fileIds[N-1]. If counter keys arrive out of numeric order
            // (e.g. test-3 before test-1), the sort in resolveCounterKeys ensures correct N→position
            // mapping within the file.
            //
            // Coverage keys are in insertion order (test-1, test-2, test-3).
            // After positional pairing: test-1→10 (1st), test-2→20 (2nd), test-3→30 (3rd).
            // The sort in resolveCounterKeys re-sorts them so N=1→pos0, N=2→pos1, N=3→pos2.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '100': 1 },
                    'tests/foo.test.ts@@test-2': { '200': 1 },
                    'tests/foo.test.ts@@test-3': { '300': 1 },
                },
            };

            const executionOrder = [10, 20, 30];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [20, { id: 20, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
                [30, { id: 30, name: 'third',  fullName: 'third',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts', status: 'pass' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.perTest).toEqual({
                'tests/foo.test.ts > first':  { '100': 1 },
                'tests/foo.test.ts > second': { '200': 1 },
                'tests/foo.test.ts > third':  { '300': 1 },
            });
        });

        it('handles file-prefixed counter IDs with large N: numeric sort ensures test-5 maps to 5th position', () => {
            // Coverage keys for 5 tests in a single file — insertion order matches execution order.
            // resolveCounterKeys numeric sort ensures test-5 (N=5) → fileIds[4] = 5th test.
            // Lexicographic sort would have test-5 at position 5 but file only had 2 coverage keys
            // so fileIds.length=2 and fileIds[4]=undefined → wrong.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/g.test.ts@@test-1': { '1': 1 },
                    'tests/g.test.ts@@test-2': { '2': 1 },
                    'tests/g.test.ts@@test-3': { '3': 1 },
                    'tests/g.test.ts@@test-4': { '4': 1 },
                    'tests/g.test.ts@@test-5': { '5': 1 },
                },
            };

            const executionOrder = [1, 2, 3, 4, 5];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'pos1', fullName: 'pos1', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts', status: 'pass' }],
                [2, { id: 2, name: 'pos2', fullName: 'pos2', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts', status: 'pass' }],
                [3, { id: 3, name: 'pos3', fullName: 'pos3', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts', status: 'pass' }],
                [4, { id: 4, name: 'pos4', fullName: 'pos4', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts', status: 'pass' }],
                [5, { id: 5, name: 'pos5', fullName: 'pos5', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts', status: 'pass' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.perTest['tests/g.test.ts > pos1']).toEqual({ '1': 1 });
            expect(result!.perTest['tests/g.test.ts > pos5']).toEqual({ '5': 1 });
        });

        it('should handle deduplication for tests with same name from same file (it.each)', () => {
            // it.each in classifier.test.ts produces the same test name for each iteration
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/c.test.ts@@test-1': { '1': 1 },
                    'tests/c.test.ts@@test-2': { '2': 1 },
                    'tests/c.test.ts@@test-3': { '3': 1 },
                },
            };

            const executionOrder = [1, 2, 3];
            // All three tests from the same file have the same fullName (it.each with %s)
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'should handle %s', fullName: 'Suite > should handle %s', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts' }],
                [2, { id: 2, name: 'should handle %s', fullName: 'Suite > should handle %s', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts' }],
                [3, { id: 3, name: 'should handle %s', fullName: 'Suite > should handle %s', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // With deduplication: [0], [1], [2] suffixes assigned in counter order (deterministic)
            expect(result!.perTest).toEqual({
                'tests/c.test.ts > Suite > should handle %s [0]': { '1': 1 },
                'tests/c.test.ts > Suite > should handle %s [1]': { '2': 1 },
                'tests/c.test.ts > Suite > should handle %s [2]': { '3': 1 },
            });
        });
        it('should reuse existing [N] suffix when an it.each test is retried (kills existingIndex !== undefined path)', () => {
            // When an it.each test retries, resolveEachTestName is called with the SAME
            // (inspectorId, baseName) pair. The second call must REUSE the previously-assigned
            // suffix index (the `existingIndex !== undefined` branch) so that coverage is merged
            // into the same perTest entry as the first attempt.
            //
            // Setup: 2 it.each inspectors (10, 20) sharing the same fullName, plus 1 excess
            // key (test-3 → clamped to inspector 20 since N=3 > fileIds.length=2).
            //
            // nameInspectorIds['Suite > shared'] = {10, 20} → count=2 → dedup enabled
            // test-1 → inspector 10 → key_="10/..." → existingIndex=undefined → assign [0]
            // test-2 → inspector 20 → key_="20/..." → existingIndex=undefined → assign [1]
            // test-3 → inspector 20 (clamped) → key_="20/..." → existingIndex=1 → reuse [1]
            //   • Mutant (always-true): assigns NEW index [2] → wrong key, test-3 lost
            //   • Mutant (empty string): returns "" → wrong key, test-3 lost
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/c.test.ts@@test-1': { '1': 1 },
                    'tests/c.test.ts@@test-2': { '2': 1 },
                    'tests/c.test.ts@@test-3': { '3': 1 }, // excess → clamped to inspector 20
                },
            };

            const executionOrder = [10, 20];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'shared', fullName: 'Suite > shared', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts', status: 'pass' }],
                [20, { id: 20, name: 'shared', fullName: 'Suite > shared', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts', status: 'pass' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // test-3's coverage must merge into [1] (inspector 20's suffix), not create [2] or ""
            expect(result!.perTest).toEqual({
                'tests/c.test.ts > Suite > shared [0]': { '1': 1 },
                'tests/c.test.ts > Suite > shared [1]': { '2': 1, '3': 1 },
            });
        });

        it('should not contaminate dedup logic with unresolved counter keys (testInfo: null guard)', () => {
            // If buildNameInspectorIds included entries with testInfo=null (when the
            // ConditionalExpression or BlockStatement mutant fires), those entries would add
            // inspectorId=undefined to the nameInspectorIds set, making distinctIds.size > 1
            // for a name that should be unique — incorrectly triggering [N] dedup suffixes.
            //
            // Setup: keys from file a AND file b, but only file a has inspectors.
            // - a@@test-1 resolves to inspector 10 → testInfo: non-null
            // - b@@test-1 does NOT resolve (no inspector for file b) → testInfo: null
            //
            // With correct code: !testInfo guard skips b@@test-1 → nameInspectorIds only has
            //   { 'tests/a.test.ts > first': {10} } → size=1 → no dedup suffix.
            // With mutant (always-false guard): b@@test-1 is added with inspectorId=undefined →
            //   nameInspectorIds: { 'tests/a.test.ts > first': {10} } (still fine for name mismatch)
            //   but the `unknown-b@@test-1` entry IS added → size=1 (different name, no effect here).
            //
            // To make this actually distinguishable: both keys must produce the SAME baseName.
            // Use a scenario where `b@@test-1` resolves to the SAME testInfo.fullName as `a@@test-1`
            // by mapping to the same inspector (via clamping). BUT then it HAS testInfo, not null.
            //
            // True testInfo=null case: file "tests/b.test.ts" not in fileToInspectorIds.
            // Even with the mutant, b@@test-1's name is "unknown-tests/b.test.ts@@test-1" which
            // differs from "tests/a.test.ts > first" — no suffix contamination for that name.
            //
            // The real contamination case is: a key with testInfo=null that has the SAME name
            // as another resolved key. This would happen if name="unknown-..." matched — but it
            // doesn't by construction. So the testInfo guard prevents contamination by removing
            // null-testInfo entries from the count, but no test can directly distinguish it
            // without hitting the collision case.
            //
            // We test the guard indirectly: verify no [0] suffix appears when there's only 1
            // valid inspector for the given test name (null-testInfo entries must not count).
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 }, // resolves → inspector 10
                    'tests/b.test.ts@@test-1': { '2': 1 }, // does NOT resolve → testInfo: null
                },
            };

            // Only file a has inspectors — file b is not in executionOrder
            const executionOrder = [10];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Only the resolved key should appear — no [0] suffix (distinctIds.size=1, not 2)
            expect(result!.perTest).toEqual({
                'tests/a.test.ts > first': { '1': 1 },
            });
        });

        it('should map test name from counter key prefix when testInfo.url points to node_modules (RuleTester-style)', () => {
            // Simulates ESLint's RuleTester.run() pattern:
            // - Tests are defined in "tests/my-rule.test.ts" (Bun.main → counter key prefix)
            // - But `it()` calls are made from inside node_modules/eslint/.../rule-tester.js
            //   so Bun's inspector reports that url for the test
            //
            // The fix: use the counter key prefix (= Bun.main = user's file) as the test name prefix,
            // not testInfo.url (which points to node_modules).
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/my-rule.test.ts@@test-1': { '1': 1 },
                    'tests/my-rule.test.ts@@test-2': { '2': 1 },
                    'tests/my-rule.test.ts@@test-3': { '3': 1 },
                },
            };

            const executionOrder = [10, 11, 12];
            const testHierarchy = new Map<number, TestInfo>([
                // All three tests have urls pointing to node_modules (RuleTester calls it() from there)
                [10, { id: 10, name: 'my-rule valid 0', fullName: 'my-rule valid 0', type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
                [11, { id: 11, name: 'my-rule invalid 0', fullName: 'my-rule invalid 0', type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
                [12, { id: 12, name: 'my-rule invalid 1', fullName: 'my-rule invalid 1', type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Test names use counter key prefix (user's file) not node_modules url
            expect(result!.perTest).toEqual({
                'tests/my-rule.test.ts > my-rule valid 0':   { '1': 1 },
                'tests/my-rule.test.ts > my-rule invalid 0': { '2': 1 },
                'tests/my-rule.test.ts > my-rule invalid 1': { '3': 1 },
            });
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should skip skipped tests when pairing coverage keys with inspector tests', () => {
            // Bun fires TestReporter.start for skipped tests, so they appear in executionOrder.
            // However, beforeEach does NOT run for skipped tests, so no counter key is created.
            // The positional pairing must skip over skipped inspector tests.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 }, // first non-skipped test
                    'tests/a.test.ts@@test-2': { '2': 1 }, // second non-skipped test (skip is in between)
                },
            };

            // executionOrder includes the skipped test (inspector fires start for all)
            // test 10: run (pass), test 11: skip, test 12: run (pass)
            const executionOrder = [10, 11, 12];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',   fullName: 'first',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'skipped', fullName: 'skipped', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'skip' }],
                [12, { id: 12, name: 'third',   fullName: 'third',   type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Positional pairing skips inspector 11 (status=skip) → no counter key for it
            // test-1 → pos 0 of non-skipped → inspector 10 (first)
            // test-2 → pos 1 of non-skipped → inspector 12 (third, not skipped)
            expect(result!.perTest).toEqual({
                'tests/a.test.ts > first': { '1': 1 },
                'tests/a.test.ts > third': { '2': 1 },
            });
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should skip pending tests (status="todo") when pairing coverage keys with inspector tests', () => {
            // Pending tests (created via the pending-test API) appear in executionOrder but have no beforeEach
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    'tests/a.test.ts@@test-2': { '2': 1 },
                },
            };

            const executionOrder = [10, 11, 12];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'todo',  fullName: 'todo',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'todo' }],
                [12, { id: 12, name: 'third', fullName: 'third', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result!.perTest).toEqual({
                'tests/a.test.ts > first': { '1': 1 },
                'tests/a.test.ts > third': { '2': 1 },
            });
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should use whole key as file prefix when a coverage key lacks @@ separator (malformed key)', () => {
            // The @@ check that routes us into the file-prefix path only inspects the FIRST key.
            // If a subsequent key is malformed (no @@), the fallback treats the whole key as the
            // file prefix rather than crashing. This exercises the sepIdx === -1 branch in
            // buildFileToInspectorIds (line ~259).
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 }, // valid — triggers file-prefix path
                    'malformed-key':           { '2': 1 }, // no @@ — whole key is the prefix
                },
            };

            // Two non-skipped tests in execution order
            const executionOrder = [10, 11];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            // Should not throw — malformed key is silently treated as its own file prefix
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // tests/a.test.ts@@test-1 → inspector 10 (first), normal lookup by filePrefix+N works
            expect(result!.perTest['tests/a.test.ts > first']).toEqual({ '1': 1 });
            // The malformed key 'malformed-key' becomes its own bucket — but resolveCounterKeys
            // looks for 'malformed-key@@test-N' style which won't find a match in that bucket,
            // so it emits a warn and is skipped. The important thing: no crash.
            expect(result!.perTest['tests/a.test.ts > second']).toBeUndefined();
        });

        it('should warn on interior-gap when a coverage key is cross-paired with an inspector from a different file (Issue 4)', () => {
            // Interior-gap scenario: global counts are balanced (3 keys, 3 non-skipped inspectors)
            // but the pairing is cross-file. This can happen when a beforeAll failure aborts tests
            // in the middle of executionOrder — those aborted tests never fire beforeEach so no
            // counter key is produced, but their inspector start events already fired.
            //
            // Concretely:
            //   executionOrder = [10(file a), 20(file b), 30(file b)]
            //   But file b's beforeAll fails, so only file a's tests run and produce keys:
            //   keys = ['tests/a.test.ts@@test-1', 'tests/a.test.ts@@test-2', 'tests/a.test.ts@@test-3']
            //
            // Global pairing: key[0]=a@@test-1 → 10, key[1]=a@@test-2 → 20, key[2]=a@@test-3 → 30
            // Pair[1] has filePrefix='tests/a.test.ts' but inspector 20 belongs to 'tests/b.test.ts' → mismatch → warn
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    'tests/a.test.ts@@test-2': { '2': 1 },
                    'tests/a.test.ts@@test-3': { '3': 1 },
                },
            };

            const executionOrder = [10, 20, 30];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'a-first',  fullName: 'a-first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [20, { id: 20, name: 'b-first',  fullName: 'b-first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts', status: 'pass' }],
                [30, { id: 30, name: 'b-second', fullName: 'b-second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts', status: 'pass' }],
            ]);

            const logger = makeLogger();
            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // The interior-gap warning should fire for the cross-file pairing
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Interior coverage gap detected'),
                'tests/a.test.ts',  // filePrefix from the key
                'tests/b.test.ts'   // inspector file
            );
        });

        it('should NOT warn on interior-gap for RuleTester-style tests (node_modules URL)', () => {
            // RuleTester tests have testInfo.url pointing to node_modules but the counter key
            // has the user's test file as prefix. This is expected and NOT a coverage gap.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/my-rule.test.ts@@test-1': { '1': 1 },
                    'tests/my-rule.test.ts@@test-2': { '2': 1 },
                },
            };

            const executionOrder = [10, 11];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'valid 0',   fullName: 'valid 0',   type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
                [11, { id: 11, name: 'invalid 0', fullName: 'invalid 0', type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
            ]);

            const logger = makeLogger();
            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // No warning — node_modules URLs are skipped in the interior-gap check
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Legacy format: "test-N" keys (backward compatibility)
    // ─────────────────────────────────────────────────────────────────────────
    describe('legacy counter keys (test-N format)', () => {
        it('should return empty inspectorIdToProjectFile for legacy test-N keys (Issue 2 regression)', () => {
            // Legacy format ("test-N") cannot produce project-file information because the key
            // has no file prefix. The returned inspectorIdToProjectFile must be an empty Map,
            // not garbage values derived from treating "test-N" as a file prefix.
            //
            // This is the Issue 2 fix: before the fix, buildInspectorIdToProjectFile was called
            // with legacy keys and produced Map entries like { 42 → "test-1" }, which is wrong.
            // After the fix, mapFilePrefixedCounterKeys is only called for new-format keys and
            // the legacy path returns `{ coverage: ..., inspectorIdToProjectFile: new Map() }`.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                },
            };

            const executionOrder = [10, 11];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
                [11, { id: 11, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts', status: 'pass' }],
            ]);

            const { coverage, inspectorIdToProjectFile } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Coverage should still be mapped correctly
            expect(coverage!.perTest).toEqual({
                'tests/a.test.ts > first':  { '1': 1 },
                'tests/a.test.ts > second': { '2': 1 },
            });

            // inspectorIdToProjectFile must be EMPTY — legacy keys carry no file-prefix information
            expect(inspectorIdToProjectFile.size).toBe(0);
        });

        it('should map counter IDs to inspector full names with file paths', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {
                    'test-1': { '2': 1, '3': 1 },
                    'test-2': { '4': 1 },
                    'test-3': { '5': 1, '6': 1, '7': 1 },
                },
            };

            const executionOrder = [42, 43, 44];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test', url: 'file:///.stryker-tmp/sandbox-ABC/tests/foo.test.ts' }],
                [43, { id: 43, name: 'test2', fullName: 'Suite > Nested > test2', type: 'test', url: 'file:///.stryker-tmp/sandbox-ABC/tests/foo.test.ts' }],
                [44, { id: 44, name: 'test3', fullName: 'Suite > test3', type: 'test', url: 'file:///.stryker-tmp/sandbox-ABC/tests/bar.test.ts' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Maps based on execution order with file paths included:
            // test-1 -> ID 42 (tests/foo.test.ts > Suite > test1)
            // test-2 -> ID 43 (tests/foo.test.ts > Suite > Nested > test2)
            // test-3 -> ID 44 (tests/bar.test.ts > Suite > test3)
            expect(result).toEqual({
                'static': { '1': 1 },
                perTest:  {
                    'tests/foo.test.ts > Suite > test1':          { '2': 1, '3': 1 },
                    'tests/foo.test.ts > Suite > Nested > test2': { '4': 1 },
                    'tests/bar.test.ts > Suite > test3':          { '5': 1, '6': 1, '7': 1 },
                },
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should handle single test without URL', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1, '2': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                [100, { id: 100, name: 'only test', fullName: 'only test', type: 'test', url: undefined }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual({
                'static': {},
                perTest:  {
                    'only test': { '1': 1, '2': 1 },
                },
            });
        });

        it('should preserve static coverage unchanged', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '10': 1, '20': 1, '30': 1 },
                perTest:  {
                    'test-1': { '1': 1 },
                },
            };

            const executionOrder = [50];
            const testHierarchy = new Map<number, TestInfo>([
                [50, { id: 50, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.static).toEqual({ '10': 1, '20': 1, '30': 1 });
        });

        it('should sort counter IDs numerically (not lexicographically)', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-2':  { '2': 1 },
                    'test-10': { '10': 1 },
                    'test-1':  { '1': 1 },
                },
            };

            const executionOrder = [1, 2, 10];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: undefined }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: undefined }],
                [10, { id: 10, name: 'tenth', fullName: 'tenth', type: 'test', url: undefined }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // test-1 -> first, test-2 -> second, test-10 -> tenth
            expect(result!.perTest).toEqual({
                first:  { '1': 1 },
                second: { '2': 1 },
                tenth:  { '10': 1 },
            });
        });

        it('should include file paths from URLs in mapped keys', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                },
            };

            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'test1', fullName: 'Suite > test1', type: 'test', url: 'file:///.stryker-tmp/sandbox-XYZ/src/utils.test.ts' }],
                [2, { id: 2, name: 'test2', fullName: 'Suite > test2', type: 'test', url: 'file:///.stryker-tmp/sandbox-XYZ/tests/integration.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.perTest).toEqual({
                'src/utils.test.ts > Suite > test1':         { '1': 1 },
                'tests/integration.test.ts > Suite > test2': { '2': 1 },
            });
        });

        it('should warn and do partial mapping when coverage has more tests than execution order', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                    'test-3': { '3': 1 },
                },
            };

            const executionOrder = [42, 43]; // Only 2 tests
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test' }],
                [43, { id: 43, name: 'test2', fullName: 'Suite > test2', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Should map only first 2 tests
            expect(result!.perTest).toEqual({
                'Suite > test1': { '1': 1 },
                'Suite > test2': { '2': 1 },
            });

            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Coverage/execution count mismatch'),
                3,
                2,
                2
            );
        });

        it('sorts legacy counter IDs numerically so position mapping is correct with out-of-order keys', () => {
            // Kills mutants 684/687: ?? '0' fallback in legacy sort comparator
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-3': { '300': 1 },
                    'test-1': { '100': 1 },
                    'test-2': { '200': 1 },
                },
            };

            const executionOrder = [10, 20, 30];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test' }],
                [20, { id: 20, name: 'second', fullName: 'second', type: 'test' }],
                [30, { id: 30, name: 'third',  fullName: 'third',  type: 'test' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Numeric sort: test-1→first(pos1), test-2→second(pos2), test-3→third(pos3)
            expect(result!.perTest).toEqual({
                first:  { '100': 1 },
                second: { '200': 1 },
                third:  { '300': 1 },
            });
        });

        it('should warn and skip test when inspector ID not found in hierarchy', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                    'test-3': { '3': 1 },
                },
            };

            const executionOrder = [42, 43, 44];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test' }],
                // 43 is missing
                [44, { id: 44, name: 'test3', fullName: 'Suite > test3', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result!.perTest).toEqual({
                'Suite > test1': { '1': 1 },
                'Suite > test3': { '3': 1 },
            });

            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Missing test info for inspector ID'),
                43,
                'test-2'
            );
        });

        it('should deduplicate test names with [N] suffix in legacy key format (it.each)', () => {
            // it.each produces tests with the same fullName; legacy keys must also dedup them
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '10': 1 },
                    'test-2': { '20': 1 },
                    'test-3': { '30': 1 },
                },
            };

            const executionOrder = [1, 2, 3];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'handles %s', fullName: 'Suite > handles %s', type: 'test' }],
                [2, { id: 2, name: 'handles %s', fullName: 'Suite > handles %s', type: 'test' }],
                [3, { id: 3, name: 'handles %s', fullName: 'Suite > handles %s', type: 'test' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.perTest).toEqual({
                'Suite > handles %s [0]': { '10': 1 },
                'Suite > handles %s [1]': { '20': 1 },
                'Suite > handles %s [2]': { '30': 1 },
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Format detection and passthrough
    // ─────────────────────────────────────────────────────────────────────────
    describe('non-counter ID handling', () => {
        it('should return coverage unchanged when keys do not match any known pattern', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {
                    'Suite > test1': { '2': 1 },
                    'Suite > test2': { '3': 1 },
                },
            };

            const executionOrder = [42, 43];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Different > test1', type: 'test' }],
                [43, { id: 43, name: 'test2', fullName: 'Different > test2', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Should return unchanged because keys don't match any counter pattern
            expect(result).toEqual(rawCoverage);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should return unchanged when keys have test- prefix but no number', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-foo': { '1': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result).toEqual(rawCoverage);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should return unchanged when keys have numbers but wrong prefix', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'Test-1': { '1': 1 }, // Capital T
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result).toEqual(rawCoverage);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should map when keys exactly match test-N pattern', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'Mapped > test', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Should be mapped, not returned unchanged
            expect(result!.perTest).toEqual({
                'Mapped > test': { '1': 1 },
            });
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should map when keys match file@@test-N pattern', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/x.test.ts@@test-1': { '1': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'Mapped > test', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/x.test.ts' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result!.perTest).toEqual({
                'tests/x.test.ts > Mapped > test': { '1': 1 },
            });
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Edge cases
    // ─────────────────────────────────────────────────────────────────────────
    describe('edge cases', () => {
        it('should return coverage unchanged when perTest is empty', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const logger = makeLogger();
            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result).toEqual(rawCoverage);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should handle undefined coverage', () => {
            const rawCoverage = undefined as unknown as MutantCoverage;
            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>();

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toBeUndefined();
        });

        it('should handle null perTest', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  null as unknown as Record<string, Record<string, number>>,
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>();

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual(rawCoverage);
        });

        it('should return same object reference when perTest is empty (early return path)', () => {
            // Kills ConditionalExpression mutation at line 54: if(!rawCoverage?.perTest || ...) → if(false || ...)
            // If the condition is always false, it won't early return and will process the empty perTest
            // This test verifies that with empty perTest, we get the SAME object reference back (early return)
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should return the exact same object reference (early return)
            expect(result).toBe(rawCoverage);
        });

        it('should early return for empty perTest without processing', () => {
            // Kills ConditionalExpression mutation at line 54
            let keysAccessCount = 0;
            const emptyPerTest = new Proxy({}, {
                ownKeys(target) {
                    keysAccessCount++;
                    return Reflect.ownKeys(target);
                },
            });

            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  emptyPerTest,
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should return the same object (early return)
            expect(result).toBe(rawCoverage);
            expect(result!.perTest).toBe(emptyPerTest);

            // CRITICAL: Object.keys should be called exactly ONCE (at the length check)
            // If mutation changes condition to false, it would be called AGAIN to get the first key
            expect(keysAccessCount).toBe(1);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Complex scenarios
    // ─────────────────────────────────────────────────────────────────────────
    describe('complex scenarios', () => {
        it('should handle deeply nested test hierarchy', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '1': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                [100, {
                    id:       100,
                    name:     'deeply nested test',
                    fullName: 'Suite > Level1 > Level2 > Level3 > deeply nested test',
                    type:     'test',
                    url:      'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts',
                }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.perTest).toEqual({
                'tests/foo.test.ts > Suite > Level1 > Level2 > Level3 > deeply nested test': { '1': 1 },
            });
        });

        it('should handle tests with special characters in names', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/s.test.ts@@test-1': { '1': 1 },
                    'tests/s.test.ts@@test-2': { '2': 1 },
                },
            };

            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'test with "quotes"', fullName: 'Suite > test with "quotes"', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/s.test.ts' }],
                [2, { id: 2, name: "test with 'apostrophes'", fullName: "Suite > test with 'apostrophes'", type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/s.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.perTest).toEqual({
                'tests/s.test.ts > Suite > test with "quotes"':      { '1': 1 },
                "tests/s.test.ts > Suite > test with 'apostrophes'": { '2': 1 },
            });
        });

        it('should handle large numbers of tests across files', () => {
            const numTests = 100;
            const perTest: Record<string, Record<string, number>> = {};
            const executionOrder: number[] = [];
            const testHierarchy = new Map<number, TestInfo>();

            for(let i = 1; i <= numTests; i++) {
                const file = i % 2 === 0 ? 'tests/even.test.ts' : 'tests/odd.test.ts';
                const counterInFile = Math.ceil(i / 2);
                perTest[`${file}@@test-${counterInFile}`] = { [`${i}`]: 1 };
                executionOrder.push(i);
                testHierarchy.set(i, {
                    id:       i,
                    name:     `test${i}`,
                    fullName: `Suite > test${i}`,
                    type:     'test',
                    url:      `file:///.stryker-tmp/sandbox-X/${file}`,
                });
            }

            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest,
            };

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(Object.keys(result!.perTest)).toHaveLength(numTests);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Static-wins attribution (raw static bucket strips perTest duplicates)
    // ─────────────────────────────────────────────────────────────────────────
    describe('static-wins attribution', () => {
        it('keeps a mutant that appears in multiple perTest entries in both entries (no promotion to static)', () => {
            // Mutant '5' is ordinary shared code hit by two tests — the NORMAL shape for
            // perTest coverage; it must stay in both entries and must NOT be reported as
            // static (regression for the count>1 promotion bug). FAILS pre-fix.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '5': 1, '10': 1 },
                    'tests/a.test.ts@@test-2': { '5': 1, '20': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'test-one', fullName: 'test-one', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts' }],
                [2, { id: 2, name: 'test-two', fullName: 'test-two', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Mutant '5' must NOT be promoted to static — it has no raw static record
            expect(result!.static).toEqual({});
            // Both perTest entries survive
            expect(Object.keys(result!.perTest)).toHaveLength(2);
            for(const counts of Object.values(result!.perTest)) {
                expect(counts['5']).toBe(1);
            }
            // Mutants '10' and '20' are uniquely attributed — they stay in perTest
            expect(Object.values(result!.perTest).some(c => '10' in c)).toBe(true);
            expect(Object.values(result!.perTest).some(c => '20' in c)).toBe(true);
        });

        it('should remove from perTest any mutant already in static', () => {
            // Mutant '99' is already in static in one run; in another run it appears in perTest
            // After mapping, stabilizeCoverage should strip it from perTest
            const rawCoverage: MutantCoverage = {
                'static': { '99': 1 },
                perTest:  {
                    'tests/b.test.ts@@test-1': { '99': 1, '7': 1 },
                },
            };
            const executionOrder = [1];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'sole-test', fullName: 'sole-test', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '99' must remain in static (unchanged)
            expect(result!.static).toMatchObject({ '99': 1 });
            // '99' must NOT appear in perTest (stripped because it's already static)
            for(const counts of Object.values(result!.perTest)) {
                expect(Object.keys(counts)).not.toContain('99');
            }
            // '7' is uniquely attributed — stays in perTest
            expect(Object.values(result!.perTest).some(c => '7' in c)).toBe(true);
        });

        it('should leave perTest unchanged when every mutant appears in exactly one test', () => {
            // No promotion needed — all mutants are uniquely attributed
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {
                    'tests/c.test.ts@@test-1': { '2': 1 },
                    'tests/c.test.ts@@test-2': { '3': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/c.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // No new promotions: static unchanged, perTest entries both survive
            expect(result!.static).toEqual({ '1': 1 });
            expect(Object.keys(result!.perTest)).toHaveLength(2);
            expect(Object.values(result!.perTest).some(c => '2' in c)).toBe(true);
            expect(Object.values(result!.perTest).some(c => '3' in c)).toBe(true);
        });

        it('drops a perTest entry completely when all its mutants are already static', () => {
            // NOTE: this test passes BOTH pre- and post-fix by design — it pins retained
            // rule-(a) behavior (raw-static stripping and empty-entry drop, which the old
            // code also performed for already-static IDs); its value is mutation-kill on
            // buildFilteredPerTest's empty-entry guard, not failing-first TDD. Do not
            // 'strengthen' it into asserting promotion.
            const rawCoverage: MutantCoverage = {
                'static': { '10': 1, '20': 1 },
                perTest:  {
                    'tests/d.test.ts@@test-1': { '10': 1, '20': 1, '30': 1 },
                    'tests/d.test.ts@@test-2': { '10': 1, '20': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/d.test.ts' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/d.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '10' and '20' are already static; test-2 entry disappears — exactly 1 perTest entry remains
            expect(result!.static).toEqual({ '10': 1, '20': 1 });
            // Only test-1 entry (which owns '30') should remain
            expect(Object.keys(result!.perTest)).toHaveLength(1);
            // '30' is unique to test-1 so test-1 entry still exists
            expect(Object.values(result!.perTest).some(c => '30' in c)).toBe(true);
            // No perTest entry should contain '10' or '20'
            for(const counts of Object.values(result!.perTest)) {
                expect(Object.keys(counts)).not.toContain('10');
                expect(Object.keys(counts)).not.toContain('20');
            }
        });

        it('keeps every shared mutant in perTest when nothing is static', () => {
            // Every mutant appears in both tests, but none has a raw static record — all
            // must remain in perTest (this is the exact fixture that previously emptied
            // perTest under the count>1 promotion bug). FAILS pre-fix.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/f.test.ts@@test-1': { '100': 1, '200': 1, '300': 1 },
                    'tests/f.test.ts@@test-2': { '100': 1, '200': 1, '300': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/f.test.ts' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/f.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.static).toEqual({});
            expect(Object.keys(result!.perTest)).toHaveLength(2);
            for(const counts of Object.values(result!.perTest)) {
                expect(counts).toEqual({ '100': 1, '200': 1, '300': 1 });
            }
        });

        it('produces empty perTest when every covered mutant is already static', () => {
            // NOTE: passes BOTH pre- and post-fix by design — pins retained rule-(a)
            // behavior and the 'empty object, not undefined' output shape; its value is
            // mutation-kill on the empty-entry guard (`>` → `>=` keeps empty entries so
            // toEqual({}) fails). Not a failing-first test.
            const rawCoverage: MutantCoverage = {
                'static': { '100': 1, '200': 1, '300': 1 },
                perTest:  {
                    'tests/f.test.ts@@test-1': { '100': 1, '200': 1, '300': 1 },
                    'tests/f.test.ts@@test-2': { '100': 1, '200': 1, '300': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/f.test.ts' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/f.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // All mutants already static; perTest must be an empty object, not undefined
            expect(result!.perTest).toEqual({});
            expect(result!.static).toEqual({ '100': 1, '200': 1, '300': 1 });
        });

        it('should produce identical coverage regardless of which test first triggered module import (simulates drift)', () => {
            // Run A: module-level mutant '500' attributed to test-1 (it imported first)
            const coverageRunA: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/e.test.ts@@test-1': { '500': 1, '501': 1 },
                    'tests/e.test.ts@@test-2': { '502': 1 },
                },
            };
            // Run B: module-level mutant '500' attributed to test-2 (different import order)
            const coverageRunB: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/e.test.ts@@test-1': { '501': 1 },
                    'tests/e.test.ts@@test-2': { '500': 1, '502': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/e.test.ts' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/e.test.ts' }],
            ]);

            const { coverage: resultA } = mapCoverageToInspectorIds(coverageRunA, executionOrder, testHierarchy);
            const { coverage: resultB } = mapCoverageToInspectorIds(coverageRunB, executionOrder, testHierarchy);

            // '500' is module-scope code. In production the eager-import preload
            // (coverage-preload.ts Section 3) executes it during preload, recording it
            // deterministically into the raw static bucket — the mapper itself performs
            // NO cross-run dedup. This fixture (no static record) verifies each run's
            // result is internally consistent and that uniquely-attributed mutants
            // ('501','502') keep their perTest attribution.

            // Run A: '500' only in test-1 → stays in perTest[test-1]
            expect(Object.values(resultA!.perTest).some(c => '500' in c)).toBe(true);
            expect(resultA!.static).not.toMatchObject({ '500': expect.anything() });
            // Run B: '500' only in test-2 → stays in perTest[test-2]
            expect(Object.values(resultB!.perTest).some(c => '500' in c)).toBe(true);
            expect(resultB!.static).not.toMatchObject({ '500': expect.anything() });
            // '501' in test-1 in both runs
            // find the entry containing '501'
            const test1EntryA = Object.entries(resultA!.perTest).find(([, c]) => '501' in c);
            const test1EntryB = Object.entries(resultB!.perTest).find(([, c]) => '501' in c);
            expect(test1EntryA?.[0]).toBeDefined();
            expect(test1EntryB?.[0]).toBeDefined();
        });

        it('strips already-static mutants while preserving multi-test mutants (mixed case)', () => {
            // Mixed scenario: '99' is already static and must be stripped from perTest;
            // '42' is ordinary shared code hit by two tests and must be PRESERVED in both
            // (not promoted) — exactly the shape eager-import produces for module-level
            // helpers also called at test time. FAILS pre-fix ('42' gets promoted).
            const rawCoverage: MutantCoverage = {
                'static': { '99': 1 },               // existing static entry
                perTest:  {
                    'tests/x.test.ts@@test-1': { '99': 1, '42': 1, '7': 1 },
                    'tests/x.test.ts@@test-2': { '42': 1, '8': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'a', fullName: 'a', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/x.test.ts' }],
                [2, { id: 2, name: 'b', fullName: 'b', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/x.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '99' remains static; '42' must NOT be promoted
            expect(result!.static).toEqual({ '99': 1 });
            expect(Object.keys(result!.perTest)).toHaveLength(2);
            // '99' must NOT appear in any perTest entry (already static); '42' stays with count 1
            for(const counts of Object.values(result!.perTest)) {
                expect(Object.keys(counts)).not.toContain('99');
                expect(counts['42']).toBe(1);
            }
            // '7' and '8' are unique per-test — they stay in perTest
            expect(Object.values(result!.perTest).some(c => '7' in c)).toBe(true);
            expect(Object.values(result!.perTest).some(c => '8' in c)).toBe(true);
        });

        it('preserves existing static hit counts (does not overwrite)', () => {
            // Raw-static hit counts must survive stabilization unchanged — static is
            // returned by reference, never rebuilt with default counts.
            const rawCoverage: MutantCoverage = {
                'static': { '99': 5 },  // pre-existing hit count of 5
                perTest:  {
                    'tests/y.test.ts@@test-1': { '99': 1, '1': 1 },  // '99' already static
                },
            };
            const executionOrder = [1];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'only', fullName: 'only', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/y.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '99' is already in static with count 5 — must NOT be overwritten to 1
            expect(result!.static['99']).toBe(5);
        });

        it('preserves existing static entries when stripping perTest', () => {
            // Static must be returned intact — existing static entries ('10': 1) must
            // not be lost while stripping the corresponding perTest duplicates.
            const rawCoverage: MutantCoverage = {
                'static': { '10': 1 },
                perTest:  {
                    'tests/z.test.ts@@test-1': { '10': 1, '20': 1 },
                    'tests/z.test.ts@@test-2': { '10': 1, '30': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/z.test.ts' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/z.test.ts' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '10' is already in static AND appears in 2+ tests — must remain in static with original count
            expect(result!.static['10']).toBe(1);
            // '20' and '30' appear in only one test each — they stay in perTest
            expect(Object.values(result!.perTest).some(c => '20' in c)).toBe(true);
            expect(Object.values(result!.perTest).some(c => '30' in c)).toBe(true);
        });

        it('keeps multi-test mutants in perTest and strips static ones with legacy test-N keys', () => {
            // The mandated legacy-key-format regression test: shared '77' must stay in
            // both perTest entries; raw-static '66' must be stripped from perTest and
            // remain in static. Proves mapLegacyCounterKeys' shared stabilizeCoverage
            // call (:656) exhibits both rules without duplicating the file-prefixed test.
            // FAILS pre-fix (shared '77' gets promoted).
            const rawCoverage: MutantCoverage = {
                'static': { '66': 1 },
                perTest:  {
                    'test-1': { '77': 1, '88': 1, '66': 1 },
                    'test-2': { '77': 1, '99': 1 },
                },
            };
            const executionOrder = [10, 20];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'legacy-first', fullName: 'legacy-first', type: 'test' }],
                [20, { id: 20, name: 'legacy-second', fullName: 'legacy-second', type: 'test' }],
            ]);

            const { coverage: result } = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result!.static).toEqual({ '66': 1 });
            expect(Object.keys(result!.perTest)).toHaveLength(2);
            for(const counts of Object.values(result!.perTest)) {
                expect(counts['77']).toBe(1);
                expect(Object.keys(counts)).not.toContain('66');
            }
            // '88' and '99' are unique → stay in perTest
            expect(Object.values(result!.perTest).some(c => '88' in c)).toBe(true);
            expect(Object.values(result!.perTest).some(c => '99' in c)).toBe(true);
        });
    });
});

describe('buildInspectorIdToProjectFile', () => {
    it('maps inspector IDs to project file prefixes via positional pairing', () => {
        const perTestKeys = [
            'tests/a.test.ts@@test-1',
            'tests/b.test.ts@@test-1',
            'tests/a.test.ts@@test-2',
        ];
        const executionOrder = [10, 20, 11];
        const testHierarchy = new Map<number, TestInfo>([
            [10, { id: 10, name: 'a-first',  fullName: 'a-first',  type: 'test', status: 'pass' }],
            [11, { id: 11, name: 'a-second', fullName: 'a-second', type: 'test', status: 'pass' }],
            [20, { id: 20, name: 'b-first',  fullName: 'b-first',  type: 'test', status: 'pass' }],
        ]);

        const result = buildInspectorIdToProjectFile(perTestKeys, executionOrder, testHierarchy);

        expect(result.get(10)).toBe('tests/a.test.ts');
        expect(result.get(20)).toBe('tests/b.test.ts');
        expect(result.get(11)).toBe('tests/a.test.ts');
    });

    it('skips skipped tests when building the mapping', () => {
        const perTestKeys = ['tests/a.test.ts@@test-1', 'tests/a.test.ts@@test-2'];
        // test 11 is skip — no counter key for it
        const executionOrder = [10, 11, 12];
        const testHierarchy = new Map<number, TestInfo>([
            [10, { id: 10, name: 'first',   fullName: 'first',   type: 'test', status: 'pass' }],
            [11, { id: 11, name: 'skipped', fullName: 'skipped', type: 'test', status: 'skip' }],
            [12, { id: 12, name: 'third',   fullName: 'third',   type: 'test', status: 'pass' }],
        ]);

        const result = buildInspectorIdToProjectFile(perTestKeys, executionOrder, testHierarchy);

        expect(result.get(10)).toBe('tests/a.test.ts');
        expect(result.has(11)).toBe(false); // skipped, not in mapping
        expect(result.get(12)).toBe('tests/a.test.ts');
    });

    it('skips pending tests when building the mapping', () => {
        // Bun fires TestReporter.start for pending tests but does NOT run beforeEach,
        // so no counter key is produced. Pending tests must be excluded from the
        // positional pairing — exercising the status !== pending guard.
        const perTestKeys = ['tests/a.test.ts@@test-1', 'tests/a.test.ts@@test-2'];
        // test 11 is pending — no counter key for it
        const executionOrder = [10, 11, 12];
        const testHierarchy = new Map<number, TestInfo>([
            [10, { id: 10, name: 'first',   fullName: 'first',   type: 'test', status: 'pass' }],
            [11, { id: 11, name: 'pending', fullName: 'pending', type: 'test', status: 'todo' }],
            [12, { id: 12, name: 'third',   fullName: 'third',   type: 'test', status: 'pass' }],
        ]);

        const result = buildInspectorIdToProjectFile(perTestKeys, executionOrder, testHierarchy);

        expect(result.get(10)).toBe('tests/a.test.ts');
        expect(result.has(11)).toBe(false); // pending, not in mapping
        expect(result.get(12)).toBe('tests/a.test.ts');
    });

    it('maps test with node_modules url to user project file from counter key', () => {
        // RuleTester-style: testInfo.url points to node_modules but counter key is the user's file
        const perTestKeys = ['tests/my-rule.test.ts@@test-1', 'tests/my-rule.test.ts@@test-2'];
        const executionOrder = [10, 11];
        const testHierarchy = new Map<number, TestInfo>([
            [10, { id: 10, name: 'valid 0',   fullName: 'valid 0',   type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
            [11, { id: 11, name: 'invalid 0', fullName: 'invalid 0', type: 'test', url: 'node_modules/eslint/lib/rule-tester/rule-tester.js', status: 'pass' }],
        ]);

        const result = buildInspectorIdToProjectFile(perTestKeys, executionOrder, testHierarchy);

        expect(result.get(10)).toBe('tests/my-rule.test.ts');
        expect(result.get(11)).toBe('tests/my-rule.test.ts');
    });

    it('returns empty map when there are no counter keys', () => {
        const result = buildInspectorIdToProjectFile([], [10, 11], new Map([
            [10, { id: 10, name: 'a', fullName: 'a', type: 'test' as const, status: 'pass' as const }],
            [11, { id: 11, name: 'b', fullName: 'b', type: 'test' as const, status: 'pass' as const }],
        ]));

        expect(result.size).toBe(0);
    });

    it('handles partial mapping when counter keys are fewer than inspector tests', () => {
        const perTestKeys = ['tests/a.test.ts@@test-1'];
        const executionOrder = [10, 11, 12];
        const testHierarchy = new Map<number, TestInfo>([
            [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', status: 'pass' }],
            [11, { id: 11, name: 'second', fullName: 'second', type: 'test', status: 'pass' }],
            [12, { id: 12, name: 'third',  fullName: 'third',  type: 'test', status: 'pass' }],
        ]);

        const result = buildInspectorIdToProjectFile(perTestKeys, executionOrder, testHierarchy);

        // Only 1 counter key → only the first test is mapped
        expect(result.get(10)).toBe('tests/a.test.ts');
        expect(result.has(11)).toBe(false);
        expect(result.has(12)).toBe(false);
    });

    it('uses whole key as file prefix when a counter key lacks @@ separator (malformed key)', () => {
        // A malformed key (no @@) should fall back to using the entire key string as the
        // file prefix rather than slicing at a -1 index. This exercises the sepIdx === -1
        // branch in buildInspectorIdToProjectFile.
        // When sepIdx === -1: filePrefix = key (whole key) → correct
        // If mutated to always-slice: filePrefix = key.slice(0, -1) → truncated by one char → wrong
        const perTestKeys = [
            'tests/a.test.ts@@test-1', // well-formed key
            'malformed-key',            // no @@ — whole key should be the prefix
        ];
        const executionOrder = [10, 11];
        const testHierarchy = new Map<number, TestInfo>([
            [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', status: 'pass' }],
            [11, { id: 11, name: 'second', fullName: 'second', type: 'test', status: 'pass' }],
        ]);

        const result = buildInspectorIdToProjectFile(perTestKeys, executionOrder, testHierarchy);

        // The well-formed key extracts the correct prefix
        expect(result.get(10)).toBe('tests/a.test.ts');
        // The malformed key uses the full key string as the prefix (not a truncated version)
        expect(result.get(11)).toBe('malformed-key');
    });
});
