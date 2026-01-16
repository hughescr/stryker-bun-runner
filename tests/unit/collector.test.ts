/**
 * Unit tests for coverage/collector
 * Tests coverage collection and data merging functionality
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { collectCoverage, cleanupCoverageFile } from '../../src/coverage/collector.js';

// Mock the fs/promises module
void mock.module('node:fs/promises', () => ({
    readFile: mock(async () => ''),
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
    unlink:   mock(() => {}),
}));

describe('collector', () => {
    describe('collectCoverage', () => {
        let originalConsoleWarn: typeof console.warn;

        beforeEach(() => {
            originalConsoleWarn = console.warn;
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock to suppress test output
            console.warn = () => {};
        });

        afterEach(() => {
            console.warn = originalConsoleWarn;
            mock.restore();
        });

        describe('successful coverage collection', () => {
            it('should collect coverage from single test file', async () => {
                const coverageData = {
                    perTest:  { 'test-1': ['1', '2', '3'] },
                    'static': ['4', '5'],
                };

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => JSON.stringify(coverageData) + '\n'),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(result).toBeDefined();
                expect(result?.perTest).toEqual({
                    'test-1': { '1': 1, '2': 1, '3': 1 },
                });
                expect(result?.static).toEqual({ '4': 1, '5': 1 });
            });

            it('should merge coverage from multiple test files (JSON lines format)', async () => {
                const line1 = { perTest: { 'test-1': ['1', '2'] }, 'static': ['3'] };
                const line2 = { perTest: { 'test-2': ['4'] }, 'static': ['5'] };
                const content = JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(result).toBeDefined();
                expect(result?.perTest).toEqual({
                    'test-1': { '1': 1, '2': 1 },
                    'test-2': { '4': 1 },
                });
                expect(result?.static).toEqual({ '3': 1, '5': 1 });
            });
        });

        describe('line 34 mutation: ArrayDeclaration -> ["Stryker was here"]', () => {
            it('should initialize merged static array as empty, not with placeholder', async () => {
                // Kills mutation: 'static': [] → 'static': ["Stryker was here"]
                // When no data has static coverage, the merged static should be empty array
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const line2 = { perTest: { 'test-2': ['2'] }, 'static': [] };
                const content = JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // If mutated to ["Stryker was here"], would contain "Stryker was here" key
                expect(result?.static).toEqual({});
                expect(Object.keys(result?.static ?? {})).toHaveLength(0);
                expect(result?.static?.['Stryker was here']).toBeUndefined();
            });

            it('should have empty static when merging multiple files with no static coverage', async () => {
                // Additional test to ensure empty static array behavior
                const data1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const data2 = { perTest: { 'test-2': ['2'] }, 'static': [] };
                const data3 = { perTest: { 'test-3': ['3'] }, 'static': [] };
                const content = [data1, data2, data3].map(d => JSON.stringify(d)).join('\n') + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(result?.static).toBeDefined();
                expect(result?.static).toEqual({});
                // Mutation would add "Stryker was here" to the static result
                expect(result?.static?.['Stryker was here']).toBeUndefined();
            });
        });

        describe('line 42 mutation: ConditionalExpression -> false', () => {
            it('should merge duplicate test IDs by unioning mutant coverage', async () => {
                // Kills mutation: if(!merged.perTest[testId]) → if(false)
                // When same testId appears in multiple files, we union the mutants
                const line1 = { perTest: { 'test-1': ['1', '2'] }, 'static': [] };
                const line2 = { perTest: { 'test-1': ['2', '3'] }, 'static': [] }; // Duplicate test-1
                const content = JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // If mutation makes condition always false, it would skip the union logic
                // and overwrite instead of merge, losing mutant '1'
                expect(result?.perTest['test-1']).toEqual({ '1': 1, '2': 1, '3': 1 });
                expect(Object.keys(result?.perTest['test-1'] ?? {})).toHaveLength(3);
            });

            it('should handle multiple duplicate test IDs across many files', async () => {
                // Test with same testId appearing 3 times
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const line2 = { perTest: { 'test-1': ['2'] }, 'static': [] };
                const line3 = { perTest: { 'test-1': ['3'] }, 'static': [] };
                const content = [line1, line2, line3].map(d => JSON.stringify(d)).join('\n') + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // All mutants should be merged, not overwritten
                expect(result?.perTest['test-1']).toEqual({ '1': 1, '2': 1, '3': 1 });
            });

            it('should preserve first occurrence when merging duplicates', async () => {
                // Ensure original data isn't lost when duplicates are found
                const line1 = { perTest: { 'test-1': ['10', '20', '30'] }, 'static': [] };
                const line2 = { perTest: { 'test-1': ['40'] }, 'static': [] };
                const content = JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // All mutants from first occurrence should be preserved
                expect(result?.perTest['test-1']).toEqual({ '10': 1, '20': 1, '30': 1, '40': 1 });
            });
        });

        describe('line 83 mutation: content processing', () => {
            it('should filter out empty lines when parsing JSON lines', async () => {
                // Kills mutations on: content.trim().split('\n').filter(line => line.length > 0)
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const line2 = { perTest: { 'test-2': ['2'] }, 'static': [] };
                // Content with empty lines between valid JSON
                const content = JSON.stringify(line1) + '\n\n\n' + JSON.stringify(line2) + '\n\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Should successfully parse both lines, ignoring empty lines
                expect(result?.perTest).toEqual({
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                });
            });

            it('should handle content with leading and trailing whitespace', async () => {
                // Tests the trim() part of the mutation
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const content = '\n\n' + JSON.stringify(line1) + '\n\n\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(result?.perTest).toEqual({
                    'test-1': { '1': 1 },
                });
            });

            it('should handle file with only whitespace and newlines', async () => {
                // Edge case: file with no valid content after filtering
                const content = '\n\n\n   \n\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Should return undefined when no valid data
                expect(result).toBeUndefined();
            });

            it('should process each line separately (split by newline)', async () => {
                // Tests the split('\n') part
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const line2 = { perTest: { 'test-2': ['2'] }, 'static': [] };
                const line3 = { perTest: { 'test-3': ['3'] }, 'static': [] };
                const content = [line1, line2, line3].map(d => JSON.stringify(d)).join('\n');

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // All three lines should be parsed
                expect(Object.keys(result?.perTest ?? {})).toHaveLength(3);
                expect(result?.perTest['test-1']).toBeDefined();
                expect(result?.perTest['test-2']).toBeDefined();
                expect(result?.perTest['test-3']).toBeDefined();
            });

            it('should filter lines with zero length after split', async () => {
                // Tests the filter(line => line.length > 0) part
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': ['5'] };
                // Multiple consecutive newlines create empty strings after split
                const content = JSON.stringify(line1) + '\n\n\n\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Should parse successfully without trying to parse empty lines
                expect(result?.perTest['test-1']).toEqual({ '1': 1 });
                expect(result?.static).toEqual({ '5': 1 });
            });

            it('should NOT emit warnings when filtering empty lines (mutation killer for >= vs >)', async () => {
                // Kills mutations:
                // - line.length > 0 → line.length >= 0
                // - removing .filter()
                // - ConditionalExpression true
                // If mutated, empty strings pass through and cause JSON.parse to throw and warn
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const line2 = { perTest: { 'test-2': ['2'] }, 'static': [] };
                // Empty lines BETWEEN valid JSON lines (trim won't remove these)
                const content = JSON.stringify(line1) + '\n\n\n' + JSON.stringify(line2);

                let warnCallCount = 0;
                console.warn = () => {
                    warnCallCount++;
                };

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Should successfully parse WITHOUT warnings
                // Mutations would include empty strings, which would fail JSON.parse and trigger warnings
                expect(warnCallCount).toBe(0);
                expect(result?.perTest['test-1']).toEqual({ '1': 1 });
                expect(result?.perTest['test-2']).toEqual({ '2': 1 });
            });

            it('should parse multiple JSON lines (kills mutation removing .trim().split)', async () => {
                // Kills mutation: content.trim().split('\\n').filter() → content
                // If mutated to just 'content', iterates over each char, all parse attempts fail
                const line1 = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const line2 = { perTest: { 'test-2': ['2'] }, 'static': [] };
                const content = JSON.stringify(line1) + '\n' + JSON.stringify(line2);

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Should parse BOTH lines successfully and return valid result
                // Mutation would iterate over chars, fail all parses, return undefined
                expect(result).toBeDefined();
                expect(result).not.toBeUndefined();
                expect(result?.perTest['test-1']).toEqual({ '1': 1 });
                expect(result?.perTest['test-2']).toEqual({ '2': 1 });
                expect(Object.keys(result?.perTest ?? {})).toHaveLength(2);
            });
        });

        describe('error handling', () => {
            it('should skip invalid JSON lines but continue processing', async () => {
                const validLine = { perTest: { 'test-1': ['1'] }, 'static': [] };
                const content = 'invalid json\n' + JSON.stringify(validLine) + '\n';

                let warnCalled = false;
                console.warn = () => {
                    warnCalled = true;
                };

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(warnCalled).toBe(true);
                expect(result?.perTest['test-1']).toEqual({ '1': 1 });
            });

            it('should return undefined when file cannot be read', async () => {
                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => {
                        throw new Error('File not found');
                    }),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink: mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/nonexistent.json');
                expect(result).toBeUndefined();
            });

            it('should return undefined when all lines are invalid', async () => {
                const content = 'not json\ninvalid\nalso bad\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');
                expect(result).toBeUndefined();
            });
        });

        describe('data format conversion', () => {
            it('should convert string arrays to hit count records', async () => {
                const data = {
                    perTest:  { 'test-1': ['1', '2', '3'] },
                    'static': ['10', '20'],
                };

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => JSON.stringify(data) + '\n'),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Each mutant ID should have hit count of 1
                expect(result?.perTest['test-1']).toEqual({ '1': 1, '2': 1, '3': 1 });
                expect(result?.static).toEqual({ '10': 1, '20': 1 });
            });

            it('should handle empty perTest and static arrays', async () => {
                const data = { perTest: {}, 'static': [] };

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => JSON.stringify(data) + '\n'),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(result?.perTest).toEqual({});
                expect(result?.static).toEqual({});
            });
        });

        describe('static coverage merging', () => {
            it('should union static coverage from multiple files', async () => {
                const line1 = { perTest: {}, 'static': ['1', '2'] };
                const line2 = { perTest: {}, 'static': ['2', '3'] }; // '2' is duplicate
                const content = JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                // Should deduplicate: ['1', '2', '3']
                expect(result?.static).toEqual({ '1': 1, '2': 1, '3': 1 });
                expect(Object.keys(result?.static ?? {})).toHaveLength(3);
            });

            it('should handle many duplicate static mutants across files', async () => {
                const line1 = { perTest: {}, 'static': ['100'] };
                const line2 = { perTest: {}, 'static': ['100'] };
                const line3 = { perTest: {}, 'static': ['100', '200'] };
                const content = [line1, line2, line3].map(d => JSON.stringify(d)).join('\n') + '\n';

                void mock.module('node:fs/promises', () => ({
                    readFile: mock(async () => content),
                    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
                    unlink:   mock(() => {}),
                }));

                const result = await collectCoverage('/tmp/coverage.json');

                expect(result?.static).toEqual({ '100': 1, '200': 1 });
            });
        });
    });

    describe('cleanupCoverageFile', () => {
        afterEach(() => {
            mock.restore();
        });

        it('should call unlink on coverage file', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty mock
            const unlinkMock = mock(() => {});

            void mock.module('node:fs/promises', () => ({
                readFile: mock(async () => ''),
                unlink:   unlinkMock,
            }));

            await cleanupCoverageFile('/tmp/coverage.json');

            expect(unlinkMock).toHaveBeenCalledWith('/tmp/coverage.json');
        });

        it('should not throw when file does not exist', async () => {
            void mock.module('node:fs/promises', () => ({
                readFile: mock(async () => ''),
                unlink:   mock(() => {
                    throw new Error('ENOENT: file not found');
                }),
            }));

            // Should not throw
            await expect(cleanupCoverageFile('/tmp/nonexistent.json')).resolves.toBeUndefined();
        });

        it('should silently ignore all errors', async () => {
            void mock.module('node:fs/promises', () => ({
                readFile: mock(async () => ''),
                unlink:   mock(() => {
                    throw new Error('Permission denied');
                }),
            }));

            // Should not throw
            await expect(cleanupCoverageFile('/tmp/coverage.json')).resolves.toBeUndefined();
        });
    });
});
