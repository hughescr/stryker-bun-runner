/**
 * Unit tests for coverage/preload-generator
 * Tests preload script generation and cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { generatePreloadScript, cleanupPreloadScript, resolveEagerModulesFromGlobs } from '../../src/coverage/preload-generator.js';
import { mockMkdir, mockReadFile, mockWriteFile, mockUnlink, resetFsMocks } from '../test-preload.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, writeFile as fsWriteFile, rm } from 'node:fs/promises';

describe('generatePreloadScript', () => {
    let tempDir: string;
    let coverageFile: string;

    beforeEach(() => {
        tempDir = join(tmpdir(), `stryker-test-${Date.now()}`);
        coverageFile = join(tempDir, 'coverage.json');

        // Clear the mock state before each test
        mockMkdir.mockClear();
        mockReadFile.mockClear();
        mockWriteFile.mockClear();

        // Setup default return values
        mockMkdir.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue('// preload script content');
        mockWriteFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        // Reset all fs mocks to pass-through state for next test
        resetFsMocks();
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
        it('should replace __PRELOAD_LOGIC_PATH__ placeholder with actual path - line 47 mutation', async () => {
            // Kills mutation on line 47: StringLiteral path change
            // The template placeholder must be replaced with the correct preload-logic.js path
            const templateContent = 'import * as logic from "__PRELOAD_LOGIC_PATH__";\n// rest of template';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({ tempDir, coverageFile });

            // Verify the placeholder was replaced with actual path
            expect(mockWriteFile).toHaveBeenCalled();

            const [, writtenContent] = mockWriteFile.mock.calls[0];

            // The placeholder should be REPLACED, not present in output
            expect(writtenContent).not.toContain('__PRELOAD_LOGIC_PATH__');

            // The actual path should be present and point to preload-logic (extension varies: .ts for source, .js for bundled)
            expect(writtenContent).toMatch(/preload-logic\.(js|ts)/);
            expect(writtenContent).toMatch(/coverage\/preload-logic\.(js|ts)/);
        });

        it('should read template from templates directory', async () => {
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
            const templateContent = '// preload template content';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({ tempDir, coverageFile });

            expect(mockWriteFile).toHaveBeenCalled();

            const [targetPath, content, encoding] = mockWriteFile.mock.calls[0];
            expect(targetPath).toBe(join(tempDir, `stryker-coverage-preload-${process.pid}.ts`));
            expect(content).toBe(templateContent);
            expect(encoding).toBe('utf-8');
        });

        it('should return path to generated preload script', async () => {
            const result = await generatePreloadScript({ tempDir, coverageFile });

            expect(result).toBe(join(tempDir, `stryker-coverage-preload-${process.pid}.ts`));
        });
    });

    describe('path resolution', () => {
        it('should resolve template path relative to module location', async () => {
            await generatePreloadScript({ tempDir, coverageFile });

            const [templatePath] = mockReadFile.mock.calls[0];
            // Should reference templates/coverage-preload.ts
            expect(templatePath).toContain('templates/coverage-preload.ts');
        });

        it('should generate unique preload script name', async () => {
            const result = await generatePreloadScript({ tempDir, coverageFile });

            expect(result).toContain(`stryker-coverage-preload-${process.pid}.ts`);
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

            const [targetPath, content] = mockWriteFile.mock.calls[0];
            expect(targetPath).toBe(join(customTempDir, `stryker-coverage-preload-${process.pid}.ts`));
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

            const [, writtenContent] = mockWriteFile.mock.calls[0];
            expect(writtenContent).toBe(templateContent);
        });
    });

    describe('__EAGER_MODULES__ substitution', () => {
        it('should replace __EAGER_MODULES__ placeholder with empty array when no eagerModules provided', async () => {
            const templateContent = 'const EAGER_MODULES: string[] = __EAGER_MODULES__;\n// rest';
            mockReadFile.mockResolvedValue(templateContent);

            await generatePreloadScript({ tempDir, coverageFile });

            expect(mockWriteFile).toHaveBeenCalled();
            const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string];
            expect(writtenContent).not.toContain('__EAGER_MODULES__');
            expect(writtenContent).toContain('[]');
        });

        it('should replace __EAGER_MODULES__ placeholder with JSON array of provided paths', async () => {
            const templateContent = 'const EAGER_MODULES: string[] = __EAGER_MODULES__;';
            mockReadFile.mockResolvedValue(templateContent);
            const paths = ['/abs/src/a.ts', '/abs/src/b.ts'];

            await generatePreloadScript({ tempDir, coverageFile, eagerModules: paths });

            expect(mockWriteFile).toHaveBeenCalled();
            const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string];
            expect(writtenContent).not.toContain('__EAGER_MODULES__');
            expect(writtenContent).toContain(JSON.stringify(paths));
        });

        it('should produce valid JSON array literal for paths with backslashes', async () => {
            const templateContent = '__EAGER_MODULES__';
            mockReadFile.mockResolvedValue(templateContent);
            // Windows-style paths with backslashes need JSON escaping
            const paths = ['C:\\src\\foo.ts'];

            await generatePreloadScript({ tempDir, coverageFile, eagerModules: paths });

            const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string];
            // JSON.stringify escapes backslashes, so the literal should be parseable
            expect(() => JSON.parse(writtenContent)).not.toThrow();
            expect(JSON.parse(writtenContent)).toEqual(paths);
        });
    });
});

describe('cleanupPreloadScript', () => {
    beforeEach(() => {
        // Clear the mock state before each test
        mockUnlink.mockClear();
    });

    afterEach(() => {
        // Reset all fs mocks to pass-through state for next test
        resetFsMocks();
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

// ============================================================================
// resolveEagerModulesFromGlobs — uses real filesystem via a temp directory
// ============================================================================
describe('resolveEagerModulesFromGlobs', () => {
    let fixtureDir: string;

    // Helper: create a file (and its parent dirs) inside fixtureDir
    const mkfile = async (rel: string): Promise<string> => {
        const abs = join(fixtureDir, rel);
        await mkdir(join(abs, '..'), { recursive: true });
        await fsWriteFile(abs, '// fixture', 'utf-8');
        return abs;
    };

    beforeEach(async () => {
        // Each test gets its own isolated temp directory so tests don't interfere.
        fixtureDir = join(tmpdir(), `stryker-eager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(fixtureDir, { recursive: true });
    });

    afterEach(async () => {
        // Clean up fixture dir
        await rm(fixtureDir, { recursive: true, force: true });
    });

    it('should return empty array for empty mutate globs', async () => {
        const result = await resolveEagerModulesFromGlobs([]);
        expect(result).toEqual([]);
    });

    it('should return empty array for all-negation mutate globs', async () => {
        await mkfile('src/a.ts');
        // Only negation patterns, no positive — nothing to match
        const result = await resolveEagerModulesFromGlobs(['!src/**/*.ts'], fixtureDir);
        expect(result).toEqual([]);
    });

    it('should resolve a basic glob pattern to sorted absolute paths', async () => {
        const absA = await mkfile('src/a.ts');
        const absB = await mkfile('src/b.ts');

        const result = await resolveEagerModulesFromGlobs(['src/**/*.ts'], fixtureDir);

        expect(result).toEqual([resolve(absA), resolve(absB)]);
    });

    it('should sort results ascending by absolute path', async () => {
        // Create files that would be returned in reverse order by some fs implementations
        await mkfile('src/z.ts');
        await mkfile('src/a.ts');
        await mkfile('src/m.ts');

        const result = await resolveEagerModulesFromGlobs(['src/**/*.ts'], fixtureDir);

        const sorted = [...result].sort();
        expect(result).toEqual(sorted);
    });

    it('should handle negation patterns to exclude specific files', async () => {
        const absA = await mkfile('src/a.ts');
        await mkfile('src/b.ts');  // excluded

        const result = await resolveEagerModulesFromGlobs(
            ['src/**/*.ts', '!src/b.ts'],
            fixtureDir
        );

        expect(result).toEqual([resolve(absA)]);
    });

    it('should filter out .d.ts declaration files', async () => {
        const absA = await mkfile('src/a.ts');
        await mkfile('src/a.d.ts');   // excluded (declaration file)
        await mkfile('src/a.d.mts');  // excluded (declaration file)

        const result = await resolveEagerModulesFromGlobs(['src/**/*.ts'], fixtureDir);

        // Only a.ts should be included, not declaration files
        expect(result).toEqual([resolve(absA)]);
    });

    it('should filter out .json files', async () => {
        const absA = await mkfile('src/a.ts');
        await mkfile('src/config.json');

        const result = await resolveEagerModulesFromGlobs(['src/**/*'], fixtureDir);

        // JSON files should be excluded even if glob matches them
        expect(result).toEqual([resolve(absA)]);
    });

    it('should include .tsx files', async () => {
        const absA = await mkfile('src/Component.tsx');

        const result = await resolveEagerModulesFromGlobs(['src/**/*.tsx'], fixtureDir);

        expect(result).toEqual([resolve(absA)]);
    });

    it('should include .js and .mjs files', async () => {
        const absA = await mkfile('src/a.js');
        const absB = await mkfile('src/b.mjs');

        const result = await resolveEagerModulesFromGlobs(['src/**/*.{js,mjs}'], fixtureDir);

        // Both should be included, sorted
        expect(result.map(p => resolve(p))).toEqual([resolve(absA), resolve(absB)].sort());
    });

    it('should strip Stryker mutation-range suffix from glob patterns', async () => {
        const absA = await mkfile('src/a.ts');

        // Stryker mutation-range syntax: src/a.ts:1:3-2:5
        const result = await resolveEagerModulesFromGlobs([`src/a.ts:1:3-2:5`], fixtureDir);

        expect(result).toEqual([resolve(absA)]);
    });

    it('should return empty array when no files match', async () => {
        // No files created
        const result = await resolveEagerModulesFromGlobs(['src/**/*.ts'], fixtureDir);
        expect(result).toEqual([]);
    });

    it('should deduplicate paths when multiple patterns match the same file', async () => {
        const absA = await mkfile('src/a.ts');

        // Two patterns both match a.ts
        const result = await resolveEagerModulesFromGlobs(
            ['src/**/*.ts', 'src/a.ts'],
            fixtureDir
        );

        // tinyglobby deduplicates, so absA should appear only once
        expect(result).toEqual([resolve(absA)]);
    });
});
