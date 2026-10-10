/**
 * Unit tests for src/utils/bunfig-sanitizer: what is (and is not) reported as
 * dropped, and how a non-table `test` value is handled.
 */

import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { parse } from 'smol-toml';
import { generateSanitizedBunfig, type DroppedBunfigKey } from '../../src/utils/bunfig-sanitizer.js';
import * as privateTempDir from '../../src/utils/private-temp-dir.js';
import { mockMkdir, mockReadFile, mockWriteFile, resetFsMocks } from '../test-preload.js';

describe('generateSanitizedBunfig dropped-key reporting', () => {
    const projectCwd = '/project';
    const tmpDir     = path.join(tmpdir(), 'stryker-test-bunfig-drops');
    let ensurePrivateDirSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockClear();
        mockWriteFile.mockResolvedValue(undefined);
        ensurePrivateDirSpy = spyOn(privateTempDir, 'ensurePrivateDir').mockImplementation((dir: string) => Promise.resolve(dir));
    });

    afterEach(() => {
        ensurePrivateDirSpy.mockRestore();
        resetFsMocks();
    });

    /** Sanitize `toml`; return what was reported dropped and the parsed sanitized file. */
    async function run(toml: string): Promise<{ drops: DroppedBunfigKey[], written: Record<string, unknown> }> {
        mockReadFile.mockResolvedValue(toml);
        const onDropped = mock<(drops: DroppedBunfigKey[]) => void>();
        await generateSanitizedBunfig(projectCwd, tmpDir, undefined, onDropped);
        expect(onDropped).toHaveBeenCalledTimes(1);
        const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
        return { drops: onDropped.mock.calls[0][0], written: parse(content) };
    }

    it('reports nothing when the bunfig has no [test] section at all', async () => {
        // An absent [test] is not "a [test] that is not a table".
        const { drops, written } = await run('smol = true\n[loader]\n".txt" = "text"\n');

        expect(drops).toEqual([]);
        expect(written.test).toEqual({ coverage: false, onlyFailures: false });
        expect(written.smol).toBe(true);
        expect(written.loader).toEqual({ '.txt': 'text' });
    });

    it('reports nothing for an empty bunfig', async () => {
        const { drops } = await run('');

        expect(drops).toEqual([]);
    });

    it('reports a TOML date given as `test` as not a table, and forwards nothing from it', async () => {
        // smol-toml parses dates to Date subclasses: objects, but not tables.
        const { drops, written } = await run('test = 1979-05-27\n');

        expect(drops).toEqual([{ key: 'test', reason: expect.stringContaining('not a table') as string, warn: false }]);
        expect(written.test).toEqual({ coverage: false, onlyFailures: false });
    });

    it('reports a `test` array as not a table', async () => {
        const { drops, written } = await run('test = [1, 2]\n');

        expect(drops.map(d => d.key)).toEqual(['test']);
        expect(written.test).toEqual({ coverage: false, onlyFailures: false });
    });

    it('rebuilds [test] from scratch even when it is declared before other sections', async () => {
        const { written } = await run('[test]\ntimeout = 5\nretry = 2\n\n[loader]\n".txt" = "text"\n');

        expect(written.test).toEqual({ timeout: 5, coverage: false, onlyFailures: false });
        expect(written.loader).toEqual({ '.txt': 'text' });
    });
});
