/**
 * Zombie-aware process liveness for tests that signal real processes.
 *
 * `process.kill(pid, 0)` only asks "is this pid in the process table?", and a
 * zombie (exited, not yet reaped by its parent) still is. When a process is
 * orphaned to a PID 1 that never reaps — common in containers whose init is not
 * a real init — a killed grandchild stays a zombie indefinitely, so a bare
 * signal-0 check reports "alive" for a process that is dead in every sense that
 * matters. {@link isProcessRunning} additionally reads the process state and
 * treats a zombie as dead.
 *
 * It also treats a process that has begun exiting as dead. The kernel closes an
 * exiting process's descriptors partway through its exit path and only marks
 * it a zombie at the end of it; nothing tells a process that is not the
 * parent when that last step happens, and under CPU load the gap between the
 * two has been measured at 200 ms. A test that has just seen a pipe only
 * the process held reach EOF (see {@link lifelineCut}) would otherwise catch
 * it still in state R. Both kernels mark the process as exiting before they
 * close its descriptors, and that mark is never cleared (the exit path does
 * not return to user code), so "exiting" is as final as "zombie".
 *
 * Mirrors the platform split in src/utils/process-rss.ts: `/proc` on Linux,
 * `ps` elsewhere (macOS has no /proc).
 *
 * Test-only: the runner never probes liveness this way. It learns about its
 * own children from ChildProcess 'exit'/'close', which Node derives from
 * waitpid and which therefore reaps (and so never sees a zombie of) its direct
 * children.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

/** What a state probe saw: the one-letter state, and whether the process has begun exiting. */
export interface ProcessState {
    state:   string
    exiting: boolean
}

/**
 * Linux's PF_EXITING task flag (include/linux/sched.h). do_exit() sets it
 * first thing, before it closes the task's files, and nothing clears it.
 */
const PF_EXITING = 0x4;

/**
 * Parse a `/proc/<pid>/stat` line: the state, and the PF_EXITING bit of the
 * flags field.
 *
 * The line is `pid (comm) state ppid pgrp session tty_nr tpgid flags ...`, and
 * `comm` may itself contain spaces and parentheses, so the fields are counted
 * from the LAST ')'. A line cut short before the flags field reports not
 * exiting.
 */
export function parseProcStat(statContent: string): ProcessState | null {
    const commEnd = statContent.lastIndexOf(')');
    if(commEnd === -1) {
        return null;
    }
    const fields = statContent.slice(commEnd + 1).trim().split(/\s+/);
    if(fields[0] === '') {
        return null;
    }
    const flags = Number(fields[6] ?? 0);
    // eslint-disable-next-line no-bitwise -- testing one bit of the kernel's flag word
    return { state: fields[0], exiting: (flags & PF_EXITING) !== 0 };
}

/**
 * Parse `ps -o stat= -p <pid>` output (e.g. `Ss`, `Z+`, `RE`): the leading
 * state letter, and whether the modifiers include 'E', which BSD-derived ps
 * (macOS) prints for a process that has begun exiting — XNU reports it once
 * exit has started (P_LEXIT), before the process's files are closed. procps
 * (Linux) never prints 'E'.
 */
export function parsePsStat(psOutput: string): ProcessState | null {
    const trimmed = psOutput.trim();
    return trimmed === '' ? null : { state: trimmed[0], exiting: trimmed.slice(1).includes('E') };
}

function readLinuxState(pid: number): ProcessState | null {
    try {
        // eslint-disable-next-line n/no-sync -- isProcessRunning is a synchronous predicate
        return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch{
        // Gone between the signal-0 check and this read.
        return null;
    }
}

function readPsState(pid: number): ProcessState | null {
    // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- 'ps' is a standard system utility (test-only probe), and isProcessRunning is a synchronous predicate
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? parsePsStat(result.stdout) : null;
}

/**
 * True when `pid` exists, is not a zombie ('Z', or Linux's transient 'X' while
 * a reaper releases it), and has not begun exiting. `platform` selects the
 * state probe and defaults to the running platform; tests pass it to exercise
 * the other probe on the machine they happen to run on.
 *
 * Once a pipe that only `pid` held has reached EOF, this is already false:
 * no waiting for the zombie state is needed.
 */
export function isProcessRunning(pid: number, platform: NodeJS.Platform = process.platform): boolean {
    try {
        process.kill(pid, 0);
    } catch{
        return false;
    }
    const probed = platform === 'linux' ? readLinuxState(pid) : readPsState(pid);
    // null: the state could not be read, which after a successful signal-0 means the
    // process vanished in between — dead.
    return probed !== null && !probed.exiting && probed.state !== 'Z' && probed.state !== 'X';
}

/**
 * Resolves when `lifeline` reaches end-of-file. A lifeline is the read end of
 * a pipe whose write end only the watched process holds (it never writes to
 * it), so EOF means the process is exiting: the kernel closes every
 * descriptor of an exiting process. This is how a test waits for the death of
 * a process that is not its own child, which no 'exit' event reports.
 */
export function lifelineCut(lifeline: Readable): Promise<void> {
    return new Promise((resolve) => {
        lifeline.once('end', resolve);
        lifeline.once('close', resolve);
        lifeline.resume();
    });
}
