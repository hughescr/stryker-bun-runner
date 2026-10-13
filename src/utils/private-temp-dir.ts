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
 *   process only imports the plugin and calls none of the runner's code, so it
 *   cannot hand out a mkdtemp path). Every
 *   worker of a run is a direct child of that run's Stryker main process and
 *   runs in the same sandbox cwd, so uid + pid space + ppid + sha256(cwd:ppid) is identical across
 *   a run's workers — including ones recycled by maxTestRunnerReuse — and
 *   differs between runs. The name is NOT secret: the ppid shows in `ps`, and
 *   with --inPlace the cwd is the real project. Anyone can therefore pre-create
 *   it, which is why it is verified before use (below) and why a squatted name
 *   costs nothing: see {@link resolveRunTempDir}'s numbered slots.
 * - The base directory (os.tmpdir()) is resolved with realpath once, and every
 *   later path is built from the resolved one, so retargeting a symlinked
 *   TMPDIR cannot redirect the runner.
 * - Every directory above it, up to `/`, must be safe from other users (OpenSSH
 *   safe_path rules): owned by the current user or root, and if group or others
 *   can write to it, it must have the sticky bit (as /tmp has), and it must not
 *   be a symlink. Otherwise another user could rename an ancestor away and
 *   rebuild the path with a planted preload, after the checks.
 * - The directory itself is created with mode 0700 and VERIFIED with lstat: a
 *   real directory (a symlink is refused, never followed), owned by the current
 *   uid, with no group/other permission bits. Anything else is refused — a
 *   directory planted by someone else must never be used, even if writable.
 *
 * Once verified, the directory stays safe for the run: only its owner (us) or
 * root can change it or any directory above it, so it is not re-verified
 * before every mutant run.
 *
 * Files are written with {@link writePrivateFile}: mode 0600, created
 * exclusively (O_EXCL), after removing whatever was at the path — a stale file
 * or a symlink is replaced, never written through.
 *
 * The directory lives as long as the run's Stryker main process, the ppid in
 * its name (with the tag of the pid space that ppid belongs to, {@link pidSpace}):
 * no worker can tell whether it is the last one (Stryker disposes a
 * worker before forking its replacement), so none removes it. The main process
 * removes it when it exits, and a run killed outright leaves it to a later
 * run's exit, once it has gone unchanged for {@link STALE_RUN_DIR_AGE_MS}
 * ({@link removeRunTempDirsOnExit}, {@link removeFinishedRunTempDirs}).
 */

/* eslint-disable no-bitwise -- file modes are bitmasks; testing permission bits is the point of this module */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Thrown when the runner's temporary directory, or a directory above it, is not safe to use. */
export class UnsafeTempDirError extends Error {
    constructor(dir: string, problem: string) {
        super(
            `stryker-bun-runner: refusing to use temporary directory ${dir}: ${problem}. `
            + 'The runner writes a script there that every bun test child executes, so neither the directory nor any directory above it may be changeable by other users. '
            + 'Remove the directory if you trust it, or set TMPDIR to a directory that only you and root control.'
        );
        this.name = 'UnsafeTempDirError';
    }
}

/** Key from which a run's directory name is derived. Every field defaults to the live process value. */
export interface RunTempDirKey {
    /** Directory the run directory is created in. Defaults to os.tmpdir(). */
    baseDir?:  string
    /** The worker's cwd (Stryker's sandbox). Defaults to process.cwd(). */
    cwd?:      string
    /** The Stryker main process's pid. Defaults to process.ppid. */
    ppid?:     number
    /** The user the directory belongs to. Defaults to {@link currentUid}. */
    uid?:      number
    /** The pid space the ppid belongs to. Defaults to {@link pidSpace}'s tag. */
    pidSpace?: string
}

/** Which pids a pid means: see {@link pidSpace}. */
export interface PidSpace {
    /** 8 hex chars, the same for every process that sees the same pids. */
    readonly tag:   string
    /** False when the tag could not be derived, so pids in a run directory's name cannot be judged at all. */
    readonly known: boolean
}

/** The ids a Linux pid space is told apart by: this boot of this kernel, and the pid namespace. Throws without /proc. */
function readLinuxPidSpaceIds(): string {
    // eslint-disable-next-line n/no-sync -- read once per process (pidSpace memoizes it), on a path where the result is needed at once
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    // eslint-disable-next-line n/no-sync -- as above
    return `${bootId}:${readlinkSync('/proc/self/ns/pid')}`;
}

