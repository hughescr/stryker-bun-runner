/**
 * The coverage preload's eager imports through a real `bun test` child: the dry
 * run (coverage collection) imports every listed module before any test runs,
 * and a mutant run neither imports them nor carries the list in the preload it
 * parses. The list lives in its own file beside the preload, which only the dry
 * run reads, so a mutant run's cost does not grow with the number of mutated
 * files.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanupPreloadScript, eagerModulesFileFor, generatePreloadScript } from '../../src/coverage/preload-generator.js';
import { resetFsMocks } from '../test-preload.js';

const EAGER_SOURCE = [
    'const g = globalThis as unknown as { __eagerImports?: number };',
    'g.__eagerImports = (g.__eagerImports ?? 0) + 1;',
    'export {};',
].join('\n');

/** Records how often the eager module had run by the time the test ran. */
const PROBE_SUITE = [
    "import { test } from 'bun:test';",
    "import { writeFileSync } from 'node:fs';",
    "test('probe', () => {",
    '    const g = globalThis as unknown as { __eagerImports?: number };',
    '    writeFileSync(process.env.EAGER_PROBE_OUT!, String(g.__eagerImports ?? 0));',
    '});',
].join('\n');

describe('eager module imports in a real bun test child', () => {
    let fixture: string;
    let preloadScript: string;

    beforeEach(async () => {
        // Resolved (macOS: /var -> /private/var): the private temp directory check refuses a symlinked ancestor.
        fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'stryker-bun-eager-')));
        await writeFile(path.join(fixture, 'eager.ts'), EAGER_SOURCE);
        await writeFile(path.join(fixture, 'probe.test.ts'), PROBE_SUITE);
        preloadScript = await generatePreloadScript({
            tempDir:      path.join(fixture, 'preload'),
            coverageFile: path.join(fixture, 'coverage.json'),
            eagerModules: [path.join(fixture, 'eager.ts')],
        });
    });

    afterEach(async () => {
        await rm(fixture, { recursive: true, force: true });
        // generatePreloadScript wrote through the shared fs mocks, which record every call.
        resetFsMocks();
    });

    /** Run the probe suite under the preload; resolves to the eager import count the test saw. */
    async function runProbe(preloadEnv: Record<string, string>): Promise<string> {
        const env: Record<string, string | undefined> = { ...process.env };
        // Never inherit an enclosing run's preload variables (this suite may itself run under the runner).
        for(const name of Object.keys(env)) {
            if(name.startsWith('__STRYKER_')) {
                delete env[name];
            }
        }
        const out = path.join(fixture, 'probe.out');
        const child = Bun.spawn([process.execPath, 'test', '--config=/dev/null', '--preload', preloadScript, './probe.test.ts'], {
            cwd:    fixture,
            env:    { ...env, ...preloadEnv, EAGER_PROBE_OUT: out },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [exitCode, stderr] = await Promise.all([child.exited, child.stderr.text()]);
        expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
        return readFile(out, 'utf8');
    }

    it('the dry run imports every listed module once, before the tests run', async () => {
        expect(await runProbe({ __STRYKER_COVERAGE_FILE__: path.join(fixture, 'coverage.json') })).toBe('1');
    }, 30_000);

    it('a mutant run imports none of them, and its preload does not carry the list', async () => {
        expect(await runProbe({ __STRYKER_ACTIVE_MUTANT__: '1', __STRYKER_COVERAGE_FILE__: path.join(fixture, 'coverage.json') })).toBe('0');
        const preloadSource = await readFile(preloadScript, 'utf8');
        expect(preloadSource).not.toContain(path.join(fixture, 'eager.ts'));
        expect(JSON.parse(await readFile(eagerModulesFileFor(preloadScript), 'utf8'))).toEqual([path.join(fixture, 'eager.ts')]);
    }, 30_000);

    it('cleanup removes the list with the preload', async () => {
        await cleanupPreloadScript(preloadScript);
        await expect(readFile(eagerModulesFileFor(preloadScript), 'utf8')).rejects.toThrow();
        await expect(readFile(preloadScript, 'utf8')).rejects.toThrow();
    });
});
