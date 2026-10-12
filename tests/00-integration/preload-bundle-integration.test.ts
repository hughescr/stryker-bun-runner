/**
 * The prebuilt coverage preload (scripts/build-preload.ts): one plain-JavaScript file with the
 * logic inlined, loaded by a real `bun test` child exactly as the built package would load it.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { buildPreloadBundle } from '../../scripts/build-preload.js';
import { generatePreloadScript } from '../../src/coverage/preload-generator.js';
import { HIT_LIMIT_TOKEN_ENV } from '../../src/coverage/preload-logic.js';
import { resetFsMocks } from '../test-preload.js';

/** A module the preload must import eagerly: its top-level code runs before any test, so it records into the static bucket. */
const EAGER_MODULE = `globalThis.__stryker__.mutantCoverage.static.eagerMutant = 1;
export const eager = true;
`;

/** Checks, from inside the child, what the preload did to it. */
const SUITE = String.raw`import { test, expect, describe } from 'bun:test';
test('the preload ran', () => {
    const ns = (globalThis as any).__stryker__;
    // Section 2: the namespace and the per-test id exist.
    expect(ns.currentTestId).toMatch(/preload-bundle\.test\.ts@@test-1$/);
    ns.mutantCoverage.perTest[ns.currentTestId].testMutant = 1;
    // Section 0 / top of the preload: the hit-limit token is hidden from the tests.
    expect(process.env.${HIT_LIMIT_TOKEN_ENV}).toBeUndefined();
    // .concurrent is patched to sequential.
    expect((describe as any).concurrent).toBe(describe);
    expect((test as any).concurrent).toBe(test);
});
`;

describe('prebuilt single-file preload (real bun child)', () => {
    let root: string;
    let bundleDir: string;
    let bundlePath: string;

    beforeAll(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'stryker-preload-bundle-'));
        bundleDir = path.join(root, 'dist', 'templates');
        bundlePath = await buildPreloadBundle(bundleDir);
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
        resetFsMocks();
    });

    afterEach(() => {
        resetFsMocks();
    });

    test('is a single JavaScript file that imports nothing relative and no other TypeScript', async () => {
        const code = await readFile(bundlePath, 'utf8');

        expect(bundlePath).toBe(path.join(bundleDir, 'coverage-preload.js'));
        const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(code).map(entry => entry.path);
        expect(imports).toContain('bun:test');
        // Only bun:test and node builtins: no relative or absolute path is left to resolve, read and transpile.
        for(const specifier of imports) {
            expect(specifier === 'bun:test' || !/^[./]/.test(specifier)).toBe(true);
        }
        expect(code).not.toContain('__PRELOAD_LOGIC_PATH__');
        expect(code.split('__EAGER_MODULES__')).toHaveLength(2);
    });

    test('collects coverage in a child when generated from the built layout and loaded as JavaScript', async () => {
        const work = path.join(root, 'collect');
        const eagerPath = path.join(work, 'eager.js');
        const coverageFile = path.join(work, 'coverage.json');
        await mkdir(work);
        // The generator reads dist/templates/coverage-preload.js relative to the module directory it is given.
        // None of a surrounding Stryker run's settings (sync port, active mutant, ...) may reach the child.
        const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('__STRYKER')));
        const preloadPath = await generatePreloadScript(
            { tempDir: path.join(work, 'preload'), coverageFile, eagerModules: [eagerPath] },
            path.join(root, 'dist')
        );
        await writeFile(eagerPath, EAGER_MODULE);
        await writeFile(path.join(work, 'preload-bundle.test.ts'), SUITE);

        const child = Bun.spawn([process.execPath, 'test', '--preload', preloadPath, 'preload-bundle.test.ts'], {
            cwd:    work,
            env:    { ...plainEnv, __STRYKER_COVERAGE_FILE__: coverageFile, [HIT_LIMIT_TOKEN_ENV]: 'secret-token' },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);

        expect({ exitCode, output: `${stdout}\n${stderr}` }).toMatchObject({ exitCode: 0 });
        expect(preloadPath.endsWith('.js')).toBe(true);
        const writtenText = await readFile(coverageFile, 'utf8');
        const written = JSON.parse(writtenText.trim()) as { 'static': Record<string, number>, perTest: Record<string, Record<string, number>> };
        expect(written.static).toEqual({ eagerMutant: 1 });
        expect(Object.entries(written.perTest)).toEqual([[expect.stringMatching(/preload-bundle\.test\.ts@@test-1$/), { testMutant: 1 }]]);
    }, 30_000);
});