/**
 * The pid space of a process on `platform`, given how to read Linux's pid space ids.
 * Exported for tests; the runner uses {@link pidSpace}.
 */
export function computePidSpace(platform: NodeJS.Platform = process.platform, readIds: () => string = readLinuxPidSpaceIds): PidSpace {
    if(platform !== 'linux') {
        return { tag: tagOf(''), known: true };
    }
    try {
        return { tag: tagOf(readIds()), known: true };
    } catch{
        // A tag of its own, never equal to another platform's constant or a real Linux pid space's.
        return { tag: tagOf('stryker-bun-runner: unknown Linux pid space'), known: false };
    }
}

function tagOf(ids: string): string {
    return createHash('sha256').update(ids).digest('hex').slice(0, 8);
}

let currentPidSpace: PidSpace | undefined;

/**
 * Which pids this process's pids are: a pid names a process only within one pid
 * namespace of one running kernel. Containers that share a temp directory (a
 * bind-mounted /tmp) and run as the same uid, which is typical for root, see the
 * same directory names but not each other's processes, and their Stryker main
 * processes often have the same small pids. A run directory's name carries the
 * tag of the pid space its owner pid belongs to, so a process only ever judges
 * the owners of directories from its own pid space.
 *
 * On Linux the tag is derived from the boot id (/proc/sys/kernel/random/boot_id,
 * random per boot and per host; containers share their host's) and the pid
 * namespace (/proc/self/ns/pid). Without them the tag is a sentinel of its own,
 * marked unknown, and {@link removeFinishedRunTempDirs} removes nothing. Other
 * platforms have one pid space per host and a constant tag. Memoized: neither
 * changes during a process's life.
 *
 * Assumption: one tag, one process table. It fails where separate process
 * tables share a tag and a temp directory, such as clones of one VM snapshot
 * (same boot id, same initial pid namespace) sharing a TMPDIR. A live run there
 * can look dead to the other side; {@link removeFinishedRunTempDirs}' age gate,
 * with workers refreshing their directory ({@link touchRunTempDir}), is what
 * protects it.
 */
export function pidSpace(): PidSpace {
    currentPidSpace ??= computePidSpace();
    return currentPidSpace;
}

/** The parts of an lstat result the checks read. */
export interface DirStat {
    readonly uid:  number
    readonly mode: number
    isDirectory(): boolean
    isSymbolicLink(): boolean
}

/** The lstat the checks use; injectable so tests can simulate other owners without root. */
export type LstatFn = (p: string) => Promise<DirStat>;

/** How many numbered directories {@link resolveRunTempDir} tries before giving up. */
export const RUN_TEMP_DIR_SLOTS = 16;

/** The current process's user id. */
export function currentUid(): number {
    const uid = process.getuid?.();
    if(uid === undefined) {
        throw new Error('stryker-bun-runner: cannot determine the current user id (process.getuid is unavailable), so cannot create a private temporary directory');
    }
    return uid;
}

/**
 * The name prefix of this run's private directory:
 * `<baseDir>/stryker-bun-runner-<uid>-<pid space>-<ppid>-<hash>`, where hash is the
 * first 16 hex chars of sha256(`<cwd>:<ppid>`). The directory itself is
 * `<prefix>-<slot>` (see {@link resolveRunTempDir}). Pure: creates nothing.
 *
 * The ppid (the Stryker main process, which owns the run) and the tag of the pid
 * space it belongs to ({@link pidSpace}) are in the name in the clear so that
 * {@link removeFinishedRunTempDirs} can tell when the run is over without reading
 * anything inside the directory.
 */
export function runTempDirPrefix(key: RunTempDirKey = {}): string {
    const cwd = key.cwd ?? process.cwd();
    const ppid = key.ppid ?? process.ppid;
    const hash = createHash('sha256').update(`${cwd}:${ppid}`).digest('hex').slice(0, 16);
    const space = key.pidSpace ?? pidSpace().tag;
    return path.join(key.baseDir ?? tmpdir(), `stryker-bun-runner-${key.uid ?? currentUid()}-${space}-${ppid}-${hash}`);
}

function octal(mode: number): string {
    return (mode & 0o7777).toString(8).padStart(4, '0');
}

