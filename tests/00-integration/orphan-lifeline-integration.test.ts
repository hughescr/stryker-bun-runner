/**
 * Orphan prevention through a real process tree: a `bun test` child spawned by
 * the runner exits when the process that spawned it is killed outright, even
 * while the suite it runs has bun's fake timers installed.
 *
 * bun moves a real interval into the fake-timer queue when it ticks while fake
 * timers are installed (bun 1.4.2), where it never fires again on its own. A
 * parent-death check that runs on a timer is therefore lost to any suite that
 * uses fake timers; the runner's lifeline pipe is read without a timer.
 *
 * Real processes, so no fake clock in this file — and no real one either: every
 * wait is on an event. The child reports to this test over a socket it keeps
 * open, so EOF on that socket is the child's death (see lifelineCut).
 */

import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { LIFELINE_FD_ENV } from '../../src/coverage/preload-logic.js';
import { isProcessRunning, lifelineCut, settlesDead } from '../helpers/process-liveness.js';

/**
 * The suite the runner's child runs. It installs fake timers and holds them
 * until it is killed. Before reporting in, it waits until a timer-based parent
 * check, had the preload armed one, would have ticked under those fake timers
 * and been captured (it then shows up in the fake queue), unless the runner
 * has named a lifeline, which needs no timer. Each wait is one macrotask turn
 * (setImmediate, which bun's fake timers leave real).
 */
function fixtureSuite(): string {
    return [
        "import { test, jest } from 'bun:test';",
        "import { connect } from 'node:net';",
        "test('holds fake timers until killed', async () => {",
        '    jest.useFakeTimers();',
        `    while(process.env.${LIFELINE_FD_ENV} === undefined && jest.getTimerCount() === 0) {`,
        '        await new Promise(resolve => setImmediate(resolve));',
        '    }',
        "    const socket = connect(Number(process.env.ORPHAN_REPORT_PORT), '127.0.0.1');",
        // eslint-disable-next-line no-template-curly-in-string -- source text of the fixture, not a template here
        '    socket.write(`${process.pid}\\n`);',
        '    await new Promise(() => {});',
        '}, 600_000);',
    ].join('\n');
}

/** The runner's host process: spawns the fixture suite through runBunTests and waits on it. */
function parentScript(fixture: string, port: number): string {
    const runnerUrl = new URL('../../src/process-runner.ts', import.meta.url).href;
    const generatorUrl = new URL('../../src/coverage/preload-generator.ts', import.meta.url).href;
    return [
        `const { runBunTests } = await import(${JSON.stringify(runnerUrl)});`,
        `const { generatePreloadScript } = await import(${JSON.stringify(generatorUrl)});`,
        `const preloadScript = await generatePreloadScript({ tempDir: ${JSON.stringify(path.join(fixture, 'preload'))}, coverageFile: ${JSON.stringify(path.join(fixture, 'coverage.json'))} });`,
        `process.chdir(${JSON.stringify(fixture)});`,
        `await runBunTests({ bunPath: process.execPath, timeout: 600_000, activeMutant: 'mutant-1', preloadScript, bunfigPath: '/dev/null', testFiles: ['orphan.test.ts'], maxSpawnDepth: 2, env: { ORPHAN_REPORT_PORT: '${port}' } });`,
    ].join('\n');
}

describe('orphan prevention', () => {
    let fixture: string | undefined;
    let server: Server | undefined;
    let parent: ReturnType<typeof Bun.spawn> | undefined;
    let childPid: number | undefined;

    // Runs after a timed-out test too, whose own body never resumes: a child
    // that failed to exit would otherwise outlive this whole test run.
    afterEach(async () => {
        if(childPid !== undefined && isProcessRunning(childPid)) {
            process.kill(childPid, 'SIGKILL');
        }
        parent?.kill('SIGKILL');
        server?.close();
        const dir = fixture;
        fixture = server = parent = childPid = undefined;
        if(dir !== undefined) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('a bun test child exits when its parent is killed while the suite has fake timers installed', async () => {
        fixture = await mkdtemp(path.join(tmpdir(), 'stryker-bun-orphan-'));
        await writeFile(path.join(fixture, 'orphan.test.ts'), fixtureSuite());
        server = createServer();
        const reported = once(server, 'connection') as Promise<[Socket]>;
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;

        parent = Bun.spawn([process.execPath, '--eval', parentScript(fixture, port)], { cwd: fixture, stdout: 'ignore', stderr: 'ignore' });

        const [report] = await reported;
        const [firstLine] = await once(report, 'data') as [Buffer];
        childPid = Number(firstLine.toString().trim());
        const childGone = lifelineCut(report);
        expect(isProcessRunning(childPid)).toBe(true);

        // SIGKILL: the parent runs no cleanup, so only the child itself can notice.
        parent.kill('SIGKILL');
        await parent.exited;

        await childGone;
        expect(await settlesDead(childPid)).toBe(true);
    }, 30_000);
});
