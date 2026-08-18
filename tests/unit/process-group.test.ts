/**
 * Tests for process-group signalling.
 *
 * These exercise the REAL implementation (imported as realKillProcessGroup from
 * the preload, captured before mock.module replaced it with an inert stub), so
 * they genuinely signal process groups. Every group signalled here belongs to a
 * child this file spawned itself — never a fabricated pid.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'bun:test';
import { realKillProcessGroup } from '../test-preload.js';

/** Every child spawned here, so afterEach can reap them even if a test throws. */
const spawnedChildren: ChildProcess[] = [];

/**
 * True when a pid is still alive. Signal 0 performs the permission/existence
 * check without delivering anything.
 */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch{
        return false;
    }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while(Date.now() < deadline) {
        if(predicate()) {
            return true;
        }
        // eslint-disable-next-line no-await-in-loop -- polling loop: each tick must complete before the next check
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
    }
    return predicate();
}

/**
 * Spawn a detached child that spawns a long-lived child of its own, and report
 * both pids. This is the shape that leaked before the fix: `bun test` running a
 * suite that itself spawns processes.
 *
 * `sleep 5` rather than something longer so that a test failing mid-way caps
 * the damage at five seconds even if the afterEach reap were to fail too.
 */
async function spawnWithGrandchild(): Promise<{ child: ChildProcess, grandchildPid: number }> {
    const child = spawn('/bin/sh', ['-c', 'sleep 5 & echo $!; wait'], {
        detached: true,
        stdio:    ['ignore', 'pipe', 'ignore'],
    });
    spawnedChildren.push(child);

    const grandchildPid = await new Promise<number>((resolve, reject) => {
        child.stdout.on('data', (data: Buffer) => {
            resolve(Number(data.toString().trim()));
        });
        child.on('error', reject);
    });
    await waitUntil(() => isAlive(grandchildPid));
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
        const { child, grandchildPid } = await spawnWithGrandchild();

        // Signal ONLY the direct child — the pre-fix behaviour.
        child.kill('SIGKILL');
        expect(await waitUntil(() => !isAlive(child.pid!))).toBe(true);

        // The grandchild survives its parent. THIS is the leak: from here it is
        // reparented to PID 1 and nothing will ever reap it.
        expect(isAlive(grandchildPid)).toBe(true);

        // The group signal still reaches it, because it stayed in the group.
        expect(realKillProcessGroup(child.pid!, 'SIGKILL')).toBe(true);
        expect(await waitUntil(() => !isAlive(grandchildPid))).toBe(true);
    });

    it('takes down the child and the grandchild together in one signal', async () => {
        const { child, grandchildPid } = await spawnWithGrandchild();

        expect(realKillProcessGroup(child.pid!, 'SIGKILL')).toBe(true);

        expect(await waitUntil(() => !isAlive(child.pid!))).toBe(true);
        expect(await waitUntil(() => !isAlive(grandchildPid))).toBe(true);
    });
});
