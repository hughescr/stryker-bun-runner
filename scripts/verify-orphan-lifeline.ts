/**
 * Checks, on this machine, that a `bun test` child spawned by the runner exits
 * through its parent lifeline when the process that spawned it is killed.
 *
 *     bun scripts/verify-orphan-lifeline.ts
 *
 * A host process runs the runner's real spawn path (src/process-runner.ts) with
 * the real coverage preload, on a one-test suite that installs bun's fake
 * timers and reports to this script over a socket. This script then:
 *
 * 1. waits 1.5 s with the host alive and asks the child how many timers its
 *    fake-timer queue holds. The child answering at all shows the lifeline did
 *    not report the parent gone while it was alive. A timer in the queue is the
 *    preload's fallback watchdog, captured by the fake timers: the lifeline
 *    was unavailable here, and the child fell back to polling.
 * 2. kills the host with SIGKILL and waits for the child's socket to close,
 *    which happens when the child exits, up to a hard cap.
 *
 * Prints PASS or FAIL with timings, and exits 0 or 1.
 */

/* eslint-disable no-console, n/no-process-exit, unicorn/no-process-exit -- a command-line script: its output is the point, and its exit code is the verdict */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIFELINE_FD_ENV } from '../src/coverage/preload-logic.js';

/** Real time the child holds fake timers, with its host alive, before the check: longer than the fallback watchdog's 1 s poll. */
const ALIVE_WINDOW_MS = 1500;
/** How long the child may take to start and report in. */
const STARTUP_CAP_MS = 30_000;
/** How long the child may take to exit once its host is killed. */
const EXIT_CAP_MS = 5000;

const repoRoot = path.resolve(import.meta.dir, '..');

// The child reports its pid, then what its lifeline descriptor is: a socket or
// FIFO while the preload is reading it, closed (EBADF) once a read error made
// the preload fall back.
const FIXTURE = String.raw`import { test, jest } from 'bun:test';
import { fstatSync } from 'node:fs';
import { connect } from 'node:net';
test('holds fake timers until killed', async () => {
    jest.useFakeTimers();
    const value = process.env.${LIFELINE_FD_ENV};
    let kind;
    try {
        const stat = fstatSync(Number(value));
        kind = stat.isSocket() ? 'a socket' : stat.isFIFO() ? 'a FIFO' : 'neither a socket nor a FIFO';
    } catch (error) {
        kind = 'not open: ' + error.code;
    }
    const socket = connect(Number(process.env.VERIFY_ORPHAN_PORT), '127.0.0.1');
    socket.write(process.pid + ' ${LIFELINE_FD_ENV}=' + value + ', ' + kind + '\n');
    socket.on('data', (data) => {
        if(String(data).includes('check')) {
            socket.write('timers ' + jest.getTimerCount() + '\n');
        }
    });
    await new Promise(() => {});
}, 600_000);
`;

function hostScript(fixture: string, port: number): string {
    const runnerUrl = new URL('src/process-runner.ts', `file://${repoRoot}/`).href;
    const generatorUrl = new URL('src/coverage/preload-generator.ts', `file://${repoRoot}/`).href;
    return [
        `const { runBunTests } = await import(${JSON.stringify(runnerUrl)});`,
        `const { generatePreloadScript } = await import(${JSON.stringify(generatorUrl)});`,
        `const preloadScript = await generatePreloadScript({ tempDir: ${JSON.stringify(path.join(fixture, 'preload'))}, coverageFile: ${JSON.stringify(path.join(fixture, 'coverage.json'))} });`,
        `process.chdir(${JSON.stringify(fixture)});`,
        `await runBunTests({ bunPath: process.execPath, timeout: 600_000, activeMutant: 'verify', preloadScript, bunfigPath: '/dev/null', testFiles: ['orphan.test.ts'], maxSpawnDepth: 5, env: { VERIFY_ORPHAN_PORT: '${port}' } });`,
    ].join('\n');
}

