/**
 * Tests for the zombie-aware liveness helper the process-group tests rely on.
 *
 * `kill(pid, 0)` succeeds for a zombie (exited, not yet reaped). In containers
 * whose PID 1 does not reap orphans, a killed grandchild stays a zombie
 * forever, so a bare kill(pid, 0) check reports "alive" for a process that is
 * really dead. isProcessRunning treats state 'Z' as dead, and a process that
 * has begun exiting too.
 */

import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { describe, it, expect, afterEach } from 'bun:test';
import { isProcessRunning, lifelineCut, parseProcStat, parsePsStat } from '../helpers/process-liveness.js';
import { realSpawn as spawn } from '../test-preload.js';

describe('parseProcStat', () => {
    it('reads the state field from a plain /proc/<pid>/stat line', () => {
        expect(parseProcStat('1234 (sleep) S 1 1234 1234 0 -1 4194560')).toEqual({ state: 'S', exiting: false });
        expect(parseProcStat('1234 (sleep) Z 1 1234 1234 0 -1 4194572')).toEqual({ state: 'Z', exiting: true });
    });

    it('reads PF_EXITING (0x4) from the flags field, the seventh after the command name', () => {
        // Captured from a SIGKILLed process whose pipes had already reached EOF: still R, flags 0x40044c.
        expect(parseProcStat('16093 (bun) R 1 16090 16090 0 -1 4195404 0 0')).toEqual({ state: 'R', exiting: true });
        // Every other bit set, PF_EXITING clear.
        expect(parseProcStat('16093 (bun) R 1 16090 16090 0 -1 4294967291 0 0')).toEqual({ state: 'R', exiting: false });
        // The 4 in the tpgid field just before is not the flags field.
        expect(parseProcStat('16093 (bun) S 1 16090 16090 0 4 0 4 4')).toEqual({ state: 'S', exiting: false });
    });

    it('reports a line cut short before the flags field as not exiting', () => {
        expect(parseProcStat('1234 (sleep) S 1 1234')).toEqual({ state: 'S', exiting: false });
    });

    it('is not fooled by a command name containing spaces and parentheses', () => {
        expect(parseProcStat('42 (my (weird) name Z) R 1 42 42 0 -1 0')).toEqual({ state: 'R', exiting: false });
        expect(parseProcStat('42 (a) Z b) Z 1 42 42 0 -1 0')).toEqual({ state: 'Z', exiting: false });
        expect(parseProcStat('42 (x) 1 2 3 4 5 6 7) S 1 42 42 0 -1 0')).toEqual({ state: 'S', exiting: false });
    });

    it('returns null when there is no state field', () => {
        expect(parseProcStat('')).toBeNull();
        expect(parseProcStat('1234 (sleep)')).toBeNull();
        expect(parseProcStat('1234 (sleep) ')).toBeNull();
        expect(parseProcStat('no parens here')).toBeNull();
    });
});

describe('parsePsStat', () => {
    it('takes the state from the first character of `ps -o stat=` output', () => {
        expect(parsePsStat('Ss\n')).toEqual({ state: 'S', exiting: false });
        expect(parsePsStat('  Z+ \n')).toEqual({ state: 'Z', exiting: false });
        expect(parsePsStat('R')).toEqual({ state: 'R', exiting: false });
    });

    it('reads an E among the modifiers as exiting (BSD ps: the process is trying to exit)', () => {
        expect(parsePsStat('RE\n')).toEqual({ state: 'R', exiting: true });
        expect(parsePsStat('SE+')).toEqual({ state: 'S', exiting: true });
        expect(parsePsStat('Ss+')).toEqual({ state: 'S', exiting: false });
    });

    it('returns null for empty output', () => {
        expect(parsePsStat('')).toBeNull();
        expect(parsePsStat(' \n')).toBeNull();
    });
});

const spawned: ChildProcess[] = [];

afterEach(() => {
    while(spawned.length > 0) {
        spawned.pop()?.kill('SIGKILL');
    }
});

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
        // The shell forks a background child (pid echoed), then exec()s into perl, which
        // never wait()s, so once the child exits it stays a zombie until perl is killed.
        //
        // The child must not exit while the shell is still a shell: shells reap finished
        // background jobs (dash calls wait4(-1, WNOHANG) when SIGCHLD arrives during a builtin
        // such as the echo; bash reaps from its SIGCHLD handler), and a reaped child is gone
        // from the process table instead of a zombie. So the child blocks reading fd 3 until
        // the test writes to it, and the test writes only after perl has said 'ready', which
        // only the exec()ed perl prints, so it proves the shell is gone.
        //
        // perl prints 'zombie' from its SIGCHLD handler: both kernels mark the child a zombie
        // before they signal its parent, so that line is the event this test waits on. A pipe
        // only the child holds would not do: it reaches EOF while the child is still
        // partway through exiting, before it is a zombie.
        const parent = spawn('/bin/sh', ['-c', String.raw`{ read -r _ <&3; } & echo $!; exec perl -e '$| = 1; $SIG{CHLD} = sub { print "zombie\n" }; print "ready\n"; sleep while 1'`], { stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
        spawned.push(parent);
        // The stdio option above guarantees these pipes; spawn's typings cannot see that.
        const stdout = parent.stdio[1]!;
        const release = parent.stdio[3] as Writable;
        const lines = createInterface({ input: stdout })[Symbol.asyncIterator]();
        const nextLine = async (): Promise<string> => {
            const line = await lines.next();
            if(line.done) {
                throw new Error('the parent closed stdout early');
            }
            return line.value;
        };
        const zombiePid = Number(await nextLine());
        expect(await nextLine()).toBe('ready');
        release.write('exit\n');
        expect(await nextLine()).toBe('zombie');

        // Still in the process table (the zombie) ...
        expect(existsInProcessTable(zombiePid)).toBe(true);
        // ... and dead by both platform probes.
        expect(isProcessRunning(zombiePid, 'linux')).toBe(false);
        expect(isProcessRunning(zombiePid, 'darwin')).toBe(false);
    });
});

describe('lifelineCut', () => {
    it('resolves once the only process holding the pipe has exited, and the process counts as dead then', async () => {
        // Fd 3 is the lifeline: sleep inherits it, the shell closes its own copy. The EOF
        // can come before sleep is a zombie; isProcessRunning counts it dead either way.
        const parent = spawn('/bin/sh', ['-c', 'sleep 5 & echo $!; exec 3>&-; wait'], { stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
        spawned.push(parent);
        const lines = createInterface({ input: parent.stdio[1]! })[Symbol.asyncIterator]();
        const pidLine = await lines.next();
        const holderPid = Number(pidLine.value);
        const holderGone = lifelineCut(parent.stdio[3] as Readable);
        expect(isProcessRunning(holderPid)).toBe(true);

        process.kill(holderPid, 'SIGKILL');
        await holderGone;

        expect(isProcessRunning(holderPid)).toBe(false);
    });
});
