/**
 * Unit tests for bunfig-reader
 * Tests the bunfig.toml configuration reader functionality
 */

import { describe, it, expect, beforeEach, spyOn, type Mock } from 'bun:test';
import { readBunfig, getJunitOutputPath } from '../../src/config/bunfig-reader.js';
import type { BunfigConfig } from '../../src/config/bunfig-reader.js';
import * as fs from 'node:fs';

describe('bunfig-reader', () => {
  let existsSyncSpy: Mock<typeof fs.existsSync>;
  let bunFileSpy: Mock<typeof Bun.file>;
  let tomlParseSpy: Mock<typeof Bun.TOML.parse>;
  let mockFileText: () => Promise<string>;

  beforeEach(() => {
    // Default mock implementations
    mockFileText = async () => '';

    // Spy on fs.existsSync
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);

    // Spy on Bun.file
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(() => ({
      text: mockFileText,
    } as any));

    // Spy on Bun.TOML.parse
    tomlParseSpy = spyOn(Bun.TOML, 'parse').mockReturnValue({});
  });

  describe('readBunfig', () => {
    it('should return undefined when bunfig.toml does not exist', async () => {
      existsSyncSpy.mockReturnValue(false);

      const result = await readBunfig('/test/dir');

      expect(result).toBeUndefined();
      expect(existsSyncSpy).toHaveBeenCalledWith('/test/dir/bunfig.toml');
    });

    it('should return undefined on TOML parse errors', async () => {
      existsSyncSpy.mockReturnValue(true);
      mockFileText = async () => 'invalid toml content [[[';
      bunFileSpy.mockImplementation(() => ({ text: mockFileText } as any));
      tomlParseSpy.mockImplementation(() => {
        throw new Error('TOML parse error');
      });

      const result = await readBunfig('/test/dir');

      expect(result).toBeUndefined();
    });

    it('should return parsed config when file exists and is valid', async () => {
      const mockConfig: BunfigConfig = {
        test: {
          reporter: {
            junit: './reports/junit.xml',
          },
        },
      };

      existsSyncSpy.mockReturnValue(true);
      mockFileText = async () => '[test.reporter]\njunit = "./reports/junit.xml"';
      bunFileSpy.mockImplementation(() => ({ text: mockFileText } as any));
      tomlParseSpy.mockReturnValue(mockConfig);

      const result = await readBunfig('/test/dir');

      expect(result).toEqual(mockConfig);
      expect(bunFileSpy).toHaveBeenCalledWith('/test/dir/bunfig.toml');
    });

    it('should handle empty config file', async () => {
      existsSyncSpy.mockReturnValue(true);
      mockFileText = async () => '';
      bunFileSpy.mockImplementation(() => ({ text: mockFileText } as any));
      tomlParseSpy.mockReturnValue({});

      const result = await readBunfig('/test/dir');

      expect(result).toEqual({});
    });

    it('should parse config with no junit reporter', async () => {
      // This config has test.coverage but no reporter - still a valid BunfigConfig
      // We cast to BunfigConfig since the actual bunfig could have other fields
      const mockConfig = {
        test: {
          coverage: true,
        },
      } as unknown as BunfigConfig;

      existsSyncSpy.mockReturnValue(true);
      mockFileText = async () => '[test]\ncoverage = true';
      bunFileSpy.mockImplementation(() => ({ text: mockFileText } as any));
      tomlParseSpy.mockReturnValue(mockConfig);

      const result = await readBunfig('/test/dir');

      expect(result).toEqual(mockConfig);
    });

    it('should handle file read errors gracefully', async () => {
      existsSyncSpy.mockReturnValue(true);
      mockFileText = async () => { throw new Error('File read error'); };
      bunFileSpy.mockImplementation(() => ({ text: mockFileText } as any));

      const result = await readBunfig('/test/dir');

      expect(result).toBeUndefined();
    });
  });

  describe('getJunitOutputPath', () => {
    it('should return undefined when bunfig is undefined', () => {
      const result = getJunitOutputPath(undefined, '/test/dir');

      expect(result).toBeUndefined();
    });

    it('should return undefined when test.reporter.junit is not set', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {},
        },
      };

      const result = getJunitOutputPath(bunfig, '/test/dir');

      expect(result).toBeUndefined();
    });

    it('should return undefined when test.reporter is not set', () => {
      const bunfig: BunfigConfig = {
        test: {},
      };

      const result = getJunitOutputPath(bunfig, '/test/dir');

      expect(result).toBeUndefined();
    });

    it('should return undefined when test is not set', () => {
      const bunfig: BunfigConfig = {};

      const result = getJunitOutputPath(bunfig, '/test/dir');

      expect(result).toBeUndefined();
    });

    it('should return absolute path as-is when provided', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {
            junit: '/absolute/path/junit.xml',
          },
        },
      };

      const result = getJunitOutputPath(bunfig, '/test/dir');

      expect(result).toBe('/absolute/path/junit.xml');
    });

    it('should resolve relative path against cwd', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {
            junit: './reports/junit.xml',
          },
        },
      };

      const result = getJunitOutputPath(bunfig, '/test/dir');

      expect(result).toBe('/test/dir/reports/junit.xml');
    });

    it('should resolve relative path without leading dot', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {
            junit: 'reports/junit.xml',
          },
        },
      };

      const result = getJunitOutputPath(bunfig, '/test/dir');

      expect(result).toBe('/test/dir/reports/junit.xml');
    });

    it('should handle nested relative paths correctly', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {
            junit: './test-results/coverage/junit.xml',
          },
        },
      };

      const result = getJunitOutputPath(bunfig, '/project/root');

      expect(result).toBe('/project/root/test-results/coverage/junit.xml');
    });

    it('should handle Windows-style absolute paths', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {
            junit: 'C:\\absolute\\path\\junit.xml',
          },
        },
      };

      const result = getJunitOutputPath(bunfig, '/test/dir');

      // On Windows, this should be recognized as absolute
      // On Unix, it will be treated as relative
      // The function should handle both cases correctly
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('should handle parent directory references in relative paths', () => {
      const bunfig: BunfigConfig = {
        test: {
          reporter: {
            junit: '../reports/junit.xml',
          },
        },
      };

      const result = getJunitOutputPath(bunfig, '/test/dir/subdir');

      expect(result).toBe('/test/dir/reports/junit.xml');
    });
  });
});
