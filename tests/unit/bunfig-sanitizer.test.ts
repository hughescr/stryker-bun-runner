/**
 * Unit tests for src/utils/bunfig-sanitizer
 * Covers sanitization logic for bunfig.toml files used during mutation testing
 */

import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { parse } from 'smol-toml';
import { generateSanitizedBunfig, cleanupSanitizedBunfig } from '../../src/utils/bunfig-sanitizer.js';
import { mockMkdir, mockReadFile, mockWriteFile, mockUnlink, resetFsMocks } from '../test-preload.js';

describe('generateSanitizedBunfig', () => {
    const projectCwd = '/project';
    const tmpDir     = path.join(tmpdir(), 'stryker-test-bunfig');

    beforeEach(() => {
        mockMkdir.mockClear();
        mockReadFile.mockClear();
        mockWriteFile.mockClear();
        mockUnlink.mockClear();

        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        resetFsMocks();
    });

    describe('directory creation', () => {
        it('creates tmpDir with recursive option', async () => {
            mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

            await generateSanitizedBunfig(projectCwd, tmpDir);

            expect(mockMkdir).toHaveBeenCalledWith(tmpDir, { recursive: true });
        });
    });

    describe('no bunfig present', () => {
        beforeEach(() => {
            mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        });

        it('writes a config with only the override keys', async () => {
            await generateSanitizedBunfig(projectCwd, tmpDir);

            expect(mockWriteFile).toHaveBeenCalledTimes(1);
            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;

            const test = parsed.test as Record<string, unknown>;
            expect(test.coverage).toBe(false);
            expect(test.onlyFailures).toBe(false);
        });

        it('does not include [install] when project has no bunfig', async () => {
            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;

            expect(parsed.install).toBeUndefined();
        });

        it('returns path inside tmpDir', async () => {
            const result = await generateSanitizedBunfig(projectCwd, tmpDir);

            expect(result).toStartWith(tmpDir);
            expect(result).toEndWith('.toml');
        });
    });

    describe('preload preservation', () => {
        // Bun resolves relative paths in a bunfig against the file's own directory.
        // Because the sanitized bunfig lives in tmpdir, not projectCwd, relative
        // preload paths must be rewritten to absolute paths anchored at projectCwd
        // or bun will hunt for them in /tmp and silently fail to preload.
        it('rewrites scalar preload string to an absolute path anchored at projectCwd', async () => {
            mockReadFile.mockResolvedValue('[test]\npreload = \'./setup.ts\'\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.preload).toBe(path.resolve(projectCwd, './setup.ts'));
        });

        it('rewrites every entry of an array preload to absolute paths', async () => {
            mockReadFile.mockResolvedValue('[test]\npreload = [\'./a.ts\', \'./b.ts\']\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.preload).toEqual([
                path.resolve(projectCwd, './a.ts'),
                path.resolve(projectCwd, './b.ts'),
            ]);
        });

        it('leaves already-absolute preload paths untouched', async () => {
            mockReadFile.mockResolvedValue('[test]\npreload = \'/etc/preload.ts\'\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.preload).toBe('/etc/preload.ts');
        });

        it('rewrites relative root to an absolute path', async () => {
            mockReadFile.mockResolvedValue('[test]\nroot = \'./src\'\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.root).toBe(path.resolve(projectCwd, './src'));
        });
    });

    describe('coverage and onlyFailures override', () => {
        it('forces coverage = false even when user set coverage = true', async () => {
            mockReadFile.mockResolvedValue('[test]\ncoverage = true\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.coverage).toBe(false);
        });

        it('forces onlyFailures = false even when user set onlyFailures = true', async () => {
            mockReadFile.mockResolvedValue('[test]\nonlyFailures = true\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.onlyFailures).toBe(false);
        });

        it('drops coverageThreshold entirely from sanitized output', async () => {
            mockReadFile.mockResolvedValue(
                '[test]\ncoverage = true\nonlyFailures = true\n\n[test.coverageThreshold]\nlines = 0.95\n'
            );

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.coverageThreshold).toBeUndefined();
            expect(test.coverage).toBe(false);
            expect(test.onlyFailures).toBe(false);
        });
    });

    describe('[install] table', () => {
        it('copies [install] verbatim', async () => {
            mockReadFile.mockResolvedValue(
                '[install]\nregistry = \'https://registry.example.com\'\ncache = \'/tmp/bun-cache\'\n'
            );

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const install = parsed.install as Record<string, unknown>;
            expect(install.registry).toBe('https://registry.example.com');
            expect(install.cache).toBe('/tmp/bun-cache');
        });

        it('does not include install when not in project bunfig', async () => {
            mockReadFile.mockResolvedValue('[test]\npreload = \'./setup.ts\'\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            expect(parsed.install).toBeUndefined();
        });
    });

    describe('non-allowlisted [test] sub-keys are dropped', () => {
        it('drops coverageReporter', async () => {
            mockReadFile.mockResolvedValue('[test]\ncoverageReporter = [\'text\', \'lcov\']\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.coverageReporter).toBeUndefined();
        });

        it('drops coverageDir', async () => {
            mockReadFile.mockResolvedValue('[test]\ncoverageDir = \'./coverage\'\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.coverageDir).toBeUndefined();
        });

        it('drops coverageSkipTestFiles', async () => {
            mockReadFile.mockResolvedValue('[test]\ncoverageSkipTestFiles = true\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.coverageSkipTestFiles).toBeUndefined();
        });
    });

    describe('safe [test] keys are forwarded', () => {
        it('forwards timeout', async () => {
            mockReadFile.mockResolvedValue('[test]\ntimeout = 30_000\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.timeout).toBe(30_000);
        });

        it('forwards root', async () => {
            mockReadFile.mockResolvedValue('[test]\nroot = \'./src\'\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.root).toBe(path.resolve(projectCwd, './src'));
        });

        it('forwards randomize', async () => {
            mockReadFile.mockResolvedValue('[test]\nrandomize = true\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.randomize).toBe(true);
        });
    });

    describe('read errors', () => {
        it('throws with clear message for non-ENOENT read errors', async () => {
            const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
            mockReadFile.mockRejectedValue(err);

            await expect(generateSanitizedBunfig(projectCwd, tmpDir)).rejects.toThrow(
                /Failed to read bunfig\.toml/
            );
        });

        it('does not throw for ENOENT (no bunfig)', async () => {
            mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

            const result = await generateSanitizedBunfig(projectCwd, tmpDir);
            expect(result).toBeTruthy();
        });
    });

    describe('round-trip', () => {
        it('written file can be parsed back and has expected structure', async () => {
            mockReadFile.mockResolvedValue(
                '[install]\nregistry = \'https://registry.npmjs.org\'\n\n[test]\npreload = \'./setup.ts\'\ncoverage = true\nonlyFailures = true\ntimeout = 20_000\n\n[test.coverageThreshold]\nlines = 0.95\n'
            );

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;

            // [install] preserved
            const install = parsed.install as Record<string, unknown>;
            expect(install.registry).toBe('https://registry.npmjs.org');

            // [test] sanitized correctly
            const test = parsed.test as Record<string, unknown>;
            expect(test.coverage).toBe(false);
            expect(test.onlyFailures).toBe(false);
            expect(test.preload).toBe(path.resolve(projectCwd, './setup.ts'));
            expect(test.timeout).toBe(20_000);
            expect(test.coverageThreshold).toBeUndefined();
        });
    });
});

describe('cleanupSanitizedBunfig', () => {
    beforeEach(() => {
        mockUnlink.mockClear();
    });

    afterEach(() => {
        resetFsMocks();
    });

    it('unlinks the file at the given path', async () => {
        mockUnlink.mockResolvedValue(undefined);

        await cleanupSanitizedBunfig('/tmp/sanitized.toml');

        expect(mockUnlink).toHaveBeenCalledWith('/tmp/sanitized.toml');
    });

    it('does not throw when file does not exist (ENOENT)', async () => {
        mockUnlink.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

        const result = cleanupSanitizedBunfig('/tmp/nonexistent.toml');
        await expect(result).resolves.toBeUndefined();
    });

    it('rethrows non-ENOENT errors', async () => {
        mockUnlink.mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

        await expect(cleanupSanitizedBunfig('/tmp/protected.toml')).rejects.toThrow('Permission denied');
    });
});
