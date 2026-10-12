/**
 * The mutant-run copy of the sanitized bunfig.
 *
 * Every sanitized bunfig gets one: mutant runs use it, the dry run uses the
 * sanitized bunfig itself. It differs only in `[test]`:
 *
 * - `onlyFailures = true`, so bun prints no line for a passing, skipped or pending
 *   test (measured on bun 1.4.0 and 1.4.2: the failing tests with their file
 *   headers, bun's summary, the bail line, the zero-match error and unhandled
 *   errors all still print). The dry run keeps `onlyFailures = false`. A
 *   `--only-failures` flag would not do: the sanitized bunfig's explicit
 *   `onlyFailures = false` wins over it.
 * - When the project randomizes: `randomize = false` and no `seed`.
 *   `[test].randomize` shuffles both the order of test files and the order of
 *   tests within each file (measured on bun 1.4.2), and `[test].seed` turns it
 *   on with a fixed seed. The dry run keeps the project's setting, but mutant
 *   runs must run files in the runner's cheapest-first order, so the two keys
 *   are reported as dropped for mutant runs only. There is no bun flag that
 *   turns randomize off.
 */

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { parse } from 'smol-toml';
import { cleanupSanitizedBunfig, generateSanitizedBunfig, mutantRunBunfigPath, type DroppedBunfigKey } from '../../src/utils/bunfig-sanitizer.js';
import * as privateTempDir from '../../src/utils/private-temp-dir.js';
import { mockMkdir, mockReadFile, mockUnlink, mockWriteFile, resetFsMocks } from '../test-preload.js';

const ORDER_REASON = 'kept for the dry run, but mutant runs use a copy of the sanitized bunfig with randomize = false and no seed, '
  + 'so they run test files in the runner\'s cheapest-first order and tests in source order';

describe('mutantRunBunfigPath', () => {
    it('puts .mutant-runs before the .toml extension', () => {
        expect(mutantRunBunfigPath('/tmp/x/stryker-bun-runner-bunfig-1-2.toml')).toBe('/tmp/x/stryker-bun-runner-bunfig-1-2.mutant-runs.toml');
    });

    it('only strips a final .toml', () => {
        expect(mutantRunBunfigPath('/tmp/a.toml.toml')).toBe('/tmp/a.toml.mutant-runs.toml');
        expect(mutantRunBunfigPath('/tmp/a.tomlx')).toBe('/tmp/a.tomlx.mutant-runs.toml');
        expect(mutantRunBunfigPath('/tmp/aXtoml')).toBe('/tmp/aXtoml.mutant-runs.toml');
    });
});

describe('generateSanitizedBunfig: the mutant-run copy', () => {
    const projectCwd = '/project';
    const tmpDir     = path.join(tmpdir(), 'stryker-test-bunfig-mutant-runs');
    let ensurePrivateDirSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        ensurePrivateDirSpy = spyOn(privateTempDir, 'ensurePrivateDir').mockImplementation((dir: string) => Promise.resolve(dir));
    });

    afterEach(() => {
        ensurePrivateDirSpy.mockRestore();
        resetFsMocks();
    });

    interface Outcome {
        outPath: string
        drops:   DroppedBunfigKey[]
        writes:  { file: string, content: Record<string, unknown> }[]
    }

    async function run(toml: string): Promise<Outcome> {
        mockReadFile.mockResolvedValue(toml);
        const onDropped = mock<(drops: DroppedBunfigKey[]) => void>();
        const outPath = await generateSanitizedBunfig(projectCwd, tmpDir, undefined, onDropped);
        const writes = (mockWriteFile.mock.calls as unknown as [string, string][]).map(([file, content]) => ({ file, content: parse(content) }));
        return { outPath, drops: onDropped.mock.calls[0][0], writes };
    }

    it('writes the copy next to the sanitized bunfig, after it, with onlyFailures = true and randomize = false', async () => {
        const { outPath, writes } = await run('[test]\nrandomize = true\ntimeout = 9\n');

        expect(writes.map(w => w.file)).toEqual([outPath, mutantRunBunfigPath(outPath)]);
        expect(writes[0].content.test).toEqual({ randomize: true, timeout: 9, coverage: false, onlyFailures: false });
        expect(writes[1].content.test).toEqual({ randomize: false, timeout: 9, coverage: false, onlyFailures: true });
    });

    it('drops seed from the copy and keeps it in the dry-run bunfig', async () => {
        const { writes } = await run('[test]\nrandomize = true\nseed = 5\n');

        expect(writes[0].content.test).toMatchObject({ randomize: true, seed: 5 });
        expect(writes[1].content.test).toEqual({ randomize: false, coverage: false, onlyFailures: true });
    });

    it('writes the copy for a seed alone', async () => {
        const { writes } = await run('[test]\nseed = 0\n');

        expect(writes).toHaveLength(2);
        expect(writes[1].content.test).toEqual({ randomize: false, coverage: false, onlyFailures: true });
    });

    it('carries every other section into the copy unchanged', async () => {
        const { writes } = await run('define = { X = "1" }\n[loader]\n".txt" = "file"\n[test]\nrandomize = true\npreload = "./p.ts"\n');

        expect(writes[1].content).toEqual({
            define: { X: '1' },
            loader: { '.txt': 'file' },
            test:   { randomize: false, preload: path.resolve(projectCwd, './p.ts'), coverage: false, onlyFailures: true },
        });
    });

    it('reports randomize and seed as dropped for mutant runs only, at debug level', async () => {
        const { drops } = await run('[test]\nrandomize = true\nseed = 5\nretry = 2\n');

        expect(drops.filter(d => d.mutantRunsOnly)).toEqual([
            { key: 'test.randomize', reason: ORDER_REASON, warn: false, mutantRunsOnly: true },
            { key: 'test.seed', reason: ORDER_REASON, warn: false, mutantRunsOnly: true },
        ]);
        expect(drops.find(d => d.key === 'test.retry')?.mutantRunsOnly).toBeUndefined();
    });

    it('writes the copy, differing only in onlyFailures, and reports nothing, for randomize = false', async () => {
        const { outPath, writes, drops } = await run('[test]\nrandomize = false\n');

        expect(writes.map(w => w.file)).toEqual([outPath, mutantRunBunfigPath(outPath)]);
        expect(writes[0].content.test).toEqual({ randomize: false, coverage: false, onlyFailures: false });
        expect(writes[1].content.test).toEqual({ randomize: false, coverage: false, onlyFailures: true });
        expect(drops).toEqual([]);
    });

    it('writes the copy without randomize or seed, and adds neither to it', async () => {
        const { writes, drops } = await run('[install]\nexact = true\n[test]\ntimeout = 1\n');

        expect(writes).toHaveLength(2);
        expect(writes[0].content).toEqual({ install: { exact: true }, test: { timeout: 1, coverage: false, onlyFailures: false } });
        expect(writes[1].content).toEqual({ install: { exact: true }, test: { timeout: 1, coverage: false, onlyFailures: true } });
        expect(drops).toEqual([]);
    });

    it('writes the copy for a project with no bunfig at all', async () => {
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        const outPath = await generateSanitizedBunfig(projectCwd, tmpDir);

        const writes = (mockWriteFile.mock.calls as unknown as [string, string][]).map(([file, content]) => ({ file, content: parse(content) }));
        expect(writes).toEqual([
            { file: outPath, content: { test: { coverage: false, onlyFailures: false } } },
            { file: mutantRunBunfigPath(outPath), content: { test: { coverage: false, onlyFailures: true } } },
        ]);
    });

    it('forces onlyFailures = true into the copy whatever the project set', async () => {
        const { writes } = await run('[test]\nonlyFailures = false\n');

        expect(writes[0].content.test).toEqual({ coverage: false, onlyFailures: false });
        expect(writes[1].content.test).toEqual({ coverage: false, onlyFailures: true });
    });

    it('writes the copy when [test] is not a table', async () => {
        const { writes } = await run('test = 5\n');

        expect(writes).toHaveLength(2);
        expect(writes[1].content.test).toEqual({ coverage: false, onlyFailures: true });
    });
});

