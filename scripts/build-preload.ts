/**
 * Builds the coverage preload as ONE plain-JavaScript file.
 *
 *     bun scripts/build-preload.ts <outdir>
 *
 * The source of truth stays TypeScript: src/templates/coverage-preload.ts plus the
 * logic module it imports (src/coverage/preload-logic.ts). Every `bun test` child
 * the runner spawns loads the generated preload, so from a built package it must
 * not have to transpile a TypeScript template and resolve, read and transpile a
 * second module first. This bundles both into `<outdir>/coverage-preload.js`
 * (no minification, so the `__EAGER_MODULES_FILE__` placeholder the generator
 * substitutes per run survives as written). `bun:test` and `node:*` stay as imports.
 *
 * The preload therefore still runs live inside every child, uninstrumented, for the
 * reason stryker.conf.mjs excludes its two sources from mutation.
 */

/* eslint-disable no-console, n/no-process-exit, unicorn/no-process-exit -- a command-line script: usage goes to stderr with a non-zero exit */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const TEMPLATE_SOURCE = path.join(repoRoot, 'src/templates/coverage-preload.ts');
const LOGIC_SOURCE = path.join(repoRoot, 'src/coverage/preload-logic.ts');

/** The import specifier the template uses for the logic module; the generator fills it in for the TypeScript (source) template. */
const LOGIC_PLACEHOLDER = '__PRELOAD_LOGIC_PATH__';
/** The per-run value the generator substitutes into the bundle. */
const EAGER_PLACEHOLDER = '__EAGER_MODULES_FILE__';

/**
 * Bundle the preload into `<outdir>/coverage-preload.js`.
 * @returns the path of the bundle
 */
export async function buildPreloadBundle(outdir: string): Promise<string> {
    await mkdir(outdir, { recursive: true });
    const result = await Bun.build({
        entrypoints: [TEMPLATE_SOURCE],
        outdir,
        naming:      'coverage-preload.js',
        target:      'bun',
        format:      'esm',
        minify:      false,
        plugins:     [{
            name: 'preload-logic-placeholder',
            setup(build) {
                build.onResolve({ filter: new RegExp(`^${LOGIC_PLACEHOLDER}$`) }, () => ({ path: LOGIC_SOURCE }));
            },
        }],
    });
    if(!result.success) {
        throw new AggregateError(result.logs, 'Building the coverage preload bundle failed');
    }
    const bundlePath = path.join(outdir, 'coverage-preload.js');
    const code = await Bun.file(bundlePath).text();
    // The generator substitutes the first occurrence only, so exactly one must remain.
    if(code.split(EAGER_PLACEHOLDER).length !== 2) {
        throw new Error(`Expected exactly one ${EAGER_PLACEHOLDER} in ${bundlePath}`);
    }
    if(code.includes(LOGIC_PLACEHOLDER)) {
        throw new Error(`${LOGIC_PLACEHOLDER} was not bundled into ${bundlePath}`);
    }
    return bundlePath;
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun-only script
if(import.meta.main) {
    const outdir = process.argv[2];
    if(!outdir) {
        console.error('usage: bun scripts/build-preload.ts <outdir>');
        process.exit(64);
    }
    await buildPreloadBundle(path.resolve(outdir));
}
