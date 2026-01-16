/**
 * Unit tests for coverage/collector
 * Tests coverage data collection and conversion
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { collectCoverage, cleanupCoverageFile } from '../../src/coverage/collector.js';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('collectCoverage', () => {
    let mockReadFile: ReturnType<typeof mock>;
    let tempCoverageFile: string;

    beforeEach(() => {
        tempCoverageFile = join(tmpdir(), `test-coverage-${Date.now()}.json`);
        mockReadFile = mock();
        spyOn(fs, 'readFile').mockImplementation(mockReadFile);
        // Suppress expected console.warn messages from error handling tests
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock to suppress test output
        spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    describe('successful collection', () => {
        it('should convert array format to Record<string, number> format', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'test-1': ['1', '2', '3'],
                    'test-2': ['4', '5'],
                },
                'static': ['6', '7'],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({
                'test-1': { '1': 1, '2': 1, '3': 1 },
                'test-2': { '4': 1, '5': 1 },
            });
            expect(result?.static).toEqual({
                '6': 1,
                '7': 1,
            });
        });

        it('should handle empty coverage data', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest:  {},
                'static': [],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({});
            expect(result?.static).toEqual({});
        });

        it('should handle coverage with only perTest data', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'test-1': ['1', '2'],
                },
                'static': [],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({
                'test-1': { '1': 1, '2': 1 },
            });
            expect(result?.static).toEqual({});
        });

        it('should handle coverage with only static data', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest:  {},
                'static': ['1', '2', '3'],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({});
            expect(result?.static).toEqual({
                '1': 1,
                '2': 1,
                '3': 1,
            });
        });

        it('should handle multiple tests with overlapping mutant coverage', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'test-1': ['1', '2', '3'],
                    'test-2': ['2', '3', '4'],
                    'test-3': ['1', '4', '5'],
                },
                'static': ['6'],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({
                'test-1': { '1': 1, '2': 1, '3': 1 },
                'test-2': { '2': 1, '3': 1, '4': 1 },
                'test-3': { '1': 1, '4': 1, '5': 1 },
            });
        });

        it('should set all hit counts to 1', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'test-1': ['1', '2', '3', '4', '5'],
                },
                'static': ['10', '20'],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Verify all hit counts are 1
            const perTestCounts = Object.values(result!.perTest['test-1']);
            expect(perTestCounts.every(count => count === 1)).toBe(true);

            const staticCounts = Object.values(result!.static);
            expect(staticCounts.every(count => count === 1)).toBe(true);
        });

        it('should merge coverage from multiple JSON lines', async () => {
            // Multiple test files writing to the same coverage file
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1', '2'] }, 'static': ['6', '7'] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-2': ['3', '4'] }, 'static': ['8', '9'] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({
                'test-1': { '1': 1, '2': 1 },
                'test-2': { '3': 1, '4': 1 },
            });
            expect(result?.static).toEqual({
                '6': 1,
                '7': 1,
                '8': 1,
                '9': 1,
            });
        });

        it('should deduplicate static coverage across JSON lines', async () => {
            // Multiple test files may cover the same static mutants
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': ['6', '7', '8'] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': ['7', '8', '9'] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-3': ['3'] }, 'static': ['8', '9', '10'] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            // Static should be deduplicated - union of all static mutants
            expect(result?.static).toEqual({
                '6':  1,
                '7':  1,
                '8':  1,
                '9':  1,
                '10': 1,
            });
        });

        it('should merge mutant IDs for duplicate test IDs across JSON lines', async () => {
            // Edge case: same test ID appears in multiple JSON lines
            // This shouldn't happen in normal operation, but we handle it safely
            // Kills mutation 241: tests the else branch on line 42 where !merged.perTest[testId] is false
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1', '2'] }, 'static': [] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-1': ['3', '4'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            // Should union the mutant IDs for the duplicate test ID
            // If the conditional on line 42 was mutated to false, this would fail
            expect(result?.perTest['test-1']).toEqual({
                '1': 1,
                '2': 1,
                '3': 1,
                '4': 1,
            });
        });

        it('should handle duplicate test IDs with overlapping mutant coverage', async () => {
            // Kills mutation 241: Specifically tests the merge path when testId exists
            // The condition !merged.perTest[testId] must be true for first occurrence
            // and false for subsequent occurrences
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1', '2', '3'] }, 'static': [] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-1': ['2', '3', '4'] }, 'static': [] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-1': ['3', '4', '5'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should have union of all mutants: 1, 2, 3, 4, 5
            expect(result?.perTest['test-1']).toEqual({
                '1': 1,
                '2': 1,
                '3': 1,
                '4': 1,
                '5': 1,
            });
            expect(Object.keys(result!.perTest['test-1'])).toHaveLength(5);
        });

        it('should handle many JSON lines from parallel test execution', async () => {
            // Simulate 10 test files running in parallel
            const lines: string[] = [];
            for(let i = 0; i < 10; i++) {
                lines.push(JSON.stringify({
                    perTest:  { [`test-${i}`]: [`${i}`, `${i + 10}`] },
                    'static': [`${i + 100}`],
                }));
            }
            const jsonLines = lines.join('\n') + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            // Should have all 10 tests
            expect(Object.keys(result!.perTest)).toHaveLength(10);
            // Each test should have 2 mutants
            for(let i = 0; i < 10; i++) {
                expect(result!.perTest[`test-${i}`]).toEqual({
                    [`${i}`]:      1,
                    [`${i + 10}`]: 1,
                });
            }
            // Static should have 10 unique mutants
            expect(Object.keys(result!.static)).toHaveLength(10);
        });

        it('should skip invalid JSON lines but process valid ones', async () => {
            // Mix of valid and invalid lines
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': ['6'] }) + '\n'
                  + '{ invalid json here }\n'
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': ['7'] }) + '\n'
                  + 'also not valid\n'
                  + JSON.stringify({ perTest: { 'test-3': ['3'] }, 'static': ['8'] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            // Should only include the 3 valid entries
            expect(result?.perTest).toEqual({
                'test-1': { '1': 1 },
                'test-2': { '2': 1 },
                'test-3': { '3': 1 },
            });
            expect(result?.static).toEqual({
                '6': 1,
                '7': 1,
                '8': 1,
            });
        });

        it('should kill mutation 260: catch block must log warning for parse errors', async () => {
            // Mutation 260: removes the catch block body (lines 90-96)
            // The catch block should log a warning when JSON parsing fails
            // Reset the console.warn mock to verify it's called
            const consoleWarnMock = console.warn as unknown as ReturnType<typeof mock>;
            consoleWarnMock.mockClear();

            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + '{ this is invalid json and will throw }\n'
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should still process valid lines
            expect(result).toBeDefined();
            expect(Object.keys(result!.perTest)).toHaveLength(2);

            // CRITICAL: The catch block must execute and log the warning
            // If mutation 260 removes the catch block body, console.warn won't be called
            expect(consoleWarnMock).toHaveBeenCalled();
            expect(consoleWarnMock).toHaveBeenCalledWith(
                expect.stringContaining('[Stryker Coverage] Failed to parse coverage line:')
            );
        });
    });

    describe('error handling', () => {
        it('should return undefined when file does not exist', async () => {
            mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

            const result = await collectCoverage('/nonexistent/coverage.json');

            expect(result).toBeUndefined();
        });

        it('should return undefined when file is empty', async () => {
            mockReadFile.mockResolvedValue('');

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeUndefined();
        });

        it('should return undefined when all JSON lines are malformed', async () => {
            // All lines are invalid JSON
            mockReadFile.mockResolvedValue('{ invalid json }\n{ also invalid }\n');

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeUndefined();
        });

        it('should return undefined when coverage data has wrong structure', async () => {
            // Data with missing required fields will cause errors during merge
            const jsonLines = JSON.stringify({ wrong: 'structure' }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Cannot process malformed data structure
            expect(result).toBeUndefined();
        });

        it('should return undefined on read permission error', async () => {
            mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeUndefined();
        });
    });

    describe('filter and trim mutation tests', () => {
        it('should filter out empty lines from coverage file', async () => {
            // This test kills mutations on line 83: .filter(line => line.length > 0)
            // If the filter is removed or mutated, empty lines would cause JSON.parse errors
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': ['6'] }) + '\n'
                  + '\n'  // Empty line that should be filtered out
                  + '\n'  // Another empty line
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': ['7'] }) + '\n'
                  + '\n';  // Trailing empty line

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should successfully parse despite empty lines
            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({
                'test-1': { '1': 1 },
                'test-2': { '2': 1 },
            });
            expect(result?.static).toEqual({
                '6': 1,
                '7': 1,
            });
        });

        it('should handle file with only whitespace lines', async () => {
            // Test that trim() + filter combination handles whitespace-only lines
            const jsonLines = '   \n\t\n  \n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should return undefined since no valid coverage data
            expect(result).toBeUndefined();
        });

        it('should handle file with only newlines', async () => {
            // Kill mutation: tests split('\n') with only newline separators
            // If split is mutated to split(''), would create many single-char elements
            const jsonLines = '\n\n\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should return undefined since no valid coverage data after filtering
            expect(result).toBeUndefined();
        });

        it('should handle file with mixed whitespace and empty lines', async () => {
            // Tests the full chain: trim().split('\n').filter(line => line.length > 0)
            // Ensures whitespace-only lines are trimmed to empty strings and then filtered out
            const jsonLines
                = '  \n'  // Leading whitespace line
                  + JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + '\t\t\n'  // Tab-only line
                  + '\n'  // Empty line
                  + '   \t  \n'  // Mixed whitespace
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should only process the 2 valid JSON lines
            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({
                'test-1': { '1': 1 },
                'test-2': { '2': 1 },
            });
        });

        it('should preserve data when file has no trailing newline', async () => {
            // Tests split('\n') behavior when file doesn't end with newline
            // Ensures the last line is still processed correctly
            const jsonLines = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': ['5'] });
            // Note: no trailing '\n'

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({ 'test-1': { '1': 1 } });
            expect(result?.static).toEqual({ '5': 1 });
        });

        it('should handle single valid line with trailing whitespace', async () => {
            // Tests trim() effectiveness on lines with trailing spaces
            const jsonLines = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '   \n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({ 'test-1': { '1': 1 } });
        });

        it('should verify filter removes zero-length lines', async () => {
            // Specifically tests filter(line => line.length > 0)
            // After trim and split, ensure empty strings are removed
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + ''  // Empty string after split
                  + '\n'
                  + '';  // Another empty string

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should parse successfully with only 1 valid entry
            expect(result).toBeDefined();
            expect(Object.keys(result!.perTest)).toHaveLength(1);
        });

        it('should kill mutation 249: filter method must exist', async () => {
            // Mutation 249: content.trim().split('\\n').filter(line => line.length > 0) → content.trim().split('\\n')
            // If filter is removed, empty lines would cause JSON.parse to fail
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + '\n'  // This empty line MUST be filtered out
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Without filter, parsing would fail on empty line
            expect(result).toBeDefined();
            expect(Object.keys(result!.perTest)).toHaveLength(2);
        });

        it('should kill mutation 250: trim method must exist', async () => {
            // Mutation 250: content.trim().split('\\n') → content.split('\\n')
            // If trim is removed, leading/trailing whitespace would remain
            const jsonLines = '  \n' + JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n  ';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Without trim, the leading/trailing whitespace lines would cause issues
            expect(result).toBeDefined();
            expect(Object.keys(result!.perTest)).toHaveLength(1);
        });

        it('should kill mutation 255: line.length > 0 not >= 0', async () => {
            // Mutation 255: line.length > 0 → line.length >= 0
            // Zero-length lines should be filtered out, not kept
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + '\n'  // Zero-length line after trim
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should successfully parse despite zero-length line
            // If >= 0 is used, empty strings would be kept and cause parse errors
            expect(result).toBeDefined();
            expect(Object.keys(result!.perTest)).toHaveLength(2);
        });

        it('should kill mutation 253: filter condition must check line.length', async () => {
            // Mutation 253: filter(line => line.length > 0) → filter(line => true)
            // If condition is always true, empty lines would not be filtered
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + '\n'
                  + '\n'
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // If filter(true) is used, empty lines would remain and cause JSON.parse errors
            expect(result).toBeDefined();
            expect(Object.keys(result!.perTest)).toHaveLength(2);
        });
    });

    describe('static array initialization mutation tests', () => {
        it('should start with empty static array - first entry has no static coverage', async () => {
            // This test kills mutations on line 34: static: [] → ["Stryker was here"]
            // If static is pre-populated, the first coverage data would incorrectly
            // include mutants that weren't actually covered
            const jsonLines = JSON.stringify({
                perTest:  { 'test-1': ['1'] },
                'static': [],  // Explicitly empty - no static coverage
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should have empty static coverage - CRITICAL: not ["Stryker was here"]
            expect(result?.static).toEqual({});
            expect(Object.keys(result!.static)).toHaveLength(0);
        });

        it('should verify merged static array starts empty before accumulating', async () => {
            // Kills mutation 236: Verifies that merged.static starts as [] on line 34
            // If it started with ["Stryker was here"], the result would include that mutant
            const jsonLines
                = JSON.stringify({ perTest: {}, 'static': [] }) + '\n'
                  + JSON.stringify({ perTest: {}, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Result should be empty, not contain any phantom mutants
            expect(result?.static).toEqual({});
        });

        it('should handle multiple coverage entries with initially empty static', async () => {
            // Verify that static array merging works correctly when starting empty
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1'] }, 'static': [] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-2': ['2'] }, 'static': ['10'] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-3': ['3'] }, 'static': ['20', '30'] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Static should only contain mutants from entries that had them
            expect(result?.static).toEqual({
                '10': 1,
                '20': 1,
                '30': 1,
            });
        });
    });

    describe('data format conversion', () => {
        it('should handle numeric mutant IDs as strings', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'test-1': ['1', '2', '3'],
                },
                'static': ['10', '20', '30'],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Verify mutant IDs are preserved as strings in the output
            expect(Object.keys(result!.perTest['test-1'])).toEqual(['1', '2', '3']);
            expect(Object.keys(result!.static)).toEqual(['10', '20', '30']);
        });

        it('should handle large numbers of mutants', async () => {
            const mutants = Array.from({ length: 1000 }, (_, i) => String(i));
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'test-1': mutants,
                },
                'static': [],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(Object.keys(result!.perTest['test-1'])).toHaveLength(1000);
        });

        it('should handle test IDs with special characters', async () => {
            // JSON lines format: one JSON object per line
            const jsonLines = JSON.stringify({
                perTest: {
                    'should handle "quotes"': ['1'],
                    'should handle spaces':   ['2'],
                    'should-handle-dashes':   ['3'],
                },
                'static': [],
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toHaveProperty('should handle "quotes"');
            expect(result?.perTest).toHaveProperty('should handle spaces');
            expect(result?.perTest).toHaveProperty('should-handle-dashes');
        });
    });
});

describe('cleanupCoverageFile', () => {
    let mockUnlink: ReturnType<typeof mock>;

    beforeEach(() => {
        mockUnlink = mock();
        spyOn(fs, 'unlink').mockImplementation(mockUnlink);
    });

    afterEach(() => {
        mock.restore();
    });

    it('should delete the coverage file', async () => {
        mockUnlink.mockResolvedValue(undefined);

        await cleanupCoverageFile('/tmp/coverage.json');

        expect(mockUnlink).toHaveBeenCalledWith('/tmp/coverage.json');
    });

    it('should not throw error if file does not exist', () => {
        mockUnlink.mockRejectedValue(new Error('ENOENT: no such file or directory'));

        // Should not throw
        expect(cleanupCoverageFile('/nonexistent/coverage.json')).resolves.toBeUndefined();
    });

    it('should not throw error on permission errors', () => {
        mockUnlink.mockRejectedValue(new Error('EACCES: permission denied'));

        // Should not throw
        expect(cleanupCoverageFile('/tmp/coverage.json')).resolves.toBeUndefined();
    });

    it('should silently ignore any deletion errors', () => {
        mockUnlink.mockRejectedValue(new Error('Some random error'));

        // Should not throw
        expect(cleanupCoverageFile('/tmp/coverage.json')).resolves.toBeUndefined();
    });
});
