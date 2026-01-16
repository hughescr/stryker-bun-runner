/**
 * Unit tests for coverage/coverage-mapper
 * Tests mapping of counter-based coverage IDs to inspector test IDs
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mapCoverageToInspectorIds } from '../../src/coverage/coverage-mapper.js';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { TestInfo } from '../../src/inspector/types.js';

describe('mapCoverageToInspectorIds', () => {
    let consoleWarnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
    // Spy on console.warn to verify warnings
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock to suppress test output
        consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- mock function access
        consoleWarnSpy.mockRestore();
    });

    describe('successful mapping', () => {
        it('should map counter IDs to inspector full names', () => {
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
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test' }],
                [43, { id: 43, name: 'test2', fullName: 'Suite > Nested > test2', type: 'test' }],
                [44, { id: 44, name: 'test3', fullName: 'Suite > test3', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Maps based on execution order:
            // test-1 -> ID 42 (Suite > test1), test-2 -> ID 43 (Suite > Nested > test2), test-3 -> ID 44 (Suite > test3)
            expect(result).toEqual({
                'static': { '1': 1 },
                perTest:  {
                    'Suite > test1':          { '2': 1, '3': 1 },
                    'Suite > Nested > test2': { '4': 1 },
                    'Suite > test3':          { '5': 1, '6': 1, '7': 1 },
                },
            });

            expect(consoleWarnSpy).not.toHaveBeenCalled();
        });

        it('should handle single test', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1, '2': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                [100, { id: 100, name: 'only test', fullName: 'only test', type: 'test' }],
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
                [1, { id: 1, name: 'first', fullName: 'first', type: 'test' }],
                [2, { id: 2, name: 'second', fullName: 'second', type: 'test' }],
                [10, { id: 10, name: 'tenth', fullName: 'tenth', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // test-1 -> first, test-2 -> second, test-10 -> tenth
            expect(result.perTest).toEqual({
                first:  { '1': 1 },
                second: { '2': 1 },
                tenth:  { '10': 1 },
            });
        });
    });

    describe('non-counter ID handling', () => {
        it('should return coverage unchanged when keys do not match test-N pattern', () => {
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should return unchanged because keys don't match test-N pattern
            expect(result).toEqual(rawCoverage);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual(rawCoverage);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual(rawCoverage);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
        });

        it('should return unchanged when keys have test-N pattern but extra characters', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1-extra': { '1': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual(rawCoverage);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
        });

        it('should return unchanged when keys start with test-N but have suffix', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1suffix': { '1': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual(rawCoverage);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should be mapped, not returned unchanged
            expect(result.perTest).toEqual({
                'Mapped > test': { '1': 1 },
            });
            expect(consoleWarnSpy).not.toHaveBeenCalled();
        });
    });

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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result).toEqual(rawCoverage);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
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
    });

    describe('count mismatch handling', () => {
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should map only first 2 tests
            expect(result.perTest).toEqual({
                'Suite > test1': { '1': 1 },
                'Suite > test2': { '2': 1 },
            });

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Coverage/execution count mismatch: 3 coverage entries vs 2 executed tests')
            );
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Performing partial mapping for 2 tests')
            );
        });

        it('should warn and do partial mapping when execution order has more tests than coverage', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                },
            };

            const executionOrder = [42, 43, 44]; // 3 tests
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test' }],
                [43, { id: 43, name: 'test2', fullName: 'Suite > test2', type: 'test' }],
                [44, { id: 44, name: 'test3', fullName: 'Suite > test3', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should map only the 1 test in coverage
            expect(result.perTest).toEqual({
                'Suite > test1': { '1': 1 },
            });

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Coverage/execution count mismatch: 1 coverage entries vs 3 executed tests')
            );
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Performing partial mapping for 1 tests')
            );
        });

        it('should include both counts in warning message', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                    'test-3': { '3': 1 },
                    'test-4': { '4': 1 },
                    'test-5': { '5': 1 },
                },
            };

            const executionOrder = [42, 43]; // Only 2 tests
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test' }],
                [43, { id: 43, name: 'test2', fullName: 'Suite > test2', type: 'test' }],
            ]);

            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Verify exact count values are in the warning message
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringMatching(/5 coverage entries vs 2 executed tests/)
            );
        });
    });

    describe('missing test info handling', () => {
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

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Maps based on execution order:
            // test-1 -> ID 42 (Suite > test1), test-2 -> ID 43 (missing, skipped), test-3 -> ID 44 (Suite > test3)
            expect(result.perTest).toEqual({
                'Suite > test1': { '1': 1 },
                'Suite > test3': { '3': 1 },
            });

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Missing test info for inspector ID 43 (counter ID: test-2)')
            );
        });

        it('should handle all tests missing from hierarchy', () => {
            const rawCoverage: MutantCoverage = {
                'static': { '99': 1 },
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                },
            };

            const executionOrder = [42, 43];
            const testHierarchy = new Map<number, TestInfo>(); // Empty hierarchy

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should have empty perTest but preserve static
            expect(result).toEqual({
                'static': { '99': 1 },
                perTest:  {},
            });

            expect(consoleWarnSpy).toHaveBeenCalledTimes(2); // One warning per missing test
        });
    });

    describe('early return for empty coverage', () => {
        it('should return coverage unchanged when perTest has entries but first key is non-counter', () => {
            // Kills mutation 313: if(!rawCoverage?.perTest || ...) → if(false || ...)
            // This ensures we actually check if perTest exists and has content
            const rawCoverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {
                    'already-mapped-test': { '2': 1 },
                },
            };

            const executionOrder = [42];
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test', fullName: 'test', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should return unchanged because first key doesn't match test-N pattern
            expect(result).toEqual(rawCoverage);
        });

        it('should handle coverage with non-empty perTest that needs checking', () => {
            // This test verifies that the truthiness check for rawCoverage?.perTest works correctly
            // If mutated to always false, this would break
            const rawCoverage: MutantCoverage = {
                'static': { '99': 1 },
                perTest:  {
                    'test-1': { '1': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                [100, { id: 100, name: 'mytest', fullName: 'Suite > mytest', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should map successfully
            expect(result.perTest['Suite > mytest']).toEqual({ '1': 1 });
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
            // If mutated to false and processing continues, a new object would be created
            expect(result).toBe(rawCoverage);
        });

        it('should early return for empty perTest without processing', () => {
            // Kills ConditionalExpression mutation at line 54:
            // if(!rawCoverage?.perTest || Object.keys(rawCoverage.perTest).length === 0) → if(false)
            //
            // Strategy: Use a property that would cause an error if accessed after the length check.
            // With proper early return, we check length and return immediately.
            // With mutation (false), code continues to line 60 and tries to access the first key,
            // but our custom object will track this access.
            let keysAccessCount = 0;
            const emptyPerTest = new Proxy({} as Record<string, Record<string, number>>, {
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

            // CRITICAL: Object.keys should be called exactly ONCE (at line 54 for length check)
            // If mutation changes condition to false, it would be called AGAIN at line 60
            // to get the first key, resulting in 2 calls
            expect(keysAccessCount).toBe(1);
        });
    });

    describe('Math.min usage verification', () => {
        it('should use Math.min not Math.max when reporting partial mapping count', () => {
            // Kills mutation on line 83: Math.min(...) → Math.max(...)
            // When coverage has 5 entries but execution has 2, we map min(5,2) = 2 tests
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                    'test-3': { '3': 1 },
                    'test-4': { '4': 1 },
                    'test-5': { '5': 1 },
                },
            };

            const executionOrder = [42, 43]; // Only 2 tests
            const testHierarchy = new Map<number, TestInfo>([
                [42, { id: 42, name: 'test1', fullName: 'test1', type: 'test' }],
                [43, { id: 43, name: 'test2', fullName: 'test2', type: 'test' }],
            ]);

            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Verify warning mentions the SMALLER number (Math.min result)
            // If Math.max was used, it would incorrectly say "5 tests" instead of "2 tests"
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Performing partial mapping for 2 tests')
            );
        });

        it('should use Math.min when execution order is longer than coverage', () => {
            // Another case: execution has 10 tests, coverage has 3
            // Should map min(3,10) = 3 tests
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                    'test-3': { '3': 1 },
                },
            };

            const executionOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 10 tests
            const testHierarchy = new Map<number, TestInfo>();
            for(let i = 1; i <= 10; i++) {
                testHierarchy.set(i, {
                    id:       i,
                    name:     `test${i}`,
                    fullName: `test${i}`,
                    type:     'test',
                });
            }

            mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Should report mapping 3 tests (the minimum), not 10
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Performing partial mapping for 3 tests')
            );
        });

        it('should only map tests up to the shorter array length (Math.min behavior)', () => {
            // Kills mutation on line 83: Math.min(...) → Math.max(...)
            // With Math.max, would try to iterate beyond the shorter array and get undefined values
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                    'test-3': { '3': 1 },
                    'test-4': { '4': 1 },
                    'test-5': { '5': 1 },
                },
            };

            // Only 2 execution entries - shorter than coverage
            const executionOrder = [100, 101];
            const testHierarchy = new Map<number, TestInfo>([
                [100, { id: 100, name: 'first', fullName: 'mapped-first', type: 'test' }],
                [101, { id: 101, name: 'second', fullName: 'mapped-second', type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // With Math.min: only first 2 tests mapped
            // With Math.max: would try to access executionOrder[2-4] (undefined) causing missing test info warnings
            expect(Object.keys(result.perTest)).toHaveLength(2);
            expect(result.perTest).toEqual({
                'mapped-first':  { '1': 1 },
                'mapped-second': { '2': 1 },
            });

            // Should only have 1 warning about count mismatch, not 3 additional warnings about missing test info
            expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Coverage/execution count mismatch')
            );
        });
    });

    describe('complex scenarios', () => {
        it('should handle deeply nested test hierarchy', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                },
            };

            const executionOrder = [100];
            const testHierarchy = new Map<number, TestInfo>([
                [100, {
                    id:       100,
                    name:     'deeply nested test',
                    fullName: 'Suite > Level1 > Level2 > Level3 > deeply nested test',
                    type:     'test',
                }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(result.perTest).toEqual({
                'Suite > Level1 > Level2 > Level3 > deeply nested test': { '1': 1 },
            });
        });

        it('should handle tests with special characters in names', () => {
            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                },
            };

            const executionOrder = [1, 2];
            const testHierarchy = new Map<number, TestInfo>([
                [1, { id: 1, name: 'test with "quotes"', fullName: 'Suite > test with "quotes"', type: 'test' }],
                [2, { id: 2, name: "test with 'apostrophes'", fullName: "Suite > test with 'apostrophes'", type: 'test' }],
            ]);

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            // Maps based on execution order:
            // test-1 -> ID 1 (quotes), test-2 -> ID 2 (apostrophes)
            expect(result.perTest).toEqual({
                'Suite > test with "quotes"':      { '1': 1 },
                "Suite > test with 'apostrophes'": { '2': 1 },
            });
        });

        it('should handle large numbers of tests', () => {
            const numTests = 1000;
            const perTest: Record<string, Record<string, number>> = {};
            const executionOrder: number[] = [];
            const testHierarchy = new Map<number, TestInfo>();

            for(let i = 1; i <= numTests; i++) {
                perTest[`test-${i}`] = { [`${i}`]: 1 };
                executionOrder.push(i);
                testHierarchy.set(i, {
                    id:       i,
                    name:     `test${i}`,
                    fullName: `Suite > test${i}`,
                    type:     'test',
                });
            }

            const rawCoverage: MutantCoverage = {
                'static': {},
                perTest,
            };

            const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

            expect(Object.keys(result.perTest)).toHaveLength(numTests);
            // Maps based on execution order:
            // test-1 -> ID 1 (Suite > test1), test-1000 -> ID 1000 (Suite > test1000)
            expect(result.perTest['Suite > test1']).toEqual({ '1': 1 });
            expect(result.perTest['Suite > test1000']).toEqual({ '1000': 1 });
        });
    });
});
