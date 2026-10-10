/**
 * Tests for process-group signalling.
 *
 * These exercise the REAL implementation (imported as realKillProcessGroup from
 * the preload, captured before mock.module replaced it with an inert stub), so
 * they genuinely signal process groups. Every group signalled here belongs to a
 * child this file spawned itself — never a fabricated pid.
 *
 * Real processes, so no fake clock — and no real one either: every wait is on
 * an event. A direct child's death is its 'exit' event; a grandchild's is the
 * EOF on a lifeline pipe that only the grandchild holds (see lifelineCut).
 */

import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { describe, it, expect, afterEach } from 'bun:test';
// realSpawn, not `spawn` from node:child_process: that import is the shared
// mockSpawn, whose call history would otherwise accumulate this file's spawns
// (this file never resets mocks) and leak into other files' call-count assertions.
import { isProcessRunning, lifelineCut, settlesDead } from '../helpers/process-liveness.js';
import { realKillProcessGroup, realSpawn as spawn } from '../test-preload.js';

/** Every child spawned here, so afterEach can reap them even if a test throws. */
const spawnedChildren: ChildProcess[] = [];

/**
 * True when a pid is still alive. A bare kill(pid, 0) also succeeds for a zombie,
 * and in a container whose PID 1 never reaps orphans a killed grandchild stays a
 * zombie forever — so liveness comes from the zombie-aware helper instead.
 */
const isAlive = isProcessRunning;

interface Family {
    child:          ChildProcess
    grandchildPid:  number
    /** Resolves once the grandchild has exited (EOF on a pipe only it holds). */
    grandchildGone: Promise<void>
}

/** The first line `stream` prints, as a pid. */
function readPid(child: ChildProcess, stream: Readable): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        stream.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
        child.on('error', reject);
    });
}

/** Resolves on the direct child's 'exit' event (Node has reaped it by then). */
function exited(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
        if(child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once('exit', () => resolve());
    });
}

/** A family whose grandchild is running, so the tests start from a known state. */
function family(child: ChildProcess, grandchildPid: number, lifeline: Readable): Family {
    if(!isAlive(grandchildPid)) {
        throw new Error(`grandchild ${grandchildPid} is not running`);
    }
    return { child, grandchildPid, grandchildGone: lifelineCut(lifeline) };
}

/**
 * Spawn a detached child that spawns a long-lived child of its own, and report
 * both pids. This is the shape that leaked before the fix: `bun test` running a
 * suite that itself spawns processes.
 *
 * `sleep 5` rather than something longer so that a test failing mid-way caps
 * the damage at five seconds even if the afterEach reap were to fail too.
 * Fd 3 is the grandchild's lifeline: the shell closes its own copy once the
 * grandchild has inherited it.
 */
async function spawnWithGrandchild(): Promise<Family> {
    const child = spawn('/bin/sh', ['-c', 'sleep 5 & echo $!; exec 3>&-; wait'], {
        detached: true,
        stdio:    ['ignore', 'pipe', 'ignore', 'pipe'],
    });
    spawnedChildren.push(child);
    const grandchildPid = await readPid(child, child.stdout!);
    return family(child, grandchildPid, child.stdio[3] as Readable);
}

/**
 * A leader that exits on SIGTERM, with a grandchild that ignores SIGTERM. The
 * grandchild reports its pid on fd 3 (the leader's stdout) and closes it, so it
 * does not hold the leader's stdout; fd 4 is its lifeline, which the leader
 * closes for itself once the grandchild has inherited it.
 */
async function spawnLeaderThatExitsButLeavesGrandchild(): Promise<Family> {
    const child = spawn('/bin/sh', ['-c', String.raw`trap 'exit 0' TERM; bun -e 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeSync(3, String(process.pid) + "\n"); fs.closeSync(3); setTimeout(() => process.exit(0), 5000)' 3>&1 </dev/null >/dev/null 2>&1 & exec 4>&-; while :; do sleep 1; done`], {
        detached: true,
        stdio:    ['ignore', 'pipe', 'ignore', 'ignore', 'pipe'],
    });
    spawnedChildren.push(child);
    const grandchildPid = await readPid(child, child.stdout!);
    return family(child, grandchildPid, child.stdio[4] as Readable);
}