/** Resolves with `promise`, or rejects with `message` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
        return await Promise.race([promise, cap]);
    } finally {
        clearTimeout(timer);
    }
}

/** Yields each newline-terminated line `socket` receives. */
function lineReader(socket: Socket): () => Promise<string> {
    const lines: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    let buffered = '';
    socket.on('data', (data: Buffer) => {
        buffered += data.toString();
        let newline = buffered.indexOf('\n');
        while(newline !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            const waiter = waiters.shift();
            if(waiter) {
                waiter(line);
            } else {
                lines.push(line);
            }
            newline = buffered.indexOf('\n');
        }
    });
    return () => {
        const line = lines.shift();
        if(line !== undefined) {
            return Promise.resolve(line);
        }
        return new Promise((resolve) => {
            waiters.push(resolve);
        });
    };
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch{
        return false;
    }
}

async function main(): Promise<boolean> {
    console.log(`verify-orphan-lifeline: bun ${Bun.version} on ${process.platform} ${process.arch}`);
    const fixture = await mkdtemp(path.join(tmpdir(), 'stryker-bun-verify-orphan-'));
    const server = createServer();
    let host: ReturnType<typeof Bun.spawn> | undefined;
    let childPid: number | undefined;
    try {
        await writeFile(path.join(fixture, 'orphan.test.ts'), FIXTURE);
        const connected = new Promise<Socket>((resolve) => {
            server.once('connection', resolve);
        });
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        const { port } = server.address() as AddressInfo;

        host = Bun.spawn([process.execPath, '--eval', hostScript(fixture, port)], { cwd: fixture, stdout: 'ignore', stderr: 'inherit' });
        const socket = await within(connected, STARTUP_CAP_MS, `the child did not report in within ${STARTUP_CAP_MS} ms`);
        const closed = new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
        });
        const nextLine = lineReader(socket);
        const report = await within(nextLine(), STARTUP_CAP_MS, 'the child did not send its pid');
        const [pidText, ...lifeline] = report.split(' ');
        childPid = Number(pidText);
        console.log(`host pid ${host.pid}, child pid ${childPid}; child's lifeline: ${lifeline.join(' ')}`);

        await new Promise((resolve) => {
            setTimeout(resolve, ALIVE_WINDOW_MS);
        });
        socket.write('check\n');
        const answer = await within(nextLine(), EXIT_CAP_MS, 'the child stopped answering while its host was alive');
        const timers = Number(answer.replace('timers ', ''));
        console.log(`child still alive with its host alive after ${ALIVE_WINDOW_MS} ms; timers in its fake queue: ${timers}`);

        const fallbackNote = timers > 0
            ? ' The child\'s fake-timer queue held a timer: the parent lifeline is unavailable on this machine and the preload fell back to its timer watchdog, which the fake timers captured.'
            : '';
        const killedAt = performance.now();
        host.kill('SIGKILL');
        await host.exited;
        try {
            await within(closed, EXIT_CAP_MS, 'cap');
        } catch{
            console.log(`FAIL: child ${childPid} still running ${EXIT_CAP_MS} ms after its host was killed.${fallbackNote}`);
            return false;
        }
        const exitMs = performance.now() - killedAt;
        console.log(`child exited ${exitMs.toFixed(0)} ms after its host was killed`);
        if(timers > 0) {
            console.log(`FAIL: the child exited, but not through its lifeline.${fallbackNote}`);
            return false;
        }
        console.log('PASS: the child exited through its parent lifeline, with fake timers installed');
        return true;
    } catch (error) {
        console.log(`FAIL: ${(error as Error).message}`);
        return false;
    } finally {
        if(childPid !== undefined && isRunning(childPid)) {
            process.kill(childPid, 'SIGKILL');
        }
        host?.kill('SIGKILL');
        server.close();
        await rm(fixture, { recursive: true, force: true });
    }
}

process.exit(await main() ? 0 : 1);
