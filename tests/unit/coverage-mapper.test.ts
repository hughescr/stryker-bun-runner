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
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('successful mapping', () => {
    it('should map counter IDs to inspector full names', () => {
      const rawCoverage: MutantCoverage = {
        static: { '1': 1 },
        perTest: {
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
        static: { '1': 1 },
        perTest: {
          'Suite > test1': { '2': 1, '3': 1 },
          'Suite > Nested > test2': { '4': 1 },
          'Suite > test3': { '5': 1, '6': 1, '7': 1 },
        },
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should handle single test', () => {
      const rawCoverage: MutantCoverage = {
        static: {},
        perTest: {
          'test-1': { '1': 1, '2': 1 },
        },
      };

      const executionOrder = [100];
      const testHierarchy = new Map<number, TestInfo>([
        [100, { id: 100, name: 'only test', fullName: 'only test', type: 'test' }],
      ]);

      const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

      expect(result).toEqual({
        static: {},
        perTest: {
          'only test': { '1': 1, '2': 1 },
        },
      });
    });

    it('should preserve static coverage unchanged', () => {
      const rawCoverage: MutantCoverage = {
        static: { '10': 1, '20': 1, '30': 1 },
        perTest: {
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
        static: {},
        perTest: {
          'test-2': { '2': 1 },
          'test-10': { '10': 1 },
          'test-1': { '1': 1 },
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
        'first': { '1': 1 },
        'second': { '2': 1 },
        'tenth': { '10': 1 },
      });
    });
  });

  describe('edge cases', () => {
    it('should return coverage unchanged when perTest is empty', () => {
      const rawCoverage: MutantCoverage = {
        static: { '1': 1 },
        perTest: {},
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
        static: {},
        perTest: null as unknown as Record<string, Record<string, number>>,
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
        static: {},
        perTest: {
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
    });

    it('should warn and do partial mapping when execution order has more tests than coverage', () => {
      const rawCoverage: MutantCoverage = {
        static: {},
        perTest: {
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
    });
  });

  describe('missing test info handling', () => {
    it('should warn and skip test when inspector ID not found in hierarchy', () => {
      const rawCoverage: MutantCoverage = {
        static: {},
        perTest: {
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
        static: { '99': 1 },
        perTest: {
          'test-1': { '1': 1 },
          'test-2': { '2': 1 },
        },
      };

      const executionOrder = [42, 43];
      const testHierarchy = new Map<number, TestInfo>(); // Empty hierarchy

      const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

      // Should have empty perTest but preserve static
      expect(result).toEqual({
        static: { '99': 1 },
        perTest: {},
      });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2); // One warning per missing test
    });
  });

  describe('complex scenarios', () => {
    it('should handle deeply nested test hierarchy', () => {
      const rawCoverage: MutantCoverage = {
        static: {},
        perTest: {
          'test-1': { '1': 1 },
        },
      };

      const executionOrder = [100];
      const testHierarchy = new Map<number, TestInfo>([
        [100, {
          id: 100,
          name: 'deeply nested test',
          fullName: 'Suite > Level1 > Level2 > Level3 > deeply nested test',
          type: 'test',
        }],
      ]);

      const result = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);

      expect(result.perTest).toEqual({
        'Suite > Level1 > Level2 > Level3 > deeply nested test': { '1': 1 },
      });
    });

    it('should handle tests with special characters in names', () => {
      const rawCoverage: MutantCoverage = {
        static: {},
        perTest: {
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
        'Suite > test with "quotes"': { '1': 1 },
        "Suite > test with 'apostrophes'": { '2': 1 },
      });
    });

    it('should handle large numbers of tests', () => {
      const numTests = 1000;
      const perTest: Record<string, Record<string, number>> = {};
      const executionOrder: number[] = [];
      const testHierarchy = new Map<number, TestInfo>();

      for (let i = 1; i <= numTests; i++) {
        perTest[`test-${i}`] = { [`${i}`]: 1 };
        executionOrder.push(i);
        testHierarchy.set(i, {
          id: i,
          name: `test${i}`,
          fullName: `Suite > test${i}`,
          type: 'test',
        });
      }

      const rawCoverage: MutantCoverage = {
        static: {},
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
