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
            const jsonLines
                = JSON.stringify({ perTest: { 'test-1': ['1', '2'] }, 'static': [] }) + '\n'
                  + JSON.stringify({ perTest: { 'test-1': ['3', '4'] }, 'static': [] }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            // Should union the mutant IDs for the duplicate test ID
            expect(result?.perTest['test-1']).toEqual({
                '1': 1,
                '2': 1,
                '3': 1,
                '4': 1,
            });
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
    });

    describe('static array initialization mutation tests', () => {
        it('should start with empty static array', async () => {
            // This test kills mutations on line 34: static: [] → ["Stryker was here"]
            // If static is pre-populated, the first coverage data would incorrectly
            // include mutants that weren't actually covered
            const jsonLines = JSON.stringify({
                perTest:  { 'test-1': ['1'] },
                'static': [],  // Explicitly empty
            }) + '\n';

            mockReadFile.mockResolvedValue(jsonLines);

            const result = await collectCoverage(tempCoverageFile);

            // Should have empty static coverage
            expect(result?.static).toEqual({});
            expect(Object.keys(result!.static)).toHaveLength(0);
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
