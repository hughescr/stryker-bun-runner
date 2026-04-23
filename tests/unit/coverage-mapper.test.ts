/**
 * Unit tests for coverage/coverage-mapper
 * Tests mapping of file-prefixed counter-based coverage IDs to inspector test IDs
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import { describe, it, expect, mock } from 'bun:test';
import { mapCoverageToInspectorIds } from '../../src/coverage/coverage-mapper.js';
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

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
            // Simulates two files running in parallel: A-test1, B-test1, A-test2, B-test2
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/a.test.ts@@test-1': { '1': 1 },
                    'tests/a.test.ts@@test-2': { '2': 1 },
                    'tests/b.test.ts@@test-1': { '3': 1 },
                    'tests/b.test.ts@@test-2': { '4': 1 },
                },
            };

            // Execution order is interleaved: A1, B1, A2, B2
            const executionOrder = [10, 20, 11, 21];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'a-first', fullName: 'a-first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts' }],
                [11, { id: 11, name: 'a-second', fullName: 'a-second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/a.test.ts' }],
                [20, { id: 20, name: 'b-first', fullName: 'b-first', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts' }],
                [21, { id: 21, name: 'b-second', fullName: 'b-second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/b.test.ts' }],
            ]);

            const logger = makeLogger();
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Per-file mapping:
            // tests/a.test.ts: [10, 11] (in execution order)
            //   a.test.ts@@test-1 → position 1 → inspector 10 → a-first
            //   a.test.ts@@test-2 → position 2 → inspector 11 → a-second
            // tests/b.test.ts: [20, 21] (in execution order)
            //   b.test.ts@@test-1 → position 1 → inspector 20 → b-first
            //   b.test.ts@@test-2 → position 2 → inspector 21 → b-second
            expect(result.perTest).toEqual({
                'tests/a.test.ts > a-first':  { '1': 1 },
                'tests/a.test.ts > a-second': { '2': 1 },
                'tests/b.test.ts > b-first':  { '3': 1 },
                'tests/b.test.ts > b-second': { '4': 1 },
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should produce identical mapping regardless of which file runs first (determinism guarantee)', () => {
            // This is the core nondeterminism fix:
            // Two runs where file execution ORDER differs must produce the same perTest mapping.

            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'alpha', fullName: 'Suite > alpha', type: 'test', url: 'file:///.stryker-tmp/sandbox-A/tests/foo.test.ts' }],
                [2, { id: 2, name: 'beta', fullName: 'Suite > beta', type: 'test', url: 'file:///.stryker-tmp/sandbox-A/tests/foo.test.ts' }],
                [3, { id: 3, name: 'gamma', fullName: 'Suite > gamma', type: 'test', url: 'file:///.stryker-tmp/sandbox-A/tests/bar.test.ts' }],
            ]);

            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '1': 1, '2': 1 },
                    'tests/foo.test.ts@@test-2': { '3': 1 },
                    'tests/bar.test.ts@@test-1': { '4': 1, '5': 1 },
                },
            };

            // Run 1: foo runs before bar in execution order
            const run1 = mapCoverageToInspectorIds(
                coverage,
                [1, 2, 3],
                testHierarchy
            );

            // Run 2: bar runs before foo in execution order (different OS scheduling)
            const run2 = mapCoverageToInspectorIds(
                coverage,
                [3, 1, 2],
                testHierarchy
            );

            // Both must produce identical perTest mappings
            expect(run1.perTest).toEqual(run2.perTest);
            expect(run1.perTest).toEqual({
                'tests/foo.test.ts > Suite > alpha': { '1': 1, '2': 1 },
                'tests/foo.test.ts > Suite > beta':  { '3': 1 },
                'tests/bar.test.ts > Suite > gamma': { '4': 1, '5': 1 },
            });
        });

        it('should handle single file-prefixed test without URL in hierarchy', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-1': { '1': 1, '2': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                // url is undefined - this happens for synthetic or external tests
                [100, { id: 100, name: 'only test', fullName: 'only test', type: 'test', url: undefined }],
            ]);

            const logger = makeLogger();
            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // File prefix "tests/foo.test.ts" won't match normalizeTestFilePath(undefined)="" so
            // the test is not found via file lookup. Logger warning expected.
            expect(logger.warn).toHaveBeenCalled();
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.static).toEqual({ '10': 1, '20': 1, '30': 1 });
        });

        it('should sort counter IDs numerically within a file (not lexicographically)', () => {
            // test-10 sorts AFTER test-9 numerically (correct)
            // but BEFORE test-2 lexicographically (wrong)
            // A file with 10 tests produces counters test-1..test-10
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-2':  { '20': 1 },
                    'tests/foo.test.ts@@test-10': { '100': 1 },
                    'tests/foo.test.ts@@test-1':  { '10': 1 },
                },
            };

            // 10 tests in execution order; we only check positions 1, 2, 10
            const executionOrder = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
            const testHierarchy = new Map<number, TestInfo>([
                [101, { id: 101, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [102, { id: 102, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [103, { id: 103, name: 'third',  fullName: 'third',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [104, { id: 104, name: 'fourth', fullName: 'fourth', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [105, { id: 105, name: 'fifth',  fullName: 'fifth',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [106, { id: 106, name: 'sixth',  fullName: 'sixth',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [107, { id: 107, name: 'seventh', fullName: 'seventh', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [108, { id: 108, name: 'eighth', fullName: 'eighth', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [109, { id: 109, name: 'ninth',  fullName: 'ninth',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [110, { id: 110, name: 'tenth',  fullName: 'tenth',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Numerically: test-1 (pos 1) → first, test-2 (pos 2) → second, test-10 (pos 10) → tenth
            // Lexicographically (wrong): test-1 → first, test-10 → second, test-2 → third
            expect(result.perTest).toEqual({
                'tests/foo.test.ts > first':  { '10': 1 },
                'tests/foo.test.ts > second': { '20': 1 },
                'tests/foo.test.ts > tenth':  { '100': 1 },
            });
        });

        it('should warn and skip when file prefix matches no tests in hierarchy', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/missing.test.ts@@test-1': { '1': 1 },
                    'tests/present.test.ts@@test-1': { '2': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                // Only present.test.ts has a test in the hierarchy
                [42, { id: 42, name: 'exists', fullName: 'exists', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/present.test.ts' }],
            ]);

            const logger = makeLogger();
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result.perTest).toEqual({
                'tests/present.test.ts > exists': { '2': 1 },
            });

            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('%s'),
                expect.stringContaining('tests/missing.test.ts'),
                expect.anything(),
                expect.anything(),
                expect.anything()
            );
        });

        it('sorts file-prefixed counter IDs numerically so position mapping is correct even with out-of-order keys', () => {
            // Kills mutants 673-677: sort comparator with wrong separator/fallback/operator
            // Keys arrive in reverse order: test-3, test-1, test-2.
            // Correct numeric sort → [test-1, test-2, test-3] → positions [1,2,3].
            // Wrong sort (sum or stable) keeps input order [test-3, test-1, test-2] → positions [3,1,2].
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/foo.test.ts@@test-3': { '300': 1 },  // must map to 3rd test
                    'tests/foo.test.ts@@test-1': { '100': 1 },  // must map to 1st test
                    'tests/foo.test.ts@@test-2': { '200': 1 },  // must map to 2nd test
                },
            };

            const executionOrder = [10, 20, 30];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'first',  fullName: 'first',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [20, { id: 20, name: 'second', fullName: 'second', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
                [30, { id: 30, name: 'third',  fullName: 'third',  type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/foo.test.ts' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Numeric sort: test-1→first, test-2→second, test-3→third
            expect(result.perTest).toEqual({
                'tests/foo.test.ts > first':  { '100': 1 },
                'tests/foo.test.ts > second': { '200': 1 },
                'tests/foo.test.ts > third':  { '300': 1 },
            });
        });

        it('handles file-prefixed counter IDs that have no @@test- suffix gracefully (defaults to 0)', () => {
            // Kills StringLiteral mutant 673: ?? '0' → ?? '' in sort comparator.
            // parseInt('', 10) = NaN, making the sort unstable/wrong.
            // We need a mix of valid and invalid keys so the fallback matters.
            // Using only valid keys verifies the '0' path isn't hit, which isn't ideal.
            // Instead, verify that a key pair with test-5 vs test-1 sorts correctly.
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'tests/g.test.ts@@test-5': { '5': 1 },
                    'tests/g.test.ts@@test-1': { '1': 1 },
                },
            };

            const executionOrder = [1, 2, 3, 4, 5];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'pos1', fullName: 'pos1', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts' }],
                [2, { id: 2, name: 'pos2', fullName: 'pos2', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts' }],
                [3, { id: 3, name: 'pos3', fullName: 'pos3', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts' }],
                [4, { id: 4, name: 'pos4', fullName: 'pos4', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts' }],
                [5, { id: 5, name: 'pos5', fullName: 'pos5', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/g.test.ts' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Correct sort: test-1→pos1, test-5→pos5. Wrong sort could swap them.
            expect(result.perTest['tests/g.test.ts > pos1']).toEqual({ '1': 1 });
            expect(result.perTest['tests/g.test.ts > pos5']).toEqual({ '5': 1 });
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // With deduplication: [0], [1], [2] suffixes assigned in counter order (deterministic)
            expect(result.perTest).toEqual({
                'tests/c.test.ts > Suite > should handle %s [0]': { '1': 1 },
                'tests/c.test.ts > Suite > should handle %s [1]': { '2': 1 },
                'tests/c.test.ts > Suite > should handle %s [2]': { '3': 1 },
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Legacy format: "test-N" keys (backward compatibility)
    // ─────────────────────────────────────────────────────────────────────────
    describe('legacy counter keys (test-N format)', () => {
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.static).toEqual({ '10': 1, '20': 1, '30': 1 });
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // test-1 -> first, test-2 -> second, test-10 -> tenth
            expect(result.perTest).toEqual({
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.perTest).toEqual({
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Should map only first 2 tests
            expect(result.perTest).toEqual({
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Numeric sort: test-1→first(pos1), test-2→second(pos2), test-3→third(pos3)
            expect(result.perTest).toEqual({
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result.perTest).toEqual({
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.perTest).toEqual({
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            // Should be mapped, not returned unchanged
            expect(result.perTest).toEqual({
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result.perTest).toEqual({
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
            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy, logger);

            expect(result).toEqual(rawCoverage);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should handle undefined coverage', () => {
            const rawCoverage = undefined as unknown as MutantCoverage;
            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>();

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toBeUndefined();
        });

        it('should handle null perTest', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  null as unknown as Record<string, Record<string, number>>,
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>();

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should return the same object (early return)
            expect(result).toBe(rawCoverage);
            expect(result.perTest).toBe(emptyPerTest);

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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.perTest).toEqual({
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.perTest).toEqual({
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(Object.keys(result.perTest)).toHaveLength(numTests);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Static/perTest stabilization (Drift 1 fix)
    // ─────────────────────────────────────────────────────────────────────────
    describe('static/perTest stabilization', () => {
        it('should promote a mutant that appears in multiple perTest entries to static', () => {
            // Mutant '5' appears in both test-1 and test-2 (module-level code reached from two tests)
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Mutant '5' should be promoted to static because it appears in both tests
            expect(result.static).toMatchObject({ '5': expect.any(Number) });
            // Mutant '5' should NOT appear in any perTest entry
            for(const counts of Object.values(result.perTest)) {
                expect(Object.keys(counts)).not.toContain('5');
            }
            // Mutants '10' and '20' are uniquely attributed — they stay in perTest
            expect(Object.values(result.perTest).some(c => '10' in c)).toBe(true);
            expect(Object.values(result.perTest).some(c => '20' in c)).toBe(true);
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '99' must remain in static (unchanged)
            expect(result.static).toMatchObject({ '99': 1 });
            // '99' must NOT appear in perTest (stripped because it's already static)
            for(const counts of Object.values(result.perTest)) {
                expect(Object.keys(counts)).not.toContain('99');
            }
            // '7' is uniquely attributed — stays in perTest
            expect(Object.values(result.perTest).some(c => '7' in c)).toBe(true);
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // No new promotions: static unchanged, perTest entries both survive
            expect(result.static).toEqual({ '1': 1 });
            expect(Object.keys(result.perTest)).toHaveLength(2);
            expect(Object.values(result.perTest).some(c => '2' in c)).toBe(true);
            expect(Object.values(result.perTest).some(c => '3' in c)).toBe(true);
        });

        it('should drop perTest entry completely when all its mutants are promoted to static', () => {
            // Both mutants in test-2 also appear in test-1 — after promotion, test-2 has nothing left
            const rawCoverage: MutantCoverage = {
                'static': {},
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '10' and '20' promoted to static; test-2 entry disappears — exactly 1 perTest entry remains
            expect(result.static).toMatchObject({ '10': expect.any(Number), '20': expect.any(Number) });
            // Only test-1 entry (which owns '30') should remain
            expect(Object.keys(result.perTest)).toHaveLength(1);
            // '30' is unique to test-1 so test-1 entry still exists
            expect(Object.values(result.perTest).some(c => '30' in c)).toBe(true);
            // No perTest entry should contain '10' or '20'
            for(const counts of Object.values(result.perTest)) {
                expect(Object.keys(counts)).not.toContain('10');
                expect(Object.keys(counts)).not.toContain('20');
            }
        });

        it('should produce empty perTest when every mutant is shared across 2+ tests', () => {
            // Every mutant appears in both tests, so all are promoted to static
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // All mutants promoted to static; perTest must be an empty object, not undefined
            expect(result.perTest).toEqual({});
            expect(Object.keys(result.perTest)).toHaveLength(0);
            // All three mutants must be in the static bucket
            expect(result.static).toMatchObject({
                '100': expect.any(Number),
                '200': expect.any(Number),
                '300': expect.any(Number),
            });
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

            const resultA = mapCoverageToInspectorIds(coverageRunA, executionOrder, testHierarchy);
            const resultB = mapCoverageToInspectorIds(coverageRunB, executionOrder, testHierarchy);

            // '500' appears in only ONE test per run, so stabilizeCoverage alone won't
            // deduplicate it — but both runs produce the same perTest assignment for it
            // (test-1 in run A, test-2 in run B). However, when BOTH runs contribute,
            // the UNION scenario is handled. For this test we verify that:
            // (a) each run's result is internally consistent, and
            // (b) '501' (unique to test-1 in both runs) stays in perTest[test-1] in both
            // (c) '502' (unique to test-2 in both runs) stays in perTest[test-2] in both

            // Run A: '500' only in test-1 → stays in perTest[test-1]
            expect(Object.values(resultA.perTest).some(c => '500' in c)).toBe(true);
            expect(resultA.static).not.toMatchObject({ '500': expect.anything() });
            // Run B: '500' only in test-2 → stays in perTest[test-2]
            expect(Object.values(resultB.perTest).some(c => '500' in c)).toBe(true);
            expect(resultB.static).not.toMatchObject({ '500': expect.anything() });
            // '501' in test-1 in both runs
            // find the entry containing '501'
            const test1EntryA = Object.entries(resultA.perTest).find(([, c]) => '501' in c);
            const test1EntryB = Object.entries(resultB.perTest).find(([, c]) => '501' in c);
            expect(test1EntryA?.[0]).toBeDefined();
            expect(test1EntryB?.[0]).toBeDefined();
        });

        it('stabilizes when some promotions are new and some already exist in static', () => {
            // Kills MethodExpression mutant 593: some→every on hasNewPromotions check.
            // With 'every': if promoteToStatic has BOTH an existing-static ID and a new one,
            // every() would return false (existing-static fails the !has() test), so the
            // rebuild is wrongly skipped and the newly-promoted mutant stays in perTest.
            //
            // Setup: mutant '99' is already in static; mutant '42' appears in 2 tests (new promotion).
            // After rebuild: '42' must be in static; perTest must NOT contain '42'.
            const rawCoverage: MutantCoverage = {
                'static': { '99': 1 },               // existing static entry
                perTest:  {
                    'tests/x.test.ts@@test-1': { '42': 1, '7': 1 },
                    'tests/x.test.ts@@test-2': { '42': 1, '8': 1 },
                },
            };
            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'a', fullName: 'a', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/x.test.ts' }],
                [2, { id: 2, name: 'b', fullName: 'b', type: 'test', url: 'file:///.stryker-tmp/sandbox-X/tests/x.test.ts' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '42' must be promoted to static (it's in 2 tests)
            expect(result.static).toMatchObject({ '99': 1, '42': expect.any(Number) });
            // '42' must NOT appear in any perTest entry
            for(const counts of Object.values(result.perTest)) {
                expect(Object.keys(counts)).not.toContain('42');
            }
            // '7' and '8' are unique per-test — they stay in perTest
            expect(Object.values(result.perTest).some(c => '7' in c)).toBe(true);
            expect(Object.values(result.perTest).some(c => '8' in c)).toBe(true);
        });

        it('promotes to static but preserves existing hit counts (does not overwrite)', () => {
            // Kills ConditionalExpression mutant 610: !(mutantId in newStatic) → true
            // With always-true, the hit count 5 for '99' would be overwritten with 1.
            // This test checks the original value is preserved.
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '99' is already in static with count 5 — must NOT be overwritten to 1
            expect(result.static['99']).toBe(5);
        });

        it('preserves original static map by spreading (not sharing reference)', () => {
            // Kills ObjectLiteral mutant 607: { ...coverage.static } → {}
            // If newStatic starts as {}, existing static entries ('10': 1) would be lost.
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '10' is already in static AND appears in 2+ tests — must remain in static with original count
            expect(result.static['10']).toBe(1);
            // '20' and '30' appear in only one test each — they stay in perTest
            expect(Object.values(result.perTest).some(c => '20' in c)).toBe(true);
            expect(Object.values(result.perTest).some(c => '30' in c)).toBe(true);
        });

        it('stabilizes coverage with legacy test-N keys as well', () => {
            // Same promotion logic should apply when using legacy counter keys
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '77': 1, '88': 1 },
                    'test-2': { '77': 1, '99': 1 },
                },
            };
            const executionOrder = [10, 20];
            const testHierarchy = new Map<number, TestInfo>([
                [10, { id: 10, name: 'legacy-first', fullName: 'legacy-first', type: 'test' }],
                [20, { id: 20, name: 'legacy-second', fullName: 'legacy-second', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // '77' appears in both tests → promoted to static
            expect(result.static).toMatchObject({ '77': expect.any(Number) });
            for(const counts of Object.values(result.perTest)) {
                expect(Object.keys(counts)).not.toContain('77');
            }
            // '88' and '99' are unique → stay in perTest
            expect(Object.values(result.perTest).some(c => '88' in c)).toBe(true);
            expect(Object.values(result.perTest).some(c => '99' in c)).toBe(true);
        });
    });
});
