/**
 * Unit tests for src/utils/bunfig-sanitizer
 * Covers sanitization logic for bunfig.toml files used during mutation testing
 */

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { parse } from 'smol-toml';
import { generateSanitizedBunfig, cleanupSanitizedBunfig, readBunfigTestPreloads, readBunfigTestRoot, type DroppedBunfigKey } from '../../src/utils/bunfig-sanitizer.js';
import * as privateTempDir from '../../src/utils/private-temp-dir.js';
import { mockMkdir, mockReadFile, mockWriteFile, mockUnlink, resetFsMocks } from '../test-preload.js';

describe('generateSanitizedBunfig', () => {
    const projectCwd = '/project';
    const tmpDir     = path.join(tmpdir(), 'stryker-test-bunfig');
    // The directory checks are real-fs syscalls; here the directory is taken as verified
    // (the real checks run in the 'file safety (real filesystem)' tests below).
    let ensurePrivateDirSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockMkdir.mockClear();
        mockReadFile.mockClear();
        mockWriteFile.mockClear();
        mockUnlink.mockClear();

        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        ensurePrivateDirSpy = spyOn(privateTempDir, 'ensurePrivateDir').mockImplementation((dir: string) => Promise.resolve(dir));
    });

    afterEach(() => {
        ensurePrivateDirSpy.mockRestore();
        resetFsMocks();
    });

    /** Sanitize `toml` (as the project bunfig) and return the parsed sanitized file. */
    async function sanitize(toml: string): Promise<Record<string, unknown>> {
        mockReadFile.mockResolvedValue(toml);
        await generateSanitizedBunfig(projectCwd, tmpDir);
        const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
        return parse(written);
    }

    describe('directory creation', () => {
        it('creates/verifies tmpDir as a private directory before writing, like the preload generator', async () => {
            mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

            await generateSanitizedBunfig(projectCwd, tmpDir);

            expect(ensurePrivateDirSpy).toHaveBeenCalledWith(tmpDir);
            expect(ensurePrivateDirSpy.mock.invocationCallOrder[0]).toBeLessThan(mockWriteFile.mock.invocationCallOrder[0]);
            // Never a plain (recursive, unchecked) mkdir
            expect(mockMkdir).not.toHaveBeenCalled();
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
        // Bun resolves relative `preload`/`root` paths against the process cwd, not
        // the bunfig's own directory (measured on bun 1.4.2 with `--config` pointing
        // at a file in another directory). The runner spawns bun with cwd =
        // projectCwd, so those paths would already resolve; they are still rewritten
        // to absolute paths anchored at projectCwd so the sanitized file (in tmpdir)
        // does not depend on the spawn cwd matching.
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

    describe('top-level keys and sections are preserved (bun --config REPLACES the project bunfig)', () => {
        it('keeps the [loader] table (custom extension loaders change what imports resolve to)', async () => {
            const parsed = await sanitize('[loader]\n".foo" = "text"\n".bar" = "json"\n');
            expect(parsed.loader).toEqual({ '.foo': 'text', '.bar': 'json' });
        });

        it('keeps top-level define (compile-time constants the tests rely on)', async () => {
            const parsed = await sanitize('define = { MY_DEF = "\\"defd\\"", "process.env.X" = "\\"1\\"" }\n');
            expect(parsed.define).toEqual({ MY_DEF: '"defd"', 'process.env.X': '"1"' });
        });

        it('keeps jsx* settings', async () => {
            const parsed = await sanitize('jsx = "react"\njsxFactory = "h"\njsxFragment = "Fragment"\njsxImportSource = "preact"\n');
            expect(parsed.jsx).toBe('react');
            expect(parsed.jsxFactory).toBe('h');
            expect(parsed.jsxFragment).toBe('Fragment');
            expect(parsed.jsxImportSource).toBe('preact');
        });

        it('keeps the [macros] table, nested tables included', async () => {
            const parsed = await sanitize('[macros]\n"react-relay" = { graphql = "bun-macro-relay/bun-macro-relay.tsx" }\n');
            expect(parsed.macros).toEqual({ 'react-relay': { graphql: 'bun-macro-relay/bun-macro-relay.tsx' } });
        });

        it('keeps [run], smol, logLevel and telemetry', async () => {
            const parsed = await sanitize('smol = true\nlogLevel = "debug"\ntelemetry = false\n\n[run]\nsilent = true\nbun = true\n');
            expect(parsed.smol).toBe(true);
            expect(parsed.logLevel).toBe('debug');
            expect(parsed.telemetry).toBe(false);
            expect(parsed.run).toEqual({ silent: true, bun: true });
        });

        it('keeps keys it has never heard of, so newer bun settings are not silently lost', async () => {
            const parsed = await sanitize('futureKey = [1, 2]\n\n[futureSection]\nx = "y"\n');
            expect(parsed.futureKey).toEqual([1, 2]);
            expect(parsed.futureSection).toEqual({ x: 'y' });
        });

        it('keeps top-level keys alongside a sanitized [test] (round trip of a mixed file)', async () => {
            const parsed = await sanitize('jsx = "react"\n\n[loader]\n".foo" = "text"\n\n[test]\ntimeout = 5\ncoverage = true\n');
            expect(parsed.jsx).toBe('react');
            expect(parsed.loader).toEqual({ '.foo': 'text' });
            expect(parsed.test).toEqual({ timeout: 5, coverage: false, onlyFailures: false });
        });

        it('keeps [install] verbatim including nested tables', async () => {
            const parsed = await sanitize('[install]\nexact = true\n\n[install.scopes]\n"@acme" = "https://r.example"\n');
            expect(parsed.install).toEqual({ exact: true, scopes: { '@acme': 'https://r.example' } });
        });

        it('does not let a user-supplied top-level key replace the sanitized [test]', async () => {
            // A TOML inline `test = {...}` is the same key as [test]: it is sanitized, not copied.
            const parsed = await sanitize('test = { coverage = true, coverageThreshold = 0.9, timeout = 7 }\n');
            expect(parsed.test).toEqual({ timeout: 7, coverage: false, onlyFailures: false });
        });

        it('keeps a __proto__ key as plain data without touching the prototype', async () => {
            mockReadFile.mockResolvedValue('[__proto__]\npolluted = true\n');
            await generateSanitizedBunfig(projectCwd, tmpDir);
            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            expect(written).toContain('polluted');
        });
    });

    describe('top-level preload', () => {
        // Bun 1.4.2 does not run a top-level `preload` for `bun test` (only [test].preload,
        // then the CLI --preload), but it is preserved and anchored exactly like
        // [test].preload so it still resolves if a bun version starts honouring it.

        it('anchors a scalar relative path at projectCwd', async () => {
            const parsed = await sanitize('preload = "./plugin.ts"\n');
            expect(parsed.preload).toBe(path.resolve(projectCwd, './plugin.ts'));
        });

        it('anchors every entry of an array, keeping order, and leaves absolute paths alone', async () => {
            const parsed = await sanitize('preload = ["./a.ts", "/abs/b.ts", "c.ts"]\n');
            expect(parsed.preload).toEqual([path.resolve(projectCwd, './a.ts'), '/abs/b.ts', path.resolve(projectCwd, 'c.ts')]);
        });

        it('keeps top-level and [test] preloads separate', async () => {
            const parsed = await sanitize('preload = ["./top.ts"]\n\n[test]\npreload = ["./test.ts"]\n');
            expect(parsed.preload).toEqual([path.resolve(projectCwd, './top.ts')]);
            expect((parsed.test as Record<string, unknown>).preload).toEqual([path.resolve(projectCwd, './test.ts')]);
        });

        it('does not add a top-level preload when the project has none', async () => {
            const parsed = await sanitize('[test]\ntimeout = 5\n');
            expect('preload' in parsed).toBe(false);
        });
    });

    describe('dropped-key reporting', () => {
        async function dropsFor(toml: string): Promise<DroppedBunfigKey[]> {
            mockReadFile.mockResolvedValue(toml);
            const onDropped = mock<(drops: DroppedBunfigKey[]) => void>();
            await generateSanitizedBunfig(projectCwd, tmpDir, undefined, onDropped);
            expect(onDropped).toHaveBeenCalledTimes(1);
            return onDropped.mock.calls[0][0];
        }

        it('reports nothing dropped for a bunfig that is entirely forwarded', async () => {
            expect(await dropsFor('jsx = "react"\n\n[test]\ntimeout = 5\n')).toEqual([]);
        });

        it('works without a callback', async () => {
            mockReadFile.mockResolvedValue('[test]\nretry = 2\n');
            const result = await generateSanitizedBunfig(projectCwd, tmpDir);
            expect(result).toBeTruthy();
        });

        it('drops [test].retry, reporting it as a warn-worthy ignored setting with the reason', async () => {
            const drops = await dropsFor('[test]\nretry = 2\n');
            expect(drops).toHaveLength(1);
            expect(drops[0].key).toBe('test.retry');
            expect(drops[0].warn).toBe(true);
            expect(drops[0].reason).toContain('re-runs failing tests');
            expect(drops[0].reason).toContain('killedBy');
        });

        it('drops [test].rerunEach, reporting it as a warn-worthy ignored setting with the reason', async () => {
            const drops = await dropsFor('[test]\nrerunEach = 3\n');
            expect(drops).toHaveLength(1);
            expect(drops[0].key).toBe('test.rerunEach');
            expect(drops[0].warn).toBe(true);
            expect(drops[0].reason).toContain('multiplies');
        });

        it('removes retry and rerunEach from the written file (no retry, no rerun)', async () => {
            mockReadFile.mockResolvedValue('[test]\nretry = 2\nrerunEach = 3\ntimeout = 9\n');
            await generateSanitizedBunfig(projectCwd, tmpDir);
            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const test = (parse(written) as Record<string, unknown>).test as Record<string, unknown>;
            expect('retry' in test).toBe(false);
            expect('rerunEach' in test).toBe(false);
            expect(test.timeout).toBe(9);
        });

        it('reports retry and rerunEach together, in a stable order, alongside other drops', async () => {
            const drops = await dropsFor('[test]\nrerunEach = 3\nretry = 2\ncoverageDir = "./c"\n');
            expect(drops.map(d => d.key).toSorted((a, b) => a.localeCompare(b))).toEqual(['test.coverageDir', 'test.rerunEach', 'test.retry']);
            expect(drops.filter(d => d.warn).map(d => d.key).toSorted((a, b) => a.localeCompare(b))).toEqual(['test.rerunEach', 'test.retry']);
        });

        it.each([
            ['coverageReporter', '[\'text\']', 'coverage'],
            ['coverageDir', '\'./c\'', 'coverage'],
            ['coverageSkipTestFiles', 'true', 'coverage'],
            ['coverageThreshold', '0.9', 'coverage'],
            ['coveragePathIgnorePatterns', '[\'x\']', 'coverage'],
        ])('reports [test].%s as dropped (debug-level, no warn) because coverage is off for mutation runs', async (key, value, word) => {
            const drops = await dropsFor(`[test]\n${key} = ${value}\n`);
            expect(drops).toHaveLength(1);
            expect(drops[0].key).toBe(`test.${key}`);
            expect(drops[0].warn).toBe(false);
            expect(drops[0].reason).toContain(word);
        });

        it('reports an unknown [test] key as dropped with the generic allowlist reason', async () => {
            const drops = await dropsFor('[test]\nconcurrent = true\n');
            expect(drops).toEqual([{ key: 'test.concurrent', reason: expect.stringContaining('allowlist') as string, warn: false }]);
        });

        it('reports forced coverage = true and onlyFailures = true as overridden', async () => {
            const drops = await dropsFor('[test]\ncoverage = true\nonlyFailures = true\n');
            expect(drops.map(d => d.key).toSorted((a, b) => a.localeCompare(b))).toEqual(['test.coverage', 'test.onlyFailures']);
            for(const d of drops) {
                expect(d.warn).toBe(false);
                expect(d.reason).toContain('forced to false');
            }
        });

        it('does not report coverage = false / onlyFailures = false (already what the runner wants)', async () => {
            expect(await dropsFor('[test]\ncoverage = false\nonlyFailures = false\n')).toEqual([]);
        });

        it('reports a [test] that is not a table', async () => {
            const drops = await dropsFor('test = 3\n');
            expect(drops).toEqual([{ key: 'test', reason: expect.stringContaining('not a table') as string, warn: false }]);
        });

        it('treats [test] as an array of tables the same way: not a table, nothing forwarded', async () => {
            const drops = await dropsFor('[[test]]\ntimeout = 1\n');
            expect(drops.map(d => d.key)).toEqual(['test']);
            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            expect((parse(written) as Record<string, unknown>).test).toEqual({ coverage: false, onlyFailures: false });
        });

        it('does not mistake Object.prototype names for allowlisted or ignored keys', async () => {
            const drops = await dropsFor('[test]\ntoString = 1\nconstructor = 2\n');
            expect(drops.map(d => [d.key, d.warn])).toEqual([['test.toString', false], ['test.constructor', false]]);
        });

        it('does not report forwarded [test] keys', async () => {
            expect(await dropsFor('[test]\npreload = "./a.ts"\nroot = "./src"\npathIgnorePatterns = ["x"]\ntimeout = 1\nsmol = true\nrandomize = true\nseed = 1\n')).toEqual([]);
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

        it('forwards smol', async () => {
            // Kills StringLiteral mutant 1353: 'smol' → "" in SAFE_TEST_KEYS
            mockReadFile.mockResolvedValue('[test]\nsmol = true\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.smol).toBe(true);
        });

        it('forwards pathIgnorePatterns', async () => {
            // Kills StringLiteral mutant 1351: 'pathIgnorePatterns' → "" in SAFE_TEST_KEYS
            mockReadFile.mockResolvedValue('[test]\npathIgnorePatterns = [\'dist\', \'node_modules\']\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.pathIgnorePatterns).toEqual(['dist', 'node_modules']);
        });

        it('forwards seed', async () => {
            mockReadFile.mockResolvedValue('[test]\nseed = 42\n');

            await generateSanitizedBunfig(projectCwd, tmpDir);

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as Record<string, unknown>;
            const test = parsed.test as Record<string, unknown>;
            expect(test.seed).toBe(42);
        });
    });

    describe('read errors', () => {
        it('throws with clear message for non-ENOENT read errors', async () => {
            const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
            mockReadFile.mockRejectedValue(err);

            const err2 = await generateSanitizedBunfig(projectCwd, tmpDir).catch((e: unknown) => e);
            expect((err2 as Error).message).toMatch(/Failed to read bunfig\.toml/);
        });

        it('does not throw for ENOENT (no bunfig)', async () => {
            mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

            const result = await generateSanitizedBunfig(projectCwd, tmpDir);
            expect(result).toBeTruthy();
        });
    });

    describe('explicit source bunfig (bun.bunArgs --config)', () => {
        it('reads the given file, resolved against the project cwd, instead of <cwd>/bunfig.toml', async () => {
            mockReadFile.mockResolvedValue('[test]\ntimeout = 99\n');

            await generateSanitizedBunfig(projectCwd, tmpDir, './config/ci.toml');

            expect(mockReadFile).toHaveBeenCalledTimes(1);
            expect(mockReadFile.mock.calls[0][0]).toBe('/project/config/ci.toml');
        });

        it('uses an absolute source path as-is', async () => {
            mockReadFile.mockResolvedValue('');

            await generateSanitizedBunfig(projectCwd, tmpDir, '/etc/ci.toml');

            expect(mockReadFile.mock.calls[0][0]).toBe('/etc/ci.toml');
        });

        it('sanitizes the given file exactly like the default one (allowlist, forced overrides, absolute paths)', async () => {
            mockReadFile.mockResolvedValue(
                '[install]\nexact = true\n\n[test]\npreload = "./setup.ts"\ntimeout = 99\ncoverage = true\nonlyFailures = true\ncoverageThreshold = 0.9\n'
            );

            await generateSanitizedBunfig(projectCwd, tmpDir, 'ci.toml');

            const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
            const parsed = parse(written) as { install: Record<string, unknown>, test: Record<string, unknown> };
            expect(parsed.install.exact).toBe(true);
            expect(parsed.test.timeout).toBe(99);
            expect(parsed.test.preload).toBe('/project/setup.ts');
            expect(parsed.test.coverage).toBe(false);
            expect(parsed.test.onlyFailures).toBe(false);
            expect(parsed.test.coverageThreshold).toBeUndefined();
        });

        it('fails clearly when the given file does not exist (unlike the optional default bunfig)', async () => {
            mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));

            const err = await generateSanitizedBunfig(projectCwd, tmpDir, 'missing.toml').catch((e: unknown) => e);

            expect((err as Error).message).toContain('/project/missing.toml');
            expect((err as Error).message).toContain('--config');
            expect(mockWriteFile).not.toHaveBeenCalled();
        });

        it('fails clearly when the given file cannot be parsed', async () => {
            mockReadFile.mockResolvedValue('[test\nbroken');

            const err = await generateSanitizedBunfig(projectCwd, tmpDir, 'bad.toml').catch((e: unknown) => e);

            expect((err as Error).message).toContain('/project/bad.toml');
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

describe('readBunfigTestRoot', () => {
    afterEach(() => {
        resetFsMocks();
    });

    it('resolves a relative [test].root against the project cwd', async () => {
        mockReadFile.mockResolvedValue('[test]\nroot = "./src"\n');
        expect(await readBunfigTestRoot('/project')).toBe('/project/src');
    });

    it('keeps an absolute root as-is', async () => {
        mockReadFile.mockResolvedValue('[test]\nroot = "/elsewhere/tests"\n');
        expect(await readBunfigTestRoot('/project')).toBe('/elsewhere/tests');
    });

    it('returns undefined when there is no bunfig', async () => {
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        expect(await readBunfigTestRoot('/project')).toBeUndefined();
    });

    it('returns undefined when [test] has no root, no [test] table exists, or root is not a string', async () => {
        mockReadFile.mockResolvedValue('[test]\ntimeout = 5\n');
        expect(await readBunfigTestRoot('/project')).toBeUndefined();
        mockReadFile.mockResolvedValue('[install]\nexact = true\n');
        expect(await readBunfigTestRoot('/project')).toBeUndefined();
        mockReadFile.mockResolvedValue('test = 3\n');
        expect(await readBunfigTestRoot('/project')).toBeUndefined();
        mockReadFile.mockResolvedValue('[test]\nroot = 5\n');
        expect(await readBunfigTestRoot('/project')).toBeUndefined();
    });

    it('reads [test].root from an explicit source bunfig, still resolved against the project cwd', async () => {
        mockReadFile.mockResolvedValue('[test]\nroot = "./spec"\n');
        expect(await readBunfigTestRoot('/project', 'config/ci.toml')).toBe('/project/spec');
        expect(mockReadFile.mock.calls.at(-1)?.[0]).toBe('/project/config/ci.toml');
    });

    it('throws when an explicit source bunfig does not exist', async () => {
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        const err = await readBunfigTestRoot('/project', 'nope.toml').catch((e: unknown) => e);
        expect((err as Error).message).toContain('/project/nope.toml');
    });

    it('throws a clear error for non-ENOENT read errors', async () => {
        mockReadFile.mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
        const err = await readBunfigTestRoot('/project').catch((e: unknown) => e);
        expect((err as Error).message).toMatch(/Failed to read bunfig\.toml/);
    });
});

describe('readBunfigTestPreloads', () => {
    afterEach(() => {
        resetFsMocks();
    });

    it('resolves a single [test].preload string against the project cwd', async () => {
        mockReadFile.mockResolvedValue('[test]\npreload = "./tests/setup.ts"\n');
        expect(await readBunfigTestPreloads('/project')).toEqual(['/project/tests/setup.ts']);
    });

    it('resolves every entry of a [test].preload array, keeping absolute ones and their order', async () => {
        mockReadFile.mockResolvedValue('[test]\npreload = ["./b.ts", "/abs/a.ts"]\n');
        expect(await readBunfigTestPreloads('/project')).toEqual(['/project/b.ts', '/abs/a.ts']);
    });

    it('skips entries that are not strings', async () => {
        mockReadFile.mockResolvedValue('[test]\npreload = ["./ok.ts", 5, ["./nested.ts"]]\n');
        expect(await readBunfigTestPreloads('/project')).toEqual(['/project/ok.ts']);
    });

    it('ignores a top-level preload, which bun test does not run', async () => {
        mockReadFile.mockResolvedValue('preload = "./top.ts"\n');
        expect(await readBunfigTestPreloads('/project')).toEqual([]);
    });

    it('returns an empty list without a bunfig, a [test] table, or a preload', async () => {
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        expect(await readBunfigTestPreloads('/project')).toEqual([]);
        mockReadFile.mockResolvedValue('[install]\nexact = true\n');
        expect(await readBunfigTestPreloads('/project')).toEqual([]);
        mockReadFile.mockResolvedValue('[test]\ntimeout = 5\n');
        expect(await readBunfigTestPreloads('/project')).toEqual([]);
    });

    it('reads an explicit source bunfig, still resolving against the project cwd', async () => {
        mockReadFile.mockResolvedValue('[test]\npreload = "./setup.ts"\n');
        expect(await readBunfigTestPreloads('/project', 'config/ci.toml')).toEqual(['/project/setup.ts']);
        expect(mockReadFile.mock.calls.at(-1)?.[0]).toBe('/project/config/ci.toml');
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

        await cleanupSanitizedBunfig('/tmp/nonexistent.toml');
    });

    it('rethrows non-ENOENT errors', async () => {
        mockUnlink.mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

        const err = await cleanupSanitizedBunfig('/tmp/protected.toml').catch((e: unknown) => e);
        expect((err as Error).message).toContain('Permission denied');
    });
});

describe('generateSanitizedBunfig file safety (real filesystem)', () => {
    const FROZEN_NOW = 1_700_000_000_000;
    let root: string;
    let projectCwd: string;
    let privateDir: string;

    beforeEach(async () => {
        // Pass-through fs mocks: these tests exercise the kernel's modes and symlinks.
        resetFsMocks();
        // Resolved: the directory checks refuse a symlink above the directory (macOS's /var -> /private/var).
        root = await realpath(await mkdtemp(path.join(tmpdir(), 'sbr-bunfig-safety-')));
        projectCwd = path.join(root, 'project');
        privateDir = path.join(root, 'private');
        await mkdir(projectCwd, { recursive: true });
        await mkdir(privateDir, { mode: 0o700 });
        await writeFile(path.join(projectCwd, 'bunfig.toml'), '[test]\ntimeout = 5000\n', 'utf8');
    });

    afterEach(async () => {
        resetFsMocks();
        await rm(root, { recursive: true, force: true });
    });

    it('writes the sanitized bunfig with mode 0600', async () => {
        const outPath = await generateSanitizedBunfig(projectCwd, privateDir);

        const { mode } = await stat(outPath);
        expect(mode & 0o777).toBe(0o600); // eslint-disable-line no-bitwise -- extracting permission bits
        expect(parse(await readFile(outPath, 'utf8'))).toMatchObject({ test: { timeout: 5000 } });
    });

    it('replaces a symlink planted at the output path instead of writing through it', async () => {
        const nowSpy = spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
        try {
            const victim = path.join(root, 'victim.txt');
            await writeFile(victim, 'untouched', 'utf8');
            const outPath = path.join(privateDir, `stryker-bun-runner-bunfig-${process.pid}-${FROZEN_NOW}.toml`);
            await symlink(victim, outPath);

            const result = await generateSanitizedBunfig(projectCwd, privateDir);

            expect(result).toBe(outPath);
            const planted = await lstat(outPath);
            expect(planted.isSymbolicLink()).toBe(false);
            expect(await readFile(victim, 'utf8')).toBe('untouched');
            expect(parse(await readFile(outPath, 'utf8'))).toMatchObject({ test: { timeout: 5000 } });
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('creates an absent tmpDir with mode 0700', async () => {
        const fresh = path.join(root, 'fresh');

        const outPath = await generateSanitizedBunfig(projectCwd, fresh);

        expect(path.dirname(outPath)).toBe(fresh);
        const { mode } = await lstat(fresh);
        expect(mode & 0o777).toBe(0o700); // eslint-disable-line no-bitwise -- extracting permission bits
    });

    it('refuses a tmpDir other users can access, writing nothing into it', async () => {
        await chmod(privateDir, 0o755);

        const err = await generateSanitizedBunfig(projectCwd, privateDir).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(privateTempDir.UnsafeTempDirError);
        expect(await readdir(privateDir)).toEqual([]);
    });
});