/** Why `st` is not a private directory of `uid`, or undefined if it is one. */
function dirProblem(st: DirStat, uid: number): string | undefined {
    if(st.isSymbolicLink()) {
        return 'it is a symbolic link';
    }
    if(!st.isDirectory()) {
        return 'it is not a directory';
    }
    if(st.uid !== uid) {
        return `it is owned by uid ${st.uid}, not the current user (uid ${uid})`;
    }
    if((st.mode & 0o077) !== 0) {
        return `it has mode ${octal(st.mode)}; it must not be accessible to group or others (0700)`;
    }
    return undefined;
}

/** Why another user could replace the entries of the directory `st` describes, or undefined if none can. */
function ancestorProblem(st: DirStat, uid: number): string | undefined {
    if(st.isSymbolicLink()) {
        return 'is a symbolic link; the path must be fully resolved';
    }
    // The owner of a directory can rename its entries whatever its mode or sticky bit.
    if(st.uid !== uid && st.uid !== 0) {
        return `is owned by uid ${st.uid}, who could replace it; every directory above it must belong to you or to root`;
    }
    if((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) {
        return `is writable by other users and lacks the sticky bit (mode ${octal(st.mode)}), so they could replace it`;
    }
    return undefined;
}

/**
 * Verify `top` and every directory above it, up to `/`, with {@link ancestorProblem}.
 * Throws {@link UnsafeTempDirError} for `dir` naming the first offending directory.
 */
async function verifyAncestors(top: string, dir: string, uid: number, lstatFn: LstatFn): Promise<void> {
    for(let component = top; ; component = path.dirname(component)) {
        // eslint-disable-next-line no-await-in-loop -- one directory at a time, from the bottom up, stopping at the first unsafe one
        const problem = ancestorProblem(await lstatFn(component), uid);
        if(problem !== undefined) {
            throw new UnsafeTempDirError(dir, `${component} (a directory above it) ${problem}`);
        }
        if(component === path.dirname(component)) {
            return;
        }
    }
}

/** lstat `p`, or undefined if it does not exist. */
async function lstatIfExists(p: string, lstatFn: LstatFn): Promise<DirStat | undefined> {
    try {
        return await lstatFn(p);
    } catch (err) {
        if((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw err;
    }
}

/**
 * Create `dir` (mode 0700) if absent, then check it with {@link dirProblem}.
 * Returns why it is unusable, or undefined if it is a private directory of `uid`.
 * Does not check the directories above it.
 */
async function createPrivateDir(dir: string, uid: number, lstatFn: LstatFn): Promise<string | undefined> {
    try {
        await mkdir(dir, { mode: 0o700 });
    } catch (err) {
        if((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
    }
    const st = await lstatIfExists(dir, lstatFn);
    return st === undefined ? 'it disappeared while being checked' : dirProblem(st, uid);
}

/**
 * Create `dir` (mode 0700) if absent, then verify it is a private directory of
 * `uid` — not a symlink, a directory, owned by `uid`, no group/other permission
 * bits — and that no directory above it can be changed by other users (each
 * owned by `uid` or root, sticky if group/other-writable, not a symlink, so
 * `dir` must be a resolved path). Throws {@link UnsafeTempDirError} otherwise.
 * Returns `dir`.
 */
export async function ensurePrivateDir(dir: string, uid: number = currentUid(), lstatFn: LstatFn = lstat): Promise<string> {
    await verifyAncestors(path.dirname(dir), dir, uid, lstatFn);
    const problem = await createPrivateDir(dir, uid, lstatFn);
    if(problem !== undefined) {
        throw new UnsafeTempDirError(dir, problem);
    }
    return dir;
}

/**
 * Find or create this run's private directory and return its path:
 * `<realpath(baseDir)>/stryker-bun-runner-<uid>-<hash>-<slot>`, slot 0 to
 * {@link RUN_TEMP_DIR_SLOTS} - 1.
 *
 * The base directory and every directory above it are verified first (see
 * {@link ensurePrivateDir}); an unsafe one is refused with {@link UnsafeTempDirError}.
 *
 * Because the name can be guessed, another user may have created it first. Such
 * a slot is skipped rather than refused, so squatting a name blocks nothing.
 * All workers of a run still converge on one directory:
 *
 * 1. The lowest slot that already is a private directory of ours is used. Only
 *    we (or root) can create or change one, so every worker agrees on it.
 * 2. If there is none, each slot in turn is created if absent and used if it is
 *    then ours. Workers racing to create the same slot both end up with it (one
 *    creates it, the other finds it). Slots another user holds fail the check
 *    for every worker alike and are skipped by all.
 *
 * Step 1 coming first also covers a squatter who removes their slot after a
 * worker has skipped it: later workers find the worker's slot instead of
 * creating the freed one. If no slot is usable, it refuses, listing why.
 */
export async function resolveRunTempDir(key: RunTempDirKey = {}, lstatFn: LstatFn = lstat): Promise<string> {
    const uid = key.uid ?? currentUid();
    const baseDir = await realpath(key.baseDir ?? tmpdir());
    const prefix = runTempDirPrefix({ ...key, baseDir, uid });
    const slots = Array.from({ length: RUN_TEMP_DIR_SLOTS }, (_, n) => `${prefix}-${n}`);

    await verifyAncestors(baseDir, `${prefix}-<n>`, uid, lstatFn);

    /* eslint-disable no-await-in-loop -- slots are probed in order: the lowest usable one must win, for every worker alike */
    for(const slot of slots) {
        const st = await lstatIfExists(slot, lstatFn);
        if(st !== undefined && dirProblem(st, uid) === undefined) {
            return slot;
        }
    }

    const problems: string[] = [];
    for(const slot of slots) {
        const problem = await createPrivateDir(slot, uid, lstatFn);
        if(problem === undefined) {
            return slot;
        }
        problems.push(`${path.basename(slot)}: ${problem}`);
    }
    /* eslint-enable no-await-in-loop -- end of the ordered slot probing */

    throw new UnsafeTempDirError(
        `${prefix}-<n>`,
        `all ${RUN_TEMP_DIR_SLOTS} candidates (-0 to -${RUN_TEMP_DIR_SLOTS - 1}) are unusable (${problems.join('; ')})`
    );
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

/** What the cleanup reads of an lstat result: the checks' fields, and the modification time. */
export interface RunDirStat extends DirStat {
    readonly mtimeMs: number
}

/** A synchronous lstat: the cleanup below runs in an 'exit' listener, where nothing asynchronous completes. */
export type LstatSyncFn = (p: string) => RunDirStat;

/**
 * A run directory's name, `stryker-bun-runner-<uid>-<pid space>-<owner pid>-<hash>-<slot>`, with every
 * number written the way the runner writes it (no sign, no leading zero); captures the uid, the pid space
 * and the owner pid.
 */
const RUN_DIR_NAME_RE = /^stryker-bun-runner-(0|[1-9]\d*)-([0-9a-f]{8})-([1-9]\d*)-[0-9a-f]{16}-(?:0|[1-9]\d*)$/;

/**
 * How long a run directory whose owner looks dead must have gone unchanged before
 * another process removes it (the exiting owner removes its own at once). A live
 * run changes its directory well within this: every worker start writes files in
 * it, and a worker refreshes it at least every {@link RUN_DIR_TOUCH_INTERVAL_MS}
 * while it runs mutants. So only a directory nobody has worked in for an hour can
 * go, which protects a live run whose pid merely looks dead to the process
 * judging it (see {@link pidSpace}'s assumption).
 */
export const STALE_RUN_DIR_AGE_MS = 60 * 60 * 1000;

/** How often a worker refreshes its run directory's modification time while it runs mutants ({@link touchRunTempDir}). */
export const RUN_DIR_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

/** At most this many run directories are examined per cleanup, so an exit never stalls on a temp directory full of them. */
export const MAX_RUN_DIRS_EXAMINED = 1000;

/**
 * Set the run directory `dir`'s modification time to `now`, marking it in use
 * (see {@link STALE_RUN_DIR_AGE_MS}). Never throws: a directory that is gone or
 * cannot be touched only loses that protection.
 */
export function touchRunTempDir(dir: string, now: number = Date.now()): void {
    try {
        // eslint-disable-next-line n/no-sync -- one syscall every few minutes; an async call would hang under the fake timers of the runner's tests
        utimesSync(dir, now / 1000, now / 1000);
    } catch{
        // Gone, or not ours to touch: nothing to protect.
    }
}

/**
 * Whether a process with this pid exists (signal 0). Only ESRCH means it does
 * not: EPERM is a process that exists but belongs to someone else. A pid that
 * is not a positive integer is never signalled (0 and negative values address
 * process groups) and is reported as existing, so it is never taken for dead.
 */
export function processExists(pid: number): boolean {
    if(!Number.isSafeInteger(pid) || pid <= 0) {
        return true;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

/* eslint-disable n/no-sync -- the cleanup below runs in an 'exit' listener, where only synchronous work completes */

/** Whether no directory from `top` up to `/` could be changed by a user other than `uid` (see ancestorProblem). */
function ancestorsSafe(top: string, uid: number, lstatFn: LstatSyncFn): boolean {
    for(let component = top; ; component = path.dirname(component)) {
        if(ancestorProblem(lstatFn(component), uid) !== undefined) {
            return false;
        }
        if(component === path.dirname(component)) {
            return true;
        }
    }
}

/**
 * The real path of `baseDir` and the names of its entries, or undefined if it
 * cannot be read or a directory from it up to `/` could be changed by a user
 * other than `uid`.
 */
function listSafeBaseDir(baseDir: string | undefined, uid: number, lstatFn: LstatSyncFn): { base: string, names: string[] } | undefined {
    try {
        const base = realpathSync(baseDir ?? tmpdir());
        return ancestorsSafe(base, uid, lstatFn) ? { base, names: readdirSync(base) } : undefined;
    } catch{
        return undefined;
    }
}

/** The owner pid in `name` if it names a run directory of `uid` whose owner is in the pid space `space`, otherwise undefined. */
function runDirOwner(name: string, uid: number, space: string): number | undefined {
    const match = RUN_DIR_NAME_RE.exec(name);
    return match !== null && Number(match[1]) === uid && match[2] === space ? Number(match[3]) : undefined;
}

function removeTree(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

/** Options of {@link removeFinishedRunTempDirs}; every field defaults to the live process value. */
export interface FinishedRunCleanup {
    /** Directory the run directories are in. Defaults to os.tmpdir(), resolved like {@link resolveRunTempDir} resolves it. */
    baseDir?:     string
    /** The user whose run directories are removed. Defaults to process.getuid(); without one, nothing is removed. */
    uid?:         number
    /** The pid space whose run directories are judged. Defaults to {@link pidSpace}; if it is not known, nothing is removed. */
    pidSpace?:    PidSpace
    /** A process that is exiting: the runs it owns are over, although it is still alive. */
    exitingPid?:  number
    /** Whether a run's owner is alive. Defaults to {@link processExists}. */
    isAlive?:     (pid: number) => boolean
    /** How long another run's directory must have gone unchanged. Defaults to {@link STALE_RUN_DIR_AGE_MS}. */
    minAgeMs?:    number
    /** The current time, in ms since the epoch. Defaults to Date.now(). */
    now?:         number
    /** How many run directories to examine at most. Defaults to {@link MAX_RUN_DIRS_EXAMINED}. */
    maxExamined?: number
    /** Injectable for tests, like {@link LstatFn}. */
    lstat?:       LstatSyncFn
    /** Removes one directory and its contents. Injectable for tests. */
    remove?:      (dir: string) => void
}

/** A run directory found in the base directory, and the owner pid in its name. */
interface RunDirCandidate {
    readonly dir:   string
    readonly owner: number
}

/** What {@link runIsOver} judges by. */
interface RunJudge {
    readonly uid:        number
    readonly lstatFn:    LstatSyncFn
    readonly exitingPid: number | undefined
    readonly isAlive:    (pid: number) => boolean
    readonly minAgeMs:   number
    readonly now:        number
}

/**
 * Whether `candidate` is a private directory of ours (lstat, first: nothing is
 * probed for a directory that is not) whose run is over: its owner is the exiting
 * process, or it has gone unchanged for the minimum age and its owner no longer exists.
 */
function runIsOver({ dir, owner }: RunDirCandidate, judge: RunJudge): boolean {
    const st = judge.lstatFn(dir);
    if(dirProblem(st, judge.uid) !== undefined) {
        return false;
    }
    if(owner === judge.exitingPid) {
        return true;
    }
    return judge.now - st.mtimeMs >= judge.minAgeMs && !judge.isAlive(owner);
}

/**
 * Remove this user's run directories whose run is over, and return their paths.
 *
 * A run directory is used only by the workers of one Stryker run, and every one
 * of them is a child of that run's main process, whose pid is in the
 * directory's name ({@link runTempDirPrefix}). Stryker forks every worker of a
 * run, including the ones it restarts, from that process, and a worker it
 * restarts is forked only after the one it replaces has been disposed. So
 * while the main process lives, a worker may still need the registry, however
 * many workers are alive at the moment, and once it has exited, no worker of
 * that run can start again. A run is therefore over when its owner is
 * {@link FinishedRunCleanup.exitingPid}, or when its owner no longer exists and its
 * directory has gone unchanged for {@link STALE_RUN_DIR_AGE_MS} (a live run's pid
 * can look dead where one tag covers two process tables; see {@link pidSpace}).
 * A pid reused by an unrelated process reads as alive, which only delays the
 * removal. A pid from another pid space ({@link pidSpace}: another container
 * sharing the temp directory, another host) says nothing here, so such
 * directories are never judged, and with no known pid space of our own nothing is.
 * At most {@link MAX_RUN_DIRS_EXAMINED} directories are examined, the exiting
 * process's own first.
 *
 * Nothing is removed that the run directory checks would not accept as ours: an
 * entry is removed only if its name is a run directory's with our uid and pid
 * space in it, and lstat shows a real directory (a symlink is never followed or
 * removed) owned by us with no group or other permission bits. And nothing at all
 * is removed if a directory from the base up could be changed by another user, who
 * could otherwise swap a run directory for something else after the checks. Under
 * a safe base, only we (or root) can rename or replace our 0700 directory or
 * anything in it. The removal itself works by path (Node's recursive rm), so the
 * guarantee is per user: another user's files are never touched, while a process
 * of our own uid could still race it, as it could anything else of ours.
 *
 * Never throws: an entry that cannot be checked or removed is left as it is.
 * Synchronous, for use in an 'exit' listener ({@link removeRunTempDirsOnExit}).
 */
export function removeFinishedRunTempDirs(options: FinishedRunCleanup = {}): string[] {
    const uid = options.uid ?? process.getuid?.();
    const space = options.pidSpace ?? pidSpace();
    const lstatFn = options.lstat ?? lstatSync;
    const listing = uid === undefined || !space.known ? undefined : listSafeBaseDir(options.baseDir, uid, lstatFn);
    if(uid === undefined || listing === undefined) {
        return [];
    }
    const { exitingPid } = options;
    const candidates = listing.names
        .map(name => ({ dir: path.join(listing.base, name), owner: runDirOwner(name, uid, space.tag) }))
        .filter((candidate): candidate is RunDirCandidate => candidate.owner !== undefined)
        // The exiting process's own directories first, so the cap below never leaves one of them behind.
        .toSorted((a, b) => Number(b.owner === exitingPid) - Number(a.owner === exitingPid))
        .slice(0, options.maxExamined ?? MAX_RUN_DIRS_EXAMINED);
    const judge: RunJudge = {
        uid,
        lstatFn,
        exitingPid,
        isAlive:  options.isAlive ?? processExists,
        minAgeMs: options.minAgeMs ?? STALE_RUN_DIR_AGE_MS,
        now:      options.now ?? Date.now(),
    };
    const remove = options.remove ?? removeTree;
    return candidates.filter((candidate) => {
        try {
            if(!runIsOver(candidate, judge)) {
                return false;
            }
            remove(candidate.dir);
            return true;
        } catch{
            // Gone already, or not removable: left as it is.
            return false;
        }
    }).map(candidate => candidate.dir);
}

/* eslint-enable n/no-sync -- end of the synchronous cleanup */

/** The processes (event emitters) an exit cleanup is registered on. */
const exitCleanupRegistered = new WeakSet<object>();

/**
 * When `proc` (the current process) exits, remove the run directories of the
 * runs it owned, and those of runs whose owner has gone without removing its
 * own (a run killed outright). Registered once per process however often it is
 * called. See {@link removeFinishedRunTempDirs}.
 *
 * Called when the plugin is loaded (src/index.ts), which is how it gets into
 * Stryker's main process: Stryker gives a test runner no end-of-run hook, and
 * runs none of a test runner's code in the main process, but its plugin loader
 * imports the plugin there. At the end of a run the main process exits only
 * after disposing every worker (each disposed or, after 2 s, killed), so no
 * worker is left. On a signal, though, Stryker's handler disposes the sandbox
 * and calls process.exit without disposing the worker pool, so workers can
 * outlive it for a while. Their run is over all the same: nothing will take
 * their results, an in-flight bun test child of theirs may fail for the missing
 * files, and a worker whose parent has changed never recreates the directory
 * (BunTestRunner's orphan guard). In any other process the listener only removes
 * directories of runs that are over, so it is harmless there.
 */
export function removeRunTempDirsOnExit(proc: Pick<NodeJS.EventEmitter, 'once'> = process): void {
    if(exitCleanupRegistered.has(proc)) {
        return;
    }
    exitCleanupRegistered.add(proc);
    proc.once('exit', () => {
        try {
            removeFinishedRunTempDirs({ exitingPid: process.pid });
        } catch{
            // Cleanup must never change how the process exits.
        }
    });
}
