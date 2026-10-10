/**
 * Tests for the zombie-aware liveness helper the process-group tests rely on.
 *
 * `kill(pid, 0)` succeeds for a zombie (exited, not yet reaped). In containers
 * whose PID 1 does not reap orphans, a killed grandchild stays a zombie
 * forever, so a bare kill(pid, 0) check reports "alive" for a process that is
 * really dead. isProcessRunning treats state 'Z' as dead.
 */

import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, afterEach } from 'bun:test';
import { isProcessRunning, parseProcStatState, parsePsState } from '../helpers/process-liveness.js';
import { realSpawn as spawn } from '../test-preload.js';

describe('parseProcStatState', () => {
    it('reads the state field from a plain /proc/<pid>/stat line', () => {
        expect(parseProcStatState('1234 (sleep) S 1 1234 1234 0 -1 4194560')).toBe('S');
        expect(parseProcStatState('1234 (sleep) Z 1 1234 1234 0 -1 4194560')).toBe('Z');
    });

    it('is not fooled by a command name containing spaces and parentheses', () => {
        expect(parseProcStatState('42 (my (weird) name Z) R 1 42 42 0 -1 0')).toBe('R');
        expect(parseProcStatState('42 (a) Z b) Z 1 42 42 0 -1 0')).toBe('Z');
    });

    it('returns null when there is no state field', () => {
        expect(parseProcStatState('')).toBeNull();
        expect(parseProcStatState('1234 (sleep)')).toBeNull();
        expect(parseProcStatState('1234 (sleep) ')).toBeNull();
        expect(parseProcStatState('no parens here')).toBeNull();
    });
});

describe('parsePsState', () => {
    it('takes the first character of `ps -o stat=` output', () => {
        expect(parsePsState('Ss\n')).toBe('S');
        expect(parsePsState('  Z+ \n')).toBe('Z');
        expect(parsePsState('R')).toBe('R');
    });

    it('returns null for empty output', () => {
        expect(parsePsState('')).toBeNull();
        expect(parsePsState(' \n')).toBeNull();
    });
});

const spawned: ChildProcess[] = [];

afterEach(() => {
    while(spawned.length > 0) {
        spawned.pop()?.kill('SIGKILL');
    }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
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

/** True when kill(pid, 0) says the pid exists (zombies included). */
function existsInProcessTable(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch{
        return false;
    }
}

describe('isProcessRunning', () => {
    it('is true for a live process and false once it is gone', async () => {
        const child = spawn('/bin/sleep', ['5'], { stdio: 'ignore' });
        spawned.push(child);
        const pid = child.pid!;

        expect(isProcessRunning(pid)).toBe(true);
        expect(isProcessRunning(pid, 'darwin')).toBe(true);

        child.kill('SIGKILL');
        await new Promise<void>((resolve) => {
            child.once('close', () => resolve());
        });

        // Node has reaped it, so the pid is gone from the process table.
        expect(isProcessRunning(pid)).toBe(false);
        expect(isProcessRunning(pid, 'darwin')).toBe(false);
    });

    it('is false for a pid that never existed', () => {
        expect(isProcessRunning(2_147_483_647)).toBe(false);
        expect(isProcessRunning(2_147_483_647, 'darwin')).toBe(false);
    });

    it('treats an unreaped zombie as dead even though kill(pid, 0) still succeeds', async () => {
        // The shell forks a background `true` (pid echoed), then exec()s into sleep, which never
        // wait()s. `true` exits at once and stays a zombie until the sleep is killed.
        const parent = spawn('/bin/sh', ['-c', 'true & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
        spawned.push(parent);
        const zombiePid = await new Promise<number>((resolve, reject) => {
            parent.stdout.once('data', (data: Buffer) => {
                resolve(Number(data.toString().trim()));
            });
            parent.once('error', reject);
        });

        // Still in the process table (the zombie) ...
        expect(await waitUntil(() => !isProcessRunning(zombiePid))).toBe(true);
        expect(existsInProcessTable(zombiePid)).toBe(true);
        // ... and dead by both platform probes.
        expect(isProcessRunning(zombiePid, 'linux')).toBe(false);
        expect(isProcessRunning(zombiePid, 'darwin')).toBe(false);
    });
});
