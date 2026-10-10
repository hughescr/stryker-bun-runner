/**
 * The runner's private temporary directory.
 *
 * Every file the runner puts in the temp area lives in ONE directory per Stryker
 * run: the coverage preload script (which every `bun test` child EXECUTES), the
 * dry-run test registry (which other worker processes trust), the sanitized
 * bunfig and the coverage data file. A shared, predictable directory there would
 * let another local user pre-create it, or plant files or symlinks in it, and
 * swap the preload (code execution as the Stryker user) or the registry
 * (corrupted results).
 *
 * The directory is therefore private to the current user AND to the run:
 *
 * - Its name is derived, not random, because the worker processes Stryker
 *   spawns for one run must each find it with no coordination (Stryker's main
 *   process runs none of our code, so it cannot hand out a mkdtemp path). Every
 *   worker of a run is a direct child of that run's Stryker main process and
 *   runs in the same sandbox cwd, so uid + sha256(cwd:ppid) is identical across
 *   a run's workers — including ones recycled by maxTestRunnerReuse — and
 *   differs between runs. The cwd half also keeps the name unguessable to other
 *   users in practice (the sandbox directory name is random), so pre-creating it
 *   to block a run is impractical.
 * - It is created with mode 0700 and then VERIFIED on every use with lstat: a
 *   real directory (a symlink is refused, never followed), owned by the current
 *   uid, with no group/other permission bits. Anything else is refused loudly —
 *   a directory planted by someone else must never be used, even if writable.
 * - Its parent must not let other users rename entries out from under us: it
 *   must belong to the current user or to root, and if group or others can
 *   write to it, it must have the sticky bit (as /tmp has). Otherwise a
 *   verified directory could be swapped after the check.
 *
 * Files are written with {@link writePrivateFile}: mode 0600, created
 * exclusively (O_EXCL), after removing whatever was at the path — a stale file
 * or a symlink is replaced, never written through.
 */

/* eslint-disable no-bitwise -- file modes are bitmasks; testing permission bits is the point of this module */

import { createHash } from 'node:crypto';
import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Thrown when the runner's temporary directory, or its parent, is not safe to use. */
export class UnsafeTempDirError extends Error {
    constructor(dir: string, problem: string) {
        super(
            `stryker-bun-runner: refusing to use temporary directory ${dir}: ${problem}. `
            + 'The runner writes a script there that every bun test child executes, so the directory must be private to you. '
            + 'Another user may have created it to tamper with those files: remove it if you trust it, '
            + 'or point TMPDIR at a directory only you can write to.'
        );
        this.name = 'UnsafeTempDirError';
    }
}

/** Key from which a run's directory name is derived. Every field defaults to the live process value. */
export interface RunTempDirKey {
    /** Directory the run directory is created in. Defaults to os.tmpdir(). */
    baseDir?: string
    /** The worker's cwd (Stryker's sandbox). Defaults to process.cwd(). */
    cwd?:     string
    /** The Stryker main process's pid. Defaults to process.ppid. */
    ppid?:    number
    /** The user the directory belongs to. Defaults to {@link currentUid}. */
    uid?:     number
}

/** The current process's user id. */
export function currentUid(): number {
    const uid = process.getuid?.();
    if(uid === undefined) {
        throw new Error('stryker-bun-runner: cannot determine the current user id (process.getuid is unavailable), so cannot create a private temporary directory');
    }
    return uid;
}

/**
 * The path of this run's private directory: `<baseDir>/stryker-bun-runner-<uid>-<hash>`,
 * where hash is the first 16 hex chars of sha256(`<cwd>:<ppid>`). Pure: creates nothing.
 */
export function runTempDirPath(key: RunTempDirKey = {}): string {
    const cwd = key.cwd ?? process.cwd();
    const ppid = key.ppid ?? process.ppid;
    const hash = createHash('sha256').update(`${cwd}:${ppid}`).digest('hex').slice(0, 16);
    return path.join(key.baseDir ?? tmpdir(), `stryker-bun-runner-${key.uid ?? currentUid()}-${hash}`);
}

function octal(mode: number): string {
    return (mode & 0o7777).toString(8).padStart(4, '0');
}

/**
 * Create `dir` (mode 0700) if absent, then verify it is a private directory of
 * `uid`: not a symlink, a directory, owned by `uid`, no group/other permission
 * bits, in a parent other users cannot rename entries in (owned by `uid` or
 * root; sticky if group/other-writable). Throws
 * {@link UnsafeTempDirError} otherwise. Returns `dir`.
 */
export async function ensurePrivateDir(dir: string, uid: number = currentUid()): Promise<string> {
    const parent = path.dirname(dir);
    // stat, not lstat: the base (e.g. $TMPDIR) may legitimately be a symlink; what matters is the directory it resolves to.
    const parentStat = await stat(parent);
    const parentMode = parentStat.mode;
    if((parentMode & 0o022) !== 0 && (parentMode & 0o1000) === 0) {
        throw new UnsafeTempDirError(dir, `its parent ${parent} is writable by other users and lacks the sticky bit (mode ${octal(parentMode)})`);
    }

    try {
        await mkdir(dir, { mode: 0o700 });
    } catch (err) {
        if((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
    }

    const st = await lstat(dir);
    if(st.isSymbolicLink()) {
        throw new UnsafeTempDirError(dir, 'it is a symbolic link');
    }
    if(!st.isDirectory()) {
        throw new UnsafeTempDirError(dir, 'it is not a directory');
    }
    if(st.uid !== uid) {
        throw new UnsafeTempDirError(dir, `it is owned by uid ${st.uid}, not the current user (uid ${uid})`);
    }
    if((st.mode & 0o077) !== 0) {
        throw new UnsafeTempDirError(dir, `it has mode ${octal(st.mode)}; it must not be accessible to group or others (0700)`);
    }
    // The owner of the parent can rename entries in it whatever its mode or sticky bit.
    if(parentStat.uid !== uid && parentStat.uid !== 0) {
        throw new UnsafeTempDirError(dir, `its parent ${parent} is owned by uid ${parentStat.uid}, who could replace it; the parent must belong to you or to root`);
    }
    return dir;
}

/**
 * Write `data` to `file` with mode 0600. Whatever is already at `file` (a stale
 * file, a symlink) is removed first and the file is then created exclusively, so
 * the write can never follow a symlink. Intended for files inside a directory
 * verified by {@link ensurePrivateDir}.
 */
export async function writePrivateFile(file: string, data: string): Promise<void> {
    await rm(file, { force: true });
    await writeFile(file, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
