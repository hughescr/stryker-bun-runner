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
 *
 * Bun 1.4.0 emits a net server's 'listening' from a 1 ms timer of its own, so
 * timers scheduled outside tests/ run on real time in this file; a timer the
 * test itself schedules still fails it.
 */

import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { LIFELINE_FD_ENV } from '../../src/coverage/preload-logic.js';
import { isProcessRunning, lifelineCut } from '../helpers/process-liveness.js';
import { allowRealTimersFromSource } from '../real-clock-guard.js';
import { resetFsMocks } from '../test-preload.js';

allowRealTimersFromSource();

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

/** How much of the host's stderr to keep for the failure report. */
const STDERR_TAIL_CHARS = 4000;

/**
 * Keeps the last STDERR_TAIL_CHARS characters of `stream`. `done` settles once
 * the stream ends (the host's stderr closes when it exits, as nothing else
 * holds it open: the runner gives its child pipes of its own).
 */
function captureTail(stream: AsyncIterable<Uint8Array>): { tail: () => string, done: Promise<void> } {
    const decoder = new TextDecoder();
    let tail = '';
    const done = (async () => {
        for await (const chunk of stream) {
            tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
        }
    })().catch(() => {
        // The stream closing abnormally just ends the capture; the tail so far stands.
    });
    return { tail: () => tail, done };
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
        // The fixture write went through the preload's shared fs mocks, which record every call.
        resetFsMocks();
    });

    it('a bun test child exits when its parent is killed while the suite has fake timers installed', async () => {
        // Resolved (macOS: tmpdir() is under the /var -> /private/var symlink): the host
        // generates the preload under this directory, and the private temp directory
        // check rejects any path with a symlinked ancestor.
        fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'stryker-bun-orphan-')));
        await writeFile(path.join(fixture, 'orphan.test.ts'), fixtureSuite());
        server = createServer();
        const reported = once(server, 'connection') as Promise<[Socket]>;
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;

        const spawned = Bun.spawn([process.execPath, '--eval', parentScript(fixture, port)], { cwd: fixture, stdout: 'ignore', stderr: 'pipe' });
        parent = spawned;
        const hostStderr = captureTail(spawned.stderr);
        // Resolves (never rejects) with a description of the host's exit. It fails the
        // test at once when the host dies before the child has reported in, instead of
        // leaving the test to wait out its whole timeout.
        const hostFailed = spawned.exited.then(async () => {
            await hostStderr.done;
            const how = spawned.signalCode === null ? `exit code ${spawned.exitCode}` : `signal ${spawned.signalCode}`;
            const tail = hostStderr.tail().trim();
            const stderrNote = tail === '' ? 'It wrote nothing to stderr.' : `Its stderr ended with:\n${tail}`;
            return new Error(`the host process exited (${how}) before the child reported in. ${stderrNote}`);
        });
        const unlessHostExits = async <T>(promise: Promise<T>): Promise<T> => Promise.race([
            promise,
            hostFailed.then((error) => {
                throw error;
            }),
        ]);

        const [report] = await unlessHostExits(reported);
        const [firstLine] = await unlessHostExits(once(report, 'data')) as [Buffer];
        childPid = Number(firstLine.toString().trim());
        const childGone = lifelineCut(report);
        expect(isProcessRunning(childPid)).toBe(true);

        // SIGKILL: the parent runs no cleanup, so only the child itself can notice.
        parent.kill('SIGKILL');
        await parent.exited;

        // EOF on the socket the child alone holds means it is exiting, which
        // isProcessRunning already counts as dead: no further wait is needed.
        await childGone;
        expect(isProcessRunning(childPid)).toBe(false);
    }, 30_000);
});
