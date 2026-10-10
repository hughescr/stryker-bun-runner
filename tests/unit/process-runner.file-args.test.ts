/**
 * How runBunTests hands bun its test files.
 *
 * `bun test` treats a positional argument that is not a path (no leading `/`,
 * `./` or `../`) as a substring FILTER: it runs every discovered test file whose
 * path contains it, in bun's own directory-scan order, whatever the argument
 * order (measured on bun 1.4.2). An explicit path runs exactly that file, and
 * explicit paths run in the order given. So every entry is passed as an
 * absolute path, resolved against the cwd the child runs in, unless the list is
 * too long for the argv budget (see utils/test-file-args), in which case the
 * entries are `./`-relative paths, which bun also takes as paths.
 */

import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { runBunTests, SPAWN_DEPTH_ENV } from '../../src/process-runner.js';
import { MAX_TEST_FILE_ARGS_BYTES } from '../../src/utils/test-file-args.js';
import { mockSpawn, resetChildProcessMocks, resetProcessGroupMocks } from '../test-preload.js';

describe('runBunTests test-file arguments', () => {
    let closeHandler: ((code: number | null) => void) | undefined;
    let ambientSpawnDepth: string | undefined;

    beforeEach(() => {
        ambientSpawnDepth = process.env[SPAWN_DEPTH_ENV];
        delete process.env[SPAWN_DEPTH_ENV];
        const stream = { on: mock() };
        const child = {
            stdout: stream,
            stderr: stream,
            on:     mock((event: string, handler: (code: number | null) => void) => {
                if(event === 'close') {
                    closeHandler = handler;
                }
                return child;
            }),
            kill: mock(() => true),
            pid:  12_345,
        };
        mockSpawn.mockClear();
        mockSpawn.mockImplementation(() => child as unknown as ChildProcess);
    });

    afterEach(() => {
        if(ambientSpawnDepth === undefined) {
            delete process.env[SPAWN_DEPTH_ENV];
        } else {
            process.env[SPAWN_DEPTH_ENV] = ambientSpawnDepth;
        }
        resetChildProcessMocks();
        resetProcessGroupMocks();
    });

    async function argvFor(testFiles: string[]): Promise<readonly string[]> {
        const result = runBunTests({ bunPath: 'bun', timeout: 5000, bail: true, testFiles });
        closeHandler?.(0);
        await result;
        return mockSpawn.mock.calls[0][1];
    }

    it('passes relative files as absolute paths, resolved against the cwd, in the given order', async () => {
        const argv = await argvFor(['tests/unit/z.test.ts', 'tests/00-integration/a.test.ts']);

        expect(argv).toEqual(['test', '--bail', path.join(process.cwd(), 'tests/unit/z.test.ts'), path.join(process.cwd(), 'tests/00-integration/a.test.ts')]);
    });

    it('passes absolute files unchanged', async () => {
        expect(await argvFor(['/elsewhere/x.test.ts'])).toEqual(['test', '--bail', '/elsewhere/x.test.ts']);
    });

    it('normalizes ./ and ../ entries to the same absolute paths', async () => {
        const argv = await argvFor(['./tests/a.test.ts', '../b.test.ts']);

        expect(argv.slice(2)).toEqual([path.resolve('tests/a.test.ts'), path.resolve('..', 'b.test.ts')]);
    });

    describe('a list too long for the argv budget', () => {
        const nameOf = (i: number): string => `tests/gen/f${String(i).padStart(5, '0')}.test.ts`;
        // The smallest list whose absolute spelling is over the budget; its ./ spelling is far under it.
        const absoluteCost = path.resolve(nameOf(0)).length + 9;
        const overBudget = Array.from({ length: Math.floor(MAX_TEST_FILE_ARGS_BYTES / absoluteCost) + 1 }, (_, i) => nameOf(i));

        it('passes the entries as ./ paths, still in the given order', async () => {
            const argv = await argvFor(overBudget);

            expect(argv.slice(2)).toEqual(overBudget.map(file => `./${file}`));
        });

        it('passes the absolute paths for a list one entry shorter', async () => {
            const argv = await argvFor(overBudget.slice(1));

            expect(argv.slice(2)).toEqual(overBudget.slice(1).map(file => path.resolve(file)));
        });
    });
});
