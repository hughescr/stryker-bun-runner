/**
 * How runBunTests hands bun its test files.
 *
 * `bun test` treats a positional argument that is not a path (no leading `/`,
 * `./` or `../`) as a substring FILTER: it runs every discovered test file whose
 * path contains it, in bun's own directory-scan order, whatever the argument
 * order (measured on bun 1.4.2). An explicit path runs exactly that file, and
 * explicit paths run in the order given. So every entry is passed as an
 * absolute path, resolved against the cwd the child runs in.
 */

import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { runBunTests, SPAWN_DEPTH_ENV } from '../../src/process-runner.js';
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
});