describe('cleanupSanitizedBunfig and the mutant-run copy', () => {
    afterEach(() => {
        resetFsMocks();
    });

    it('unlinks the copy too', async () => {
        mockUnlink.mockResolvedValue(undefined);

        await cleanupSanitizedBunfig('/tmp/s.toml');

        expect(mockUnlink.mock.calls).toEqual([['/tmp/s.toml'], ['/tmp/s.mutant-runs.toml']]);
    });

    it('ignores a missing copy', async () => {
        mockUnlink.mockImplementation((file: unknown) => (String(file).endsWith('.mutant-runs.toml')
            ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
            : Promise.resolve()));

        await cleanupSanitizedBunfig('/tmp/s.toml');
    });

    it('still removes the copy when the sanitized bunfig itself is already gone', async () => {
        mockUnlink.mockImplementation((file: unknown) => (String(file).endsWith('.mutant-runs.toml')
            ? Promise.resolve()
            : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))));

        await cleanupSanitizedBunfig('/tmp/s.toml');

        expect(mockUnlink).toHaveBeenCalledWith('/tmp/s.mutant-runs.toml');
    });

    it('rethrows a non-ENOENT failure to remove the copy', async () => {
        mockUnlink.mockImplementation((file: unknown) => (String(file).endsWith('.mutant-runs.toml')
            ? Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))
            : Promise.resolve()));

        const err = await cleanupSanitizedBunfig('/tmp/s.toml').catch((e: unknown) => e);

        expect((err as Error).message).toContain('Permission denied');
    });
});

describe('the mutant-run copy on a real filesystem', () => {
    let root: string;

    beforeEach(async () => {
        root = await realpath(await mkdtemp(path.join(tmpdir(), 'sbr-bunfig-mutant-runs-')));
        await mkdir(path.join(root, 'project'));
        await mkdir(path.join(root, 'private'), { mode: 0o700 });
        await writeFile(path.join(root, 'project', 'bunfig.toml'), '[test]\nrandomize = true\nseed = 3\n', 'utf8');
    });

    afterEach(async () => {
        resetFsMocks();
        await rm(root, { recursive: true, force: true });
    });

    it('is written owner-only, and removed by cleanup', async () => {
        const outPath = await generateSanitizedBunfig(path.join(root, 'project'), path.join(root, 'private'));
        const copy = mutantRunBunfigPath(outPath);

        const { mode } = await stat(copy);
        expect(mode & 0o777).toBe(0o600); // eslint-disable-line no-bitwise -- extracting permission bits
        expect(parse(await readFile(copy, 'utf8'))).toEqual({ test: { randomize: false, coverage: false, onlyFailures: true } });

        await cleanupSanitizedBunfig(outPath);

        expect(await lstat(copy).catch((e: unknown) => (e as NodeJS.ErrnoException).code)).toBe('ENOENT');
        expect(await lstat(outPath).catch((e: unknown) => (e as NodeJS.ErrnoException).code)).toBe('ENOENT');
    });
});
