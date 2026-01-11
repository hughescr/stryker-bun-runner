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
  });

  afterEach(() => {
    mock.restore();
  });

  describe('successful collection', () => {
    it('should convert array format to Record<string, number> format', async () => {
      const coverageData = {
        perTest: {
          'test-1': ['1', '2', '3'],
          'test-2': ['4', '5'],
        },
        static: ['6', '7'],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

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
      const coverageData = {
        perTest: {},
        static: [],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      expect(result).toBeDefined();
      expect(result?.perTest).toEqual({});
      expect(result?.static).toEqual({});
    });

    it('should handle coverage with only perTest data', async () => {
      const coverageData = {
        perTest: {
          'test-1': ['1', '2'],
        },
        static: [],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      expect(result?.perTest).toEqual({
        'test-1': { '1': 1, '2': 1 },
      });
      expect(result?.static).toEqual({});
    });

    it('should handle coverage with only static data', async () => {
      const coverageData = {
        perTest: {},
        static: ['1', '2', '3'],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      expect(result?.perTest).toEqual({});
      expect(result?.static).toEqual({
        '1': 1,
        '2': 1,
        '3': 1,
      });
    });

    it('should handle multiple tests with overlapping mutant coverage', async () => {
      const coverageData = {
        perTest: {
          'test-1': ['1', '2', '3'],
          'test-2': ['2', '3', '4'],
          'test-3': ['1', '4', '5'],
        },
        static: ['6'],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      expect(result?.perTest).toEqual({
        'test-1': { '1': 1, '2': 1, '3': 1 },
        'test-2': { '2': 1, '3': 1, '4': 1 },
        'test-3': { '1': 1, '4': 1, '5': 1 },
      });
    });

    it('should set all hit counts to 1', async () => {
      const coverageData = {
        perTest: {
          'test-1': ['1', '2', '3', '4', '5'],
        },
        static: ['10', '20'],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      // Verify all hit counts are 1
      const perTestCounts = Object.values(result!.perTest['test-1']);
      expect(perTestCounts.every(count => count === 1)).toBe(true);

      const staticCounts = Object.values(result!.static);
      expect(staticCounts.every(count => count === 1)).toBe(true);
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

    it('should return undefined when JSON is malformed', async () => {
      mockReadFile.mockResolvedValue('{ invalid json }');

      const result = await collectCoverage(tempCoverageFile);

      expect(result).toBeUndefined();
    });

    it('should return undefined when coverage data has wrong structure', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ wrong: 'structure' }));

      const result = await collectCoverage(tempCoverageFile);

      expect(result).toBeUndefined();
    });

    it('should return undefined on read permission error', async () => {
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await collectCoverage(tempCoverageFile);

      expect(result).toBeUndefined();
    });
  });

  describe('data format conversion', () => {
    it('should handle numeric mutant IDs as strings', async () => {
      const coverageData = {
        perTest: {
          'test-1': ['1', '2', '3'],
        },
        static: ['10', '20', '30'],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      // Verify mutant IDs are preserved as strings in the output
      expect(Object.keys(result!.perTest['test-1'])).toEqual(['1', '2', '3']);
      expect(Object.keys(result!.static)).toEqual(['10', '20', '30']);
    });

    it('should handle large numbers of mutants', async () => {
      const mutants = Array.from({ length: 1000 }, (_, i) => String(i));
      const coverageData = {
        perTest: {
          'test-1': mutants,
        },
        static: [],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

      const result = await collectCoverage(tempCoverageFile);

      expect(Object.keys(result!.perTest['test-1'])).toHaveLength(1000);
    });

    it('should handle test IDs with special characters', async () => {
      const coverageData = {
        perTest: {
          'should handle "quotes"': ['1'],
          'should handle spaces': ['2'],
          'should-handle-dashes': ['3'],
        },
        static: [],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(coverageData));

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

  it('should not throw error if file does not exist', async () => {
    mockUnlink.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    // Should not throw
    await expect(cleanupCoverageFile('/nonexistent/coverage.json')).resolves.toBeUndefined();
  });

  it('should not throw error on permission errors', async () => {
    mockUnlink.mockRejectedValue(new Error('EACCES: permission denied'));

    // Should not throw
    await expect(cleanupCoverageFile('/tmp/coverage.json')).resolves.toBeUndefined();
  });

  it('should silently ignore any deletion errors', async () => {
    mockUnlink.mockRejectedValue(new Error('Some random error'));

    // Should not throw
    await expect(cleanupCoverageFile('/tmp/coverage.json')).resolves.toBeUndefined();
  });
});