/**
 * A leader that exits on SIGTERM, with a TERM-ignoring grandchild that keeps
 * the leader's stdout open: stdout is the grandchild's lifeline once the
 * leader is gone.
 */
async function spawnLeaderWithGrandchildHoldingStdout(): Promise<{ child: ChildProcess, grandchildPid: number }> {
    const child = spawn('/bin/sh', ['-c', "trap 'exit 0' TERM; bun -e 'process.on(\"SIGTERM\", () => {}); console.log(process.pid); setTimeout(() => process.exit(0), 5000)' </dev/null 2>/dev/null & while :; do sleep 1; done"], {
        detached: true,
        stdio:    ['ignore', 'pipe', 'ignore'],
    });
    spawnedChildren.push(child);
    const grandchildPid = await readPid(child, child.stdout);
    return { child, grandchildPid };
}

describe('killProcessGroup', () => {
    afterEach(() => {
        // Reap anything a failed assertion left behind — these are detached, so
        // they outlive the test runner itself if nobody signals them.
        while(spawnedChildren.length > 0) {
            const child = spawnedChildren.pop();
            if(child?.pid !== undefined) {
                realKillProcessGroup(child.pid, 'SIGKILL');
            }
        }
    });

    it('returns false when the process group does not exist', () => {
        // 2^31-1 is beyond any real pid on Linux or macOS, so the group cannot
        // exist and the kill must report failure rather than throw.
        expect(realKillProcessGroup(2_147_483_647, 'SIGKILL')).toBe(false);
    });

    it('reaps a grandchild that a plain child.kill() leaves orphaned', async () => {
        const { child, grandchildPid, grandchildGone } = await spawnWithGrandchild();

        // Signal ONLY the direct child — the pre-fix behaviour.
        child.kill('SIGKILL');
        await exited(child);
        expect(isAlive(child.pid!)).toBe(false);

        // The grandchild survives its parent. THIS is the leak: from here it is
        // reparented to PID 1 and nothing will ever reap it.
        expect(isAlive(grandchildPid)).toBe(true);

        // The group signal still reaches it, because it stayed in the group.
        expect(realKillProcessGroup(child.pid!, 'SIGKILL')).toBe(true);
        await grandchildGone;
        expect(await settlesDead(grandchildPid)).toBe(true);
    });

    it('takes down the child and the grandchild together in one signal', async () => {
        const { child, grandchildPid, grandchildGone } = await spawnWithGrandchild();

        expect(realKillProcessGroup(child.pid!, 'SIGKILL')).toBe(true);

        await exited(child);
        expect(isAlive(child.pid!)).toBe(false);
        await grandchildGone;
        expect(await settlesDead(grandchildPid)).toBe(true);
    });

    it('can reap a TERM-ignoring descendant after the group leader exits', async () => {
        const { child, grandchildPid, grandchildGone } = await spawnLeaderThatExitsButLeavesGrandchild();

        expect(realKillProcessGroup(child.pid!, 'SIGTERM')).toBe(true);
        await exited(child);
        expect(isAlive(grandchildPid)).toBe(true);

        // This is the runner's exit-event escalation path: close cannot be used
        // as the lifecycle boundary because a descendant may retain stdio.
        expect(realKillProcessGroup(child.pid!, 'SIGKILL')).toBe(true);
        await grandchildGone;
        expect(await settlesDead(grandchildPid)).toBe(true);
    });

    it('observes leader exit before close when a descendant retains stdout', async () => {
        const { child, grandchildPid } = await spawnLeaderWithGrandchildHoldingStdout();
        let hasClosed = false;
        const closed = new Promise<void>((resolve) => {
            child.once('close', () => {
                hasClosed = true;
                resolve();
            });
        });

        expect(realKillProcessGroup(child.pid!, 'SIGTERM')).toBe(true);
        await exited(child);
        expect(hasClosed).toBe(false);
        expect(isAlive(grandchildPid)).toBe(true);

        expect(realKillProcessGroup(child.pid!, 'SIGKILL')).toBe(true);
        // 'close' needs every holder of the leader's stdout gone, the grandchild included.
        await closed;
        expect(await settlesDead(grandchildPid)).toBe(true);
    });
});
