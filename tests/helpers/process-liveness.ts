/**
 * Zombie-aware process liveness for tests that signal real processes.
 *
 * `process.kill(pid, 0)` only asks "is this pid in the process table?", and a
 * zombie (exited, not yet reaped by its parent) still is. When a process is
 * orphaned to a PID 1 that never reaps — common in containers whose init is not
 * a real init — a killed grandchild stays a zombie indefinitely, so a bare
 * signal-0 check reports "alive" for a process that is dead in every sense that
 * matters. {@link isProcessRunning} additionally reads the process state and
 * treats 'Z' as dead.
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

/**
 * Pull the one-letter process state out of a `/proc/<pid>/stat` line.
 *
 * The line is `pid (comm) state ppid ...`, and `comm` may itself contain spaces
 * and parentheses, so the state is the first field after the LAST ')'.
 */
export function parseProcStatState(statContent: string): string | null {
    const afterComm = statContent.slice(statContent.lastIndexOf(')') + 1);
    const state = /^\s+(\S)/.exec(afterComm);
    return state ? state[1] : null;
}

/** Pull the leading state letter out of `ps -o stat= -p <pid>` output (e.g. `Ss`, `Z+`). */
export function parsePsState(psOutput: string): string | null {
    const trimmed = psOutput.trim();
    return trimmed === '' ? null : trimmed[0];
}

function readLinuxState(pid: number): string | null {
    try {
        // eslint-disable-next-line n/no-sync -- callers poll this from synchronous predicates (waitUntil), so it must be synchronous
        return parseProcStatState(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch{
        // Gone between the signal-0 check and this read.
        return null;
    }
}

function readPsState(pid: number): string | null {
    // eslint-disable-next-line sonarjs/no-os-command-from-path, n/no-sync -- 'ps' is a standard system utility (test-only probe), and callers poll this from synchronous predicates (waitUntil), so it must be synchronous
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? parsePsState(result.stdout) : null;
}

/**
 * True when `pid` exists and is not a zombie. `platform` selects the state
 * probe and defaults to the running platform; tests pass it to exercise the
 * other probe on the machine they happen to run on.
 */
export function isProcessRunning(pid: number, platform: NodeJS.Platform = process.platform): boolean {
    try {
        process.kill(pid, 0);
    } catch{
        return false;
    }
    const state = platform === 'linux' ? readLinuxState(pid) : readPsState(pid);
    // null: the state could not be read, which after a successful signal-0 means the
    // process vanished in between — dead.
    return state !== null && state !== 'Z';
}
