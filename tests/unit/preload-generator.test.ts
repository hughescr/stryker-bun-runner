/**
 * Unit tests for coverage/preload-generator
 * Tests preload script generation and cleanup
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { generatePreloadScript, cleanupPreloadScript } from '../../src/coverage/preload-generator.js';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('generatePreloadScript', () => {
  let mockMkdir: ReturnType<typeof mock>;
  let mockExistsSync: ReturnType<typeof mock>;
  let mockReadFile: ReturnType<typeof mock>;
  let mockWriteFile: ReturnType<typeof mock>;
  let tempDir: string;
  let coverageFile: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `stryker-test-${Date.now()}`);
    coverageFile = join(tempDir, 'coverage.json');

    // Mock file system operations
    mockMkdir = mock();
    mockExistsSync = mock();
    mockReadFile = mock();
    mockWriteFile = mock();

    spyOn(fs, 'mkdir').mockImplementation(mockMkdir);
    spyOn(fsSync, 'existsSync').mockImplementation(mockExistsSync);
    spyOn(fs, 'readFile').mockImplementation(mockReadFile as any);
    spyOn(fs, 'writeFile').mockImplementation(mockWriteFile as any);

    // Setup default return values
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('// preload script content');
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('directory creation', () => {
    it('should create temp directory if it does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await generatePreloadScript({ tempDir, coverageFile });

      expect(mockMkdir).toHaveBeenCalledWith(tempDir, { recursive: true });
    });

    it('should not create directory if it already exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await generatePreloadScript({ tempDir, coverageFile });

      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('should handle nested directory creation', async () => {
      const nestedTempDir = join(tmpdir(), 'a', 'b', 'c', 'stryker');
      mockExistsSync.mockReturnValue(false);

      await generatePreloadScript({ tempDir: nestedTempDir, coverageFile });

      expect(mockMkdir).toHaveBeenCalledWith(nestedTempDir, { recursive: true });
    });
  });

  describe('template reading and copying', () => {
    it('should read template from templates directory', async () => {
      mockExistsSync.mockReturnValue(true);
      const templateContent = '// preload template';
      mockReadFile.mockResolvedValue(templateContent);

      await generatePreloadScript({ tempDir, coverageFile });

      // Verify readFile was called with path to template
      expect(mockReadFile).toHaveBeenCalled();
      const [templatePath, encoding] = mockReadFile.mock.calls[0];
      expect(templatePath).toContain('templates');
      expect(templatePath).toContain('coverage-preload.ts');
      expect(encoding).toBe('utf-8');
    });

    it('should write template content to temp location', async () => {
      mockExistsSync.mockReturnValue(true);
      const templateContent = '// preload template content';
      mockReadFile.mockResolvedValue(templateContent);

      await generatePreloadScript({ tempDir, coverageFile });

      expect(mockWriteFile).toHaveBeenCalled();
      const [targetPath, content, encoding] = mockWriteFile.mock.calls[0];
      expect(targetPath).toBe(join(tempDir, 'stryker-coverage-preload.ts'));
      expect(content).toBe(templateContent);
      expect(encoding).toBe('utf-8');
    });

    it('should return path to generated preload script', async () => {
      mockExistsSync.mockReturnValue(true);

      const result = await generatePreloadScript({ tempDir, coverageFile });

      expect(result).toBe(join(tempDir, 'stryker-coverage-preload.ts'));
    });
  });

  describe('path resolution', () => {
    it('should resolve template path relative to module location', async () => {
      mockExistsSync.mockReturnValue(true);

      await generatePreloadScript({ tempDir, coverageFile });

      const [templatePath] = mockReadFile.mock.calls[0];
      // Should reference templates/coverage-preload.ts
      expect(templatePath).toContain('templates/coverage-preload.ts');
    });

    it('should generate unique preload script name', async () => {
      mockExistsSync.mockReturnValue(true);

      const result = await generatePreloadScript({ tempDir, coverageFile });

      expect(result).toContain('stryker-coverage-preload.ts');
    });
  });

  describe('error handling', () => {
    it('should propagate error if directory creation fails', async () => {
      mockExistsSync.mockReturnValue(false);
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(
        generatePreloadScript({ tempDir, coverageFile })
      ).rejects.toThrow('Permission denied');
    });

    it('should propagate error if template reading fails', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockRejectedValue(new Error('Template not found'));

      await expect(
        generatePreloadScript({ tempDir, coverageFile })
      ).rejects.toThrow('Template not found');
    });

    it('should propagate error if writing fails', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('// content');
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      await expect(
        generatePreloadScript({ tempDir, coverageFile })
      ).rejects.toThrow('Disk full');
    });
  });

  describe('options handling', () => {
    it('should use provided tempDir', async () => {
      const customTempDir = '/custom/temp/dir';
      mockExistsSync.mockReturnValue(true);

      const result = await generatePreloadScript({
        tempDir: customTempDir,
        coverageFile,
      });

      expect(result).toBe(join(customTempDir, 'stryker-coverage-preload.ts'));
    });

    it('should accept coverageFile option (for runtime use)', async () => {
      mockExistsSync.mockReturnValue(true);

      // coverageFile is stored for runtime use via env var, not injected into template
      await generatePreloadScript({
        tempDir,
        coverageFile: '/custom/coverage.json',
      });

      // Should still generate successfully
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});

describe('cleanupPreloadScript', () => {
  let mockUnlink: ReturnType<typeof mock>;

  beforeEach(() => {
    mockUnlink = mock();
    spyOn(fs, 'unlink').mockImplementation(mockUnlink);
  });

  afterEach(() => {
    mock.restore();
  });

  it('should delete the preload script', async () => {
    mockUnlink.mockResolvedValue(undefined);

    const preloadPath = '/tmp/stryker-coverage-preload.ts';
    await cleanupPreloadScript(preloadPath);

    expect(mockUnlink).toHaveBeenCalledWith(preloadPath);
  });

  it('should not throw error if file does not exist', async () => {
    mockUnlink.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await expect(
      cleanupPreloadScript('/nonexistent/preload.ts')
    ).resolves.toBeUndefined();
  });

  it('should not throw error on permission errors', async () => {
    mockUnlink.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(
      cleanupPreloadScript('/tmp/preload.ts')
    ).resolves.toBeUndefined();
  });

  it('should silently ignore any deletion errors', async () => {
    mockUnlink.mockRejectedValue(new Error('Some random error'));

    await expect(
      cleanupPreloadScript('/tmp/preload.ts')
    ).resolves.toBeUndefined();
  });

  it('should handle multiple cleanup calls', async () => {
    mockUnlink.mockResolvedValue(undefined);

    const preloadPath = '/tmp/preload.ts';
    await cleanupPreloadScript(preloadPath);
    await cleanupPreloadScript(preloadPath);

    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('should handle paths with special characters', async () => {
    mockUnlink.mockResolvedValue(undefined);

    const specialPath = '/tmp/stryker (test) [1]/preload.ts';
    await cleanupPreloadScript(specialPath);

    expect(mockUnlink).toHaveBeenCalledWith(specialPath);
  });
});
