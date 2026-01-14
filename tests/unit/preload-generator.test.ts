/**
 * Unit tests for coverage/preload-generator
 * Tests preload script generation and cleanup
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { generatePreloadScript, cleanupPreloadScript } from '../../src/coverage/preload-generator.js';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('generatePreloadScript', () => {
    let mockMkdir: ReturnType<typeof mock>;
    let mockReadFile: ReturnType<typeof mock>;
    let mockWriteFile: ReturnType<typeof mock>;
    let tempDir: string;
    let coverageFile: string;

    beforeEach(() => {
        tempDir = join(tmpdir(), `stryker-test-${Date.now()}`);
        coverageFile = join(tempDir, 'coverage.json');

        // Mock file system operations
        mockMkdir = mock();
        mockReadFile = mock();
        mockWriteFile = mock();

        spyOn(fs, 'mkdir').mockImplementation(mockMkdir);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock function requires any type
        spyOn(fs, 'readFile').mockImplementation(mockReadFile as any);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock function requires any type
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
        it('should create temp directory with recursive option', async () => {
            await generatePreloadScript({ tempDir, coverageFile });

            expect(mockMkdir).toHaveBeenCalledWith(tempDir, { recursive: true });
        });

        it('should handle nested directory creation', async () => {
            const nestedTempDir = join(tmpdir(), 'a', 'b', 'c', 'stryker');

            await generatePreloadScript({ tempDir: nestedTempDir, coverageFile });

            expect(mockMkdir).toHaveBeenCalledWith(nestedTempDir, { recursive: true });
        });
    });

    describe('template reading and copying', () => {
        it('should read template from templates directory', async () => {
            const templateContent = '// preload template';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({ tempDir, coverageFile });

            // Verify readFile was called with path to template
            expect(mockReadFile).toHaveBeenCalled();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call data
            const [templatePath, encoding] = mockReadFile.mock.calls[0];
            expect(templatePath).toContain('templates');
            expect(templatePath).toContain('coverage-preload.ts');
            expect(encoding).toBe('utf-8');
        });

        it('should write template content to temp location', async () => {
            const templateContent = '// preload template content';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({ tempDir, coverageFile });

            expect(mockWriteFile).toHaveBeenCalled();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call data
            const [targetPath, content, encoding] = mockWriteFile.mock.calls[0];
            expect(targetPath).toBe(join(tempDir, 'stryker-coverage-preload.ts'));
            expect(content).toBe(templateContent);
            expect(encoding).toBe('utf-8');
        });

        it('should return path to generated preload script', async () => {
            const result = await generatePreloadScript({ tempDir, coverageFile });

            expect(result).toBe(join(tempDir, 'stryker-coverage-preload.ts'));
        });
    });

    describe('path resolution', () => {
        it('should resolve template path relative to module location', async () => {
            await generatePreloadScript({ tempDir, coverageFile });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call data
            const [templatePath] = mockReadFile.mock.calls[0];
            // Should reference templates/coverage-preload.ts
            expect(templatePath).toContain('templates/coverage-preload.ts');
        });

        it('should generate unique preload script name', async () => {
            const result = await generatePreloadScript({ tempDir, coverageFile });

            expect(result).toContain('stryker-coverage-preload.ts');
        });
    });

    describe('error handling', () => {
        it('should propagate error if directory creation fails', async () => {
            mockMkdir.mockRejectedValue(new Error('Permission denied'));

            await expect(
                generatePreloadScript({ tempDir, coverageFile })
            ).rejects.toThrow('Permission denied');
        });

        it('should propagate error if template reading fails', async () => {
            mockReadFile.mockRejectedValue(new Error('Template not found'));

            await expect(
                generatePreloadScript({ tempDir, coverageFile })
            ).rejects.toThrow('Template not found');
        });

        it('should propagate error if writing fails', async () => {
            mockReadFile.mockResolvedValue('// content');
            mockWriteFile.mockRejectedValue(new Error('Disk full'));

            await expect(
                generatePreloadScript({ tempDir, coverageFile })
            ).rejects.toThrow('Disk full');
        });
    });

    describe('options handling', () => {
        it('should write preload script to custom tempDir', async () => {
            const customTempDir = '/custom/temp/dir';
            const templateContent = '// preload template';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({
                tempDir: customTempDir,
                coverageFile,
            });

            // Verify the script is actually written to the custom directory
            expect(mockWriteFile).toHaveBeenCalled();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call data
            const [targetPath, content] = mockWriteFile.mock.calls[0];
            expect(targetPath).toBe(join(customTempDir, 'stryker-coverage-preload.ts'));
            expect(content).toBe(templateContent);
        });

        it('should not inject coverageFile path into template content', async () => {
            const templateContent = '// preload template without coverage path';
            mockReadFile.mockResolvedValue(templateContent);

            // coverageFile is provided at runtime via env var, not injected into template
            await generatePreloadScript({
                tempDir,
                coverageFile: '/custom/coverage.json',
            });

            // Verify template content is written unchanged (coverageFile NOT injected)
            expect(mockWriteFile).toHaveBeenCalled();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call data
            const [, writtenContent] = mockWriteFile.mock.calls[0];
            expect(writtenContent).toBe(templateContent);
            expect(writtenContent).not.toContain('/custom/coverage.json');
        });

        it('should write template content unchanged', async () => {
            const templateContent = '// preload template\nconsole.log("test");';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({
                tempDir,
                coverageFile,
            });

            // Verify template content is written unchanged
            expect(mockWriteFile).toHaveBeenCalled();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call data
            const [, writtenContent] = mockWriteFile.mock.calls[0];
            expect(writtenContent).toBe(templateContent);
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
