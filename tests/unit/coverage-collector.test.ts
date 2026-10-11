/**
 * Unit tests for coverage/collector
 * Tests coverage data collection and merging
 */

import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { collectCoverage, collectLateHits, cleanupCoverageFile } from '../../src/coverage/collector.js';
import type { CoverageFileData } from '../../src/coverage/types.js';
import { mockReadFile, mockUnlink, resetFsMocks } from '../test-preload.js';

/** One JSON line of the coverage file, as the preload writes it. */
function line(data: CoverageFileData): string {
    return JSON.stringify(data);
}

describe('collectCoverage', () => {
    let tempCoverageFile: string;

    const makeLogger = () => ({ warn: mock(() => {}) });

    beforeEach(() => {
        tempCoverageFile = path.join(tmpdir(), `test-coverage-${Date.now()}.json`);
    });

    afterEach(() => {
        // Undo this test's fs mock setup and calls
        resetFsMocks();
    });

    describe('successful collection', () => {
        it('should return the real hit counts from the file unchanged', async () => {
            // Stryker sums these per mutant to size each mutant run's hitLimit
            // (100 × dry-run hits), so they must not be flattened to 1.
            mockReadFile.mockResolvedValue(`${line({
                perTest: {
                    'test-1': { '1': 3, '2': 1, '3': 250 },
                    'test-2': { '4': 7, '5': 1 },
                },
                'static': { '6': 2, '7': 1 },
            })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toEqual({
                perTest: {
                    'test-1': { '1': 3, '2': 1, '3': 250 },
                    'test-2': { '4': 7, '5': 1 },
                },
                'static': { '6': 2, '7': 1 },
            });
        });

        it('should handle empty coverage data', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: {}, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeDefined();
            expect(result?.perTest).toEqual({});
            expect(result?.static).toEqual({});
        });

        it('should handle coverage with only perTest data', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1, '2': 4 } }, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({ 'test-1': { '1': 1, '2': 4 } });
            expect(result?.static).toEqual({});
        });

        it('should handle coverage with only static data', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: {}, 'static': { '1': 1, '2': 2, '3': 3 } })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({});
            expect(result?.static).toEqual({ '1': 1, '2': 2, '3': 3 });
        });

        it('should keep each test\'s own count for a mutant several tests cover', async () => {
            mockReadFile.mockResolvedValue(`${line({
                perTest: {
                    'test-1': { '1': 1, '2': 5 },
                    'test-2': { '2': 9, '3': 1 },
                },
                'static': { '6': 1 },
            })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({
                'test-1': { '1': 1, '2': 5 },
                'test-2': { '2': 9, '3': 1 },
            });
        });

        it('should merge coverage from multiple JSON lines', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1, '2': 2 } }, 'static': { '6': 1, '7': 3 } })}\n${
                line({ perTest: { 'test-2': { '3': 4, '4': 1 } }, 'static': { '8': 1, '9': 5 } })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toEqual({
                perTest: {
                    'test-1': { '1': 1, '2': 2 },
                    'test-2': { '3': 4, '4': 1 },
                },
                'static': { '6': 1, '7': 3, '8': 1, '9': 5 },
            });
        });

        it('should sum the static counts of a mutant that several JSON lines report', async () => {
            // Each line is a separate record of hits; dropping any of them would understate
            // the mutant's hits, and with it the hitLimit Stryker derives (a false Timeout risk).
            mockReadFile.mockResolvedValue(`${line({ perTest: {}, 'static': { '6': 1, '7': 2 } })}\n${
                line({ perTest: {}, 'static': { '7': 10, '8': 1 } })}\n${
                line({ perTest: {}, 'static': { '7': 100 } })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.static).toEqual({ '6': 1, '7': 112, '8': 1 });
        });

        it('should sum the counts of a test id that several JSON lines report (shouldn\'t happen, but be safe)', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1, '2': 2 } }, 'static': {} })}\n${
                line({ perTest: { 'test-1': { '2': 20, '3': 3 } }, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({ 'test-1': { '1': 1, '2': 22, '3': 3 } });
        });

        it('should handle many JSON lines from parallel test execution', async () => {
            const lines: string[] = [];
            for(let i = 0; i < 10; i++) {
                lines.push(line({
                    perTest:  { [`test-${i}`]: { [`${i}`]: i + 1, [`${i + 10}`]: 1 } },
                    'static': { [`${i + 100}`]: 1 },
                }));
            }
            mockReadFile.mockResolvedValue(`${lines.join('\n')}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(Object.keys(result!.perTest)).toHaveLength(10);
            for(let i = 0; i < 10; i++) {
                expect(result!.perTest[`test-${i}`]).toEqual({
                    [`${i}`]:      i + 1,
                    [`${i + 10}`]: 1,
                });
            }
            expect(Object.keys(result!.static)).toHaveLength(10);
        });

        it('should skip invalid JSON lines but process valid ones', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': { '6': 1 } })}\n`
              + `{ invalid json here }\n${
                  line({ perTest: { 'test-2': { '2': 2 } }, 'static': { '7': 1 } })}\n`
                  + `also not valid\n${
                      line({ perTest: { 'test-3': { '3': 3 } }, 'static': { '8': 1 } })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toEqual({
                perTest: {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 2 },
                    'test-3': { '3': 3 },
                },
                'static': { '6': 1, '7': 1, '8': 1 },
            });
        });

        it('should log a warning for each line that is not valid JSON', async () => {
            const logger = makeLogger();
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n`
              + `{ this is invalid json and will throw }\n${
                  line({ perTest: { 'test-2': { '2': 1 } }, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile, logger);

            expect(Object.keys(result!.perTest)).toHaveLength(2);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('[Stryker Coverage] Failed to parse coverage line:'),
                expect.any(String)
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
            mockReadFile.mockResolvedValue('{ invalid json }\n{ also invalid }\n');

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeUndefined();
        });

        it('should return undefined when coverage data has wrong structure', async () => {
            // Data with missing required fields will cause errors during merge
            mockReadFile.mockResolvedValue(`${JSON.stringify({ wrong: 'structure' })}\n`);

            const result = await collectCoverage(tempCoverageFile);

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
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': { '6': 1 } })}\n`
              + '\n'
              + `\n${line({ perTest: { 'test-2': { '2': 1 } }, 'static': { '7': 1 } })}\n`
              + '\n');

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toEqual({
                perTest:  { 'test-1': { '1': 1 }, 'test-2': { '2': 1 } },
                'static': { '6': 1, '7': 1 },
            });
        });

        it('should handle file with only whitespace lines', async () => {
            mockReadFile.mockResolvedValue('   \n\t\n  \n');

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeUndefined();
        });

        it('should handle file with only newlines', async () => {
            mockReadFile.mockResolvedValue('\n\n\n');

            const result = await collectCoverage(tempCoverageFile);

            expect(result).toBeUndefined();
        });

        it('should handle file with mixed whitespace and empty lines', async () => {
            mockReadFile.mockResolvedValue(`  \n${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n`
              + '\t\t\n'
              + '\n'
              + `   \t  \n${line({ perTest: { 'test-2': { '2': 1 } }, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({
                'test-1': { '1': 1 },
                'test-2': { '2': 1 },
            });
        });

        it('should preserve data when file has no trailing newline', async () => {
            mockReadFile.mockResolvedValue(line({ perTest: { 'test-1': { '1': 1 } }, 'static': { '5': 1 } }));

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({ 'test-1': { '1': 1 } });
            expect(result?.static).toEqual({ '5': 1 });
        });

        it('should handle single valid line with trailing whitespace', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}   \n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toEqual({ 'test-1': { '1': 1 } });
        });

        it('should parse both lines around an empty line', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n`
              + `\n${line({ perTest: { 'test-2': { '2': 1 } }, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(Object.keys(result!.perTest)).toHaveLength(2);
        });

        it('should parse a line surrounded by whitespace-only lines', async () => {
            mockReadFile.mockResolvedValue(`  \n${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n  `);

            const result = await collectCoverage(tempCoverageFile);

            expect(Object.keys(result!.perTest)).toHaveLength(1);
        });
    });

    describe('merged static starts empty', () => {
        it('should report no static coverage when no line has any', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n${
                line({ perTest: {}, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.static).toEqual({});
        });

        it('should contain only the static mutants the lines report', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n${
                line({ perTest: { 'test-2': { '2': 1 } }, 'static': { '10': 1 } })}\n${
                line({ perTest: { 'test-3': { '3': 1 } }, 'static': { '20': 2, '30': 1 } })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.static).toEqual({ '10': 1, '20': 2, '30': 1 });
        });
    });

    describe('data format', () => {
        it('should keep mutant ids as string keys', async () => {
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1, '2': 1, '3': 1 } }, 'static': { '10': 1, '20': 1, '30': 1 } })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(Object.keys(result!.perTest['test-1'])).toEqual(['1', '2', '3']);
            expect(Object.keys(result!.static)).toEqual(['10', '20', '30']);
        });

        it('should handle large numbers of mutants', async () => {
            const counts = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), i + 1]));
            mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': counts }, 'static': {} })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(Object.keys(result!.perTest['test-1'])).toHaveLength(1000);
            expect(result!.perTest['test-1']['999']).toBe(1000);
        });

        it('should handle test IDs with special characters', async () => {
            mockReadFile.mockResolvedValue(`${line({
                perTest: {
                    'should handle "quotes"': { '1': 1 },
                    'should handle spaces':   { '2': 1 },
                    'should-handle-dashes':   { '3': 1 },
                },
                'static': {},
            })}\n`);

            const result = await collectCoverage(tempCoverageFile);

            expect(result?.perTest).toHaveProperty('should handle "quotes"');
            expect(result?.perTest).toHaveProperty('should handle spaces');
            expect(result?.perTest).toHaveProperty('should-handle-dashes');
        });
    });
});

describe('collectLateHits', () => {
    let tempCoverageFile: string;

    const makeLogger = () => ({ warn: mock(() => {}) });

    beforeEach(() => {
        tempCoverageFile = path.join(tmpdir(), `test-coverage-${Date.now()}.json`);
    });

    afterEach(() => {
        resetFsMocks();
    });

    it('should return [] when no line has lateHits', async () => {
        mockReadFile.mockResolvedValue(`${line({ perTest: { 'test-1': { '1': 1 } }, 'static': {} })}\n`);

        const result = await collectLateHits(tempCoverageFile);

        expect(result).toEqual([]);
    });

    it('should return [] when the coverage file does not exist', async () => {
        mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

        const result = await collectLateHits('/nonexistent/coverage.json');

        expect(result).toEqual([]);
    });

    it('should concatenate lateHits across multiple JSON lines', async () => {
        mockReadFile.mockResolvedValue(`${line({
            perTest:  {},
            'static': { '1': 1 },
            lateHits: [{ testId: 'tests/a.test.ts@@test-1', mutantIds: ['1'] }],
        })}\n${
            line({
                perTest:  {},
                'static': { '2': 1 },
                lateHits: [{ testId: 'tests/b.test.ts@@test-3', mutantIds: ['2', '3'] }],
            })}\n`);

        const result = await collectLateHits(tempCoverageFile);

        expect(result).toEqual([
            { testId: 'tests/a.test.ts@@test-1', mutantIds: ['1'] },
            { testId: 'tests/b.test.ts@@test-3', mutantIds: ['2', '3'] },
        ]);
    });

    it('should treat a line with no lateHits field as contributing none', async () => {
        mockReadFile.mockResolvedValue(`${line({
            perTest:  {},
            'static': { '1': 1 },
            lateHits: [{ testId: 'tests/a.test.ts@@test-1', mutantIds: ['1'] }],
        })}\n${
            line({ perTest: {}, 'static': {} })}\n`);

        const result = await collectLateHits(tempCoverageFile);

        expect(result).toEqual([{ testId: 'tests/a.test.ts@@test-1', mutantIds: ['1'] }]);
    });

    it('should skip malformed lines and log a warning, but still collect lateHits from valid lines', async () => {
        const logger = makeLogger();
        mockReadFile.mockResolvedValue(`${line({
            perTest:  {},
            'static': { '1': 1 },
            lateHits: [{ testId: 'tests/a.test.ts@@test-1', mutantIds: ['1'] }],
        })}\n{ not valid json }\n`);

        const result = await collectLateHits(tempCoverageFile, logger);

        expect(result).toEqual([{ testId: 'tests/a.test.ts@@test-1', mutantIds: ['1'] }]);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('[Stryker Coverage] Failed to parse coverage line:'),
            expect.any(String)
        );
    });
});

describe('cleanupCoverageFile', () => {
    afterEach(() => {
        // Undo this test's fs mock setup and calls
        resetFsMocks();
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
