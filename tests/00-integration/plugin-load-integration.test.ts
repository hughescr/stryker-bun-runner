/**
 * Loading the built plugin in Node, as every Stryker worker does before its runner's init().
 *
 * Node's ESM view of a builtin (`import ... from 'node:http'`) reads every export of the module
 * to build its namespace, and `http.WebSocket` is a lazy getter that loads Node's bundled undici
 * (with http2). Measured in a Stryker worker (Node 22, 4 vCPUs) that costs about 40 ms of a plugin
 * load of about 100 ms, on the path to the dry run, and the runner never uses either. `require`
 * reads no export, so the runner loads node:http through it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const repoRoot = path.resolve(import.meta.dir, '..', '..');

/** Node modules a Stryker worker would not otherwise load whose presence means an ESM node:http import ran its lazy getters. */
const UNDICI_RE = /undici|http2/;

describe('loading the built plugin in Node', () => {
    let outDir: string;

    beforeAll(async () => {
        // Under node_modules so the bundle's bare imports (ws, smol-toml, ...) resolve to the repo's packages.
        outDir = await mkdtemp(path.join(repoRoot, 'node_modules', '.plugin-load-test-'));
        const built = await Bun.build({
            entrypoints: [path.join(repoRoot, 'src', 'index.ts')],
            outdir:      outDir,
            target:      'node',
            format:      'esm',
            packages:    'external',
        });
        expect(built.success).toBe(true);
    });

    afterAll(async () => {
        await rm(outDir, { recursive: true, force: true });
    });

    test('does not load undici or http2 (no ESM import of node:http)', async () => {
        const entry = path.join(outDir, 'index.js');
        const script = `const plugin = await import(${JSON.stringify(entry)});
console.log(JSON.stringify({ plugins: plugin.strykerPlugins.length, loaded: process.moduleLoadList }));`;
        const proc = Bun.spawn(['node', '--input-type=module', '--eval', script], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- executed only by Bun's integration-test runtime
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        const { plugins, loaded } = JSON.parse(stdout) as { plugins: number, loaded: string[] };
        // The plugin loaded and declared its runner, and node:http itself was loaded (the dry run's sync server needs it).
        expect(plugins).toBe(1);
        expect(loaded).toContain('NativeModule http');
        expect(loaded.filter(name => UNDICI_RE.test(name))).toEqual([]);
    }, 30_000);
});
