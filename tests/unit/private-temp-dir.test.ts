/**
 * Unit tests for utils/private-temp-dir
 *
 * Real filesystem throughout: every test works inside its own mkdtemp root under
 * the OS temp directory, injected as the base directory, so permission, ownership
 * and symlink checks run against the kernel rather than against mocks.
 *
 * Ownership by ANOTHER user cannot be set up without root (chown), so those
 * checks are exercised through the injectable lstat: {@link viewAs} reports the
 * real stat of every path, but as seen by a different current user and with
 * chosen paths re-owned. The real-chown variants additionally run as root.
 */

/* eslint-disable no-bitwise, sonarjs/file-permissions -- these tests read mode bitmasks and deliberately plant directories with unsafe permissions */
/* eslint-disable n/no-sync -- the exit cleanup under test is synchronous, and so are its fixtures */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
    computePidSpace,
    currentUid,
    ensurePrivateDir,
    MAX_RUN_DIRS_EXAMINED,
    pidSpace,
    processExists,
    removeFinishedRunTempDirs,
    removeRunTempDirsOnExit,
    resolveRunTempDir,
    RUN_DIR_TOUCH_INTERVAL_MS,
    runTempDirPrefix,
    RUN_TEMP_DIR_SLOTS,
    STALE_RUN_DIR_AGE_MS,
    touchRunTempDir,
    UnsafeTempDirError,
    writePrivateFile,
    type DirStat,
    type LstatFn,
    type RunDirStat
} from '../../src/utils/private-temp-dir.js';
import { mockMkdir, resetFsMocks } from '../test-preload.js';

const uid = process.getuid!();
/** A uid that is neither root nor (in practice) the user running the tests. */
const OTHER = 4321;
/** The uid the tests pretend to be when viewing the filesystem through {@link viewAs}. */
const ME = 4242;

/**
 * An lstat that reports the real filesystem as user `me` would see it if it
 * owned everything the test user owns: paths owned by the real test user are
 * reported as owned by `me`, other owners (root) unchanged, and the paths in
 * `owners` as owned by the given uid.
 */
function viewAs(me: number, owners: Record<string, number> = {}): LstatFn {
    return async (p: string): Promise<DirStat> => {
        const st = await fsPromises.lstat(p);
        const owner = owners[p] ?? (st.uid === uid ? me : st.uid);
        return { uid: owner, mode: st.mode, isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() };
    };
}

function hash16(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

describe('private-temp-dir', () => {
    let root: string;

    beforeEach(async () => {
        // Resolved: on macOS os.tmpdir() lies under the /var -> /private/var symlink, which the checks refuse.
        root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(tmpdir(), 'sbr-private-dir-test-')));
    });

    afterEach(async () => {
        resetFsMocks();
        // Restore owner write/search everywhere first so rm can descend into dirs a test locked down.
        await fsPromises.chmod(root, 0o700);
        await fsPromises.rm(root, { recursive: true, force: true });
    });

    async function modeOf(p: string): Promise<number> {
        const st = await fsPromises.lstat(p);
        return st.mode & 0o7777;
    }

    async function exists(p: string): Promise<boolean> {
        return fsPromises.lstat(p).then(() => true).catch(() => false);
    }

    describe('currentUid', () => {
        it('returns process.getuid()', () => {
            expect(currentUid()).toBe(uid);
        });

        it('throws when the user id cannot be determined', () => {
            const original = process.getuid;
            (process as { getuid?: () => number }).getuid = undefined;
            try {
                expect(() => currentUid()).toThrow('stryker-bun-runner: cannot determine the current user id');
            } finally {
                process.getuid = original;
            }
        });
    });

    describe('UnsafeTempDirError', () => {
        it('names the directory and the problem, and tells the user how to fix it', () => {
            const err = new UnsafeTempDirError('/tmp/x', 'it is a symbolic link');
            // Shown by Stryker/loggers as the error's name
            expect(err.name).toBe('UnsafeTempDirError');
            expect(err.message).toBe(
                'stryker-bun-runner: refusing to use temporary directory /tmp/x: it is a symbolic link. '
                + 'The runner writes a script there that every bun test child executes, so neither the directory nor any directory above it may be changeable by other users. '
                + 'Remove the directory if you trust it, or set TMPDIR to a directory that only you and root control.'
            );
        });
    });

    describe('runTempDirPrefix', () => {
        it('names the directory stryker-bun-runner-<uid>-<pid space>-<ppid>-<sha256(cwd:ppid) first 16 hex chars> under the base dir', () => {
            expect(runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 501, pidSpace: 'abcdef01' }))
                .toBe(path.join(root, `stryker-bun-runner-501-abcdef01-4242-${hash16('/sandbox/one:4242')}`));
        });

        it('defaults to os.tmpdir(), process.cwd(), process.ppid, the current uid and this process\'s pid space', () => {
            const hash = hash16(`${process.cwd()}:${process.ppid}`);
            expect(runTempDirPrefix()).toBe(path.join(tmpdir(), `stryker-bun-runner-${uid}-${pidSpace().tag}-${process.ppid}-${hash}`));
        });

        it('derives a different prefix in another pid space (another container sharing the temp directory)', () => {
            const key = { baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid };
            expect(runTempDirPrefix({ ...key, pidSpace: 'abcdef01' })).not.toBe(runTempDirPrefix({ ...key, pidSpace: 'abcdef02' }));
        });

        it('derives the same prefix for every worker of one run (same cwd and Stryker main pid)', () => {
            const key = { baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid };
            expect(runTempDirPrefix({ ...key })).toBe(runTempDirPrefix({ ...key }));
        });

        it('derives a different prefix when the cwd, the parent pid or the user differs', () => {
            const base = runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 501 });
            expect(runTempDirPrefix({ baseDir: root, cwd: '/sandbox/two', ppid: 4242, uid: 501 })).not.toBe(base);
            expect(runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: 4243, uid: 501 })).not.toBe(base);
            expect(runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 502 })).not.toBe(base);
        });
    });

    describe('ensurePrivateDir', () => {
        it('creates the directory with mode 0700, owned by the current user, and returns it', async () => {
            const dir = path.join(root, 'run');
            expect(await ensurePrivateDir(dir)).toBe(dir);

            const st = await fsPromises.lstat(dir);
            expect(st.isDirectory()).toBe(true);
            expect(st.uid).toBe(uid);
            expect(st.mode & 0o777).toBe(0o700);
        });

        it('creates it 0700 even under a permissive umask', async () => {
            const previous = process.umask(0);
            try {
                const dir = path.join(root, 'run');
                await ensurePrivateDir(dir);
                expect(await modeOf(dir)).toBe(0o700);
            } finally {
                process.umask(previous);
            }
        });

        it('accepts a directory it already created (a second worker of the same run)', async () => {
            const dir = path.join(root, 'run');
            await ensurePrivateDir(dir);
            await fsPromises.writeFile(path.join(dir, 'registry.json'), '{}');

            expect(await ensurePrivateDir(dir)).toBe(dir);
            // Re-verifying must not disturb what is already in it
            expect(await fsPromises.readFile(path.join(dir, 'registry.json'), 'utf8')).toBe('{}');
        });

        it('refuses an existing directory that group or others can access', async () => {
            const dir = path.join(root, 'run');
            await fsPromises.mkdir(dir);
            await fsPromises.chmod(dir, 0o755);

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`refusing to use temporary directory ${dir}: it has mode 0755; it must not be accessible to group or others (0700).`);
        });

        it('refuses a directory that is only group-readable', async () => {
            const dir = path.join(root, 'run');
            await fsPromises.mkdir(dir);
            await fsPromises.chmod(dir, 0o740);

            await expect(ensurePrivateDir(dir)).rejects.toThrow('has mode 0740');
        });

        it('refuses a directory owned by another user', async () => {
            const dir = path.join(root, 'run');
            await fsPromises.mkdir(dir, { mode: 0o700 });

            const err = await ensurePrivateDir(dir, ME, viewAs(ME, { [dir]: OTHER })).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`${dir}: it is owned by uid ${OTHER}, not the current user (uid ${ME}).`);
        });

        it('refuses a symlink at the directory path, even one pointing at a private directory', async () => {
            const target = path.join(root, 'elsewhere');
            await fsPromises.mkdir(target, { mode: 0o700 });
            const dir = path.join(root, 'run');
            await fsPromises.symlink(target, dir);

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`${dir}: it is a symbolic link.`);
        });

        it('refuses a non-directory at the directory path', async () => {
            const dir = path.join(root, 'run');
            await fsPromises.writeFile(dir, 'not a dir');

            await expect(ensurePrivateDir(dir)).rejects.toThrow(`${dir}: it is not a directory.`);
        });

        it('refuses a directory that disappears between its creation and its check', async () => {
            const dir = path.join(root, 'run');
            const vanishing: LstatFn = (p: string) => (p === dir
                ? Promise.reject(Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }))
                : fsPromises.lstat(p));

            await expect(ensurePrivateDir(dir, uid, vanishing)).rejects.toThrow(`${dir}: it disappeared while being checked.`);
        });

        it('propagates an lstat failure other than ENOENT', async () => {
            const dir = path.join(root, 'run');
            const failing: LstatFn = (p: string) => (p === dir
                ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
                : fsPromises.lstat(p));

            await expect(ensurePrivateDir(dir, uid, failing)).rejects.toThrow('EACCES: permission denied');
        });

        it('refuses a parent directory that other users can write to without the sticky bit', async () => {
            const parent = path.join(root, 'shared');
            await fsPromises.mkdir(parent);
            await fsPromises.chmod(parent, 0o777);
            const dir = path.join(parent, 'run');

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(
                `${dir}: ${parent} (a directory above it) is writable by other users and lacks the sticky bit (mode 0777), so they could replace it.`
            );
            // Refused before creating anything
            expect(await exists(dir)).toBe(false);
        });

        it('refuses a group-writable parent without the sticky bit', async () => {
            const parent = path.join(root, 'shared');
            await fsPromises.mkdir(parent);
            await fsPromises.chmod(parent, 0o770);

            await expect(ensurePrivateDir(path.join(parent, 'run'))).rejects.toThrow('lacks the sticky bit (mode 0770)');
        });

        it('accepts a world-writable parent that has the sticky bit (like /tmp)', async () => {
            const parent = path.join(root, 'shared');
            await fsPromises.mkdir(parent);
            await fsPromises.chmod(parent, 0o1777);
            const dir = path.join(parent, 'run');

            expect(await ensurePrivateDir(dir)).toBe(dir);
            expect(await modeOf(dir)).toBe(0o700);
        });

        it('refuses a non-sticky writable directory further up, not just the parent (OpenSSH safe_path)', async () => {
            // root/shared (0777, no sticky) / mine (0700) / run: whoever can write `shared` can rename `mine` away and rebuild it.
            const shared = path.join(root, 'shared');
            const mine = path.join(shared, 'mine');
            await fsPromises.mkdir(mine, { recursive: true });
            await fsPromises.chmod(mine, 0o700);
            await fsPromises.chmod(shared, 0o777);
            const dir = path.join(mine, 'run');

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`${dir}: ${shared} (a directory above it) is writable by other users and lacks the sticky bit (mode 0777)`);
            expect(await exists(dir)).toBe(false);
        });

        it('refuses a parent owned by another (non-root) user, who could rename the directory away', async () => {
            const dir = path.join(root, 'run');

            const err = await ensurePrivateDir(dir, ME, viewAs(ME, { [root]: OTHER })).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(
                `${dir}: ${root} (a directory above it) is owned by uid ${OTHER}, who could replace it; every directory above it must belong to you or to root.`
            );
            expect(await exists(dir)).toBe(false);
        });

        it('refuses a directory further up owned by another (non-root) user', async () => {
            const dir = path.join(root, 'a', 'b', 'run');
            await fsPromises.mkdir(path.dirname(dir), { recursive: true });

            await expect(ensurePrivateDir(dir, ME, viewAs(ME, { [root]: OTHER })))
                .rejects.toThrow(`${root} (a directory above it) is owned by uid ${OTHER}`);
        });

        it('checks every directory up to and including the filesystem root', async () => {
            await expect(ensurePrivateDir(path.join(root, 'run'), ME, viewAs(ME, { '/': OTHER })))
                .rejects.toThrow(`/ (a directory above it) is owned by uid ${OTHER}`);
        });

        it('accepts directories above it that belong to root or to the current user', async () => {
            // Seen as user ME: root (the mkdtemp dir) is owned by root, its sub-directory `mine` by ME.
            const mine = path.join(root, 'mine');
            await fsPromises.mkdir(mine, { mode: 0o700 });
            const dir = path.join(mine, 'run');

            expect(await ensurePrivateDir(dir, ME, viewAs(ME, { [root]: 0 }))).toBe(dir);
        });

        it('refuses a symlink among the directories above it: callers must pass resolved paths', async () => {
            const real = path.join(root, 'real');
            await fsPromises.mkdir(real, { mode: 0o700 });
            const link = path.join(root, 'link');
            await fsPromises.symlink(real, link);
            const dir = path.join(link, 'run');

            await expect(ensurePrivateDir(dir)).rejects.toThrow(`${link} (a directory above it) is a symbolic link; the path must be fully resolved`);
            expect(await exists(path.join(real, 'run'))).toBe(false);
        });

        // Real chown needs root; the injected-owner tests above cover the same checks as any user.
        it.if(uid === 0)('refuses a parent really owned by another (non-root) user', async () => {
            const parent = path.join(root, 'theirs');
            await fsPromises.mkdir(parent, { mode: 0o755 });
            await fsPromises.chown(parent, 1234, 1234);

            await expect(ensurePrivateDir(path.join(parent, 'run'))).rejects.toThrow(`${parent} (a directory above it) is owned by uid 1234`);
        });

        it.if(uid === 0)('accepts root-owned directories above a directory really belonging to another (non-root) user', async () => {
            const dir = path.join(root, 'run');
            await fsPromises.mkdir(dir, { mode: 0o700 });
            await fsPromises.chown(dir, 1234, 1234);

            expect(await ensurePrivateDir(dir, 1234)).toBe(dir);
        });

        it('propagates a mkdir failure other than EEXIST', async () => {
            mockMkdir.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

            await expect(ensurePrivateDir(path.join(root, 'run'))).rejects.toThrow('EACCES: permission denied');
        });
    });

    describe('resolveRunTempDir', () => {
        const key = { cwd: '/sandbox/one', ppid: 4242 };
        /** Slot `n` of the run directory for {@link key} under `base`, seen as user `owner`. */
        const slot = (n: number, base: string = root, owner: number = uid): string =>
            `${runTempDirPrefix({ ...key, baseDir: base, uid: owner })}-${n}`;

        it('creates slot 0, mode 0700, and returns it', async () => {
            expect(await resolveRunTempDir({ ...key, baseDir: root })).toBe(slot(0));

            const st = await fsPromises.lstat(slot(0));
            expect(st.isDirectory()).toBe(true);
            expect(st.uid).toBe(uid);
            expect(st.mode & 0o777).toBe(0o700);
            expect(await exists(slot(1))).toBe(false);
        });

        it('defaults to os.tmpdir() ($TMPDIR), process.cwd(), process.ppid and the current uid', async () => {
            const tmpdirSpy = spyOn(os, 'tmpdir').mockReturnValue(root);
            const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/sandbox/defaults');
            const hash = hash16(`/sandbox/defaults:${process.ppid}`);
            try {
                expect(await resolveRunTempDir()).toBe(path.join(root, `stryker-bun-runner-${uid}-${pidSpace().tag}-${process.ppid}-${hash}-0`));
            } finally {
                cwdSpy.mockRestore();
                tmpdirSpy.mockRestore();
            }
        });

        it('every worker of a run converges on the same directory, also when they race', async () => {
            const first = await resolveRunTempDir({ ...key, baseDir: root });
            expect(await resolveRunTempDir({ ...key, baseDir: root })).toBe(first);

            const raced = { ...key, cwd: '/sandbox/raced' };
            const [a, b, c] = await Promise.all([
                resolveRunTempDir({ ...raced, baseDir: root }),
                resolveRunTempDir({ ...raced, baseDir: root }),
                resolveRunTempDir({ ...raced, baseDir: root }),
            ]);
            expect(a).toBe(`${runTempDirPrefix({ ...raced, baseDir: root, uid })}-0`);
            expect(b).toBe(a);
            expect(c).toBe(a);
        });

        it('uses the real path of a symlinked base directory (TMPDIR) for the run directory', async () => {
            const real = path.join(root, 'real');
            await fsPromises.mkdir(real, { mode: 0o700 });
            const link = path.join(root, 'link');
            await fsPromises.symlink(real, link);

            expect(await resolveRunTempDir({ ...key, baseDir: link })).toBe(slot(0, real));
            expect(await exists(slot(0, real))).toBe(true);
        });

        it('checks the directories above the REAL base directory, not above the symlink', async () => {
            // The link sits in a safe directory, but its target is under a non-sticky world-writable one.
            const shared = path.join(root, 'shared');
            const real = path.join(shared, 'real');
            await fsPromises.mkdir(real, { recursive: true });
            await fsPromises.chmod(real, 0o700);
            await fsPromises.chmod(shared, 0o777);
            const link = path.join(root, 'link');
            await fsPromises.symlink(real, link);

            await expect(resolveRunTempDir({ ...key, baseDir: link })).rejects.toThrow(`${shared} (a directory above it) is writable by other users and lacks the sticky bit`);
        });

        it('refuses a base directory that other users can write to without the sticky bit, creating nothing', async () => {
            const base = path.join(root, 'base');
            await fsPromises.mkdir(base);
            await fsPromises.chmod(base, 0o777);

            const err = await resolveRunTempDir({ ...key, baseDir: base }).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(
                `refusing to use temporary directory ${runTempDirPrefix({ ...key, baseDir: base, uid })}-<n>: ${base} (a directory above it) is writable by other users`
            );
            expect(await fsPromises.readdir(base)).toEqual([]);
        });

        it('refuses a misconfigured TMPDIR under a writable non-sticky ancestor (the planted-preload attack), naming the ancestor and the remedy', async () => {
            // TMPDIR=/srv/scratch/me where /srv/scratch is world-writable without the sticky bit
            const scratch = path.join(root, 'scratch');
            const me = path.join(scratch, 'me');
            await fsPromises.mkdir(me, { recursive: true });
            await fsPromises.chmod(me, 0o700);
            await fsPromises.chmod(scratch, 0o777);

            const err = await resolveRunTempDir({ ...key, baseDir: me }).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`${scratch} (a directory above it) is writable by other users and lacks the sticky bit (mode 0777)`);
            expect((err as Error).message).toContain('set TMPDIR to a directory that only you and root control');
            expect(await fsPromises.readdir(me)).toEqual([]);
        });

        it('refuses a base directory with a directory above it owned by another user, creating nothing', async () => {
            const me = path.join(root, 'me');
            await fsPromises.mkdir(me, { mode: 0o700 });

            await expect(resolveRunTempDir({ ...key, baseDir: me, uid: ME }, viewAs(ME, { [root]: OTHER })))
                .rejects.toThrow(`${root} (a directory above it) is owned by uid ${OTHER}, who could replace it`);
            expect(await fsPromises.readdir(me)).toEqual([]);
        });

        it.if(uid === 0)('refuses a base directory under a directory really owned by another user (the reviewer\'s rename-and-rebuild attack)', async () => {
            const grand = path.join(root, 'grand');
            const parent = path.join(grand, 'parent');
            await fsPromises.mkdir(parent, { recursive: true });
            await fsPromises.chmod(parent, 0o700);
            await fsPromises.chown(grand, 1234, 1234);

            await expect(resolveRunTempDir({ ...key, baseDir: parent })).rejects.toThrow(`${grand} (a directory above it) is owned by uid 1234`);
        });

        it('skips a slot another user created; every worker converges on the next one', async () => {
            // The attacker pre-created slot 0 (simulated: real directory, reported as theirs).
            await fsPromises.mkdir(slot(0, root, ME), { mode: 0o700 });
            const lstatFn = viewAs(ME, { [slot(0, root, ME)]: OTHER });

            const workerA = await resolveRunTempDir({ ...key, baseDir: root, uid: ME }, lstatFn);
            const workerB = await resolveRunTempDir({ ...key, baseDir: root, uid: ME }, lstatFn);

            expect(workerA).toBe(slot(1, root, ME));
            expect(workerB).toBe(workerA);
            expect(await modeOf(workerA)).toBe(0o700);
        });

        it.if(uid === 0)('skips a slot really owned by another user', async () => {
            await fsPromises.mkdir(slot(0), { mode: 0o700 });
            await fsPromises.chown(slot(0), 1234, 1234);

            expect(await resolveRunTempDir({ ...key, baseDir: root })).toBe(slot(1));
        });

        it('skips slots that are not private, are symlinks, or are not directories', async () => {
            await fsPromises.mkdir(slot(0));
            await fsPromises.chmod(slot(0), 0o755);
            const elsewhere = path.join(root, 'elsewhere');
            await fsPromises.mkdir(elsewhere, { mode: 0o700 });
            await fsPromises.symlink(elsewhere, slot(1));
            await fsPromises.writeFile(slot(2), 'not a dir');

            expect(await resolveRunTempDir({ ...key, baseDir: root })).toBe(slot(3));
            expect(await fsPromises.readdir(elsewhere)).toEqual([]);
        });

        it('prefers an existing directory of its own over creating a lower slot, so workers converge after a squatter leaves', async () => {
            // Worker A skipped a squatted slot 0 and created slot 1; the squatter then removed slot 0.
            await fsPromises.mkdir(slot(1), { mode: 0o700 });

            expect(await resolveRunTempDir({ ...key, baseDir: root })).toBe(slot(1));
            expect(await exists(slot(0))).toBe(false);
        });

        it('skips a slot that disappears between its creation and its check', async () => {
            const vanishing: LstatFn = (p: string) => (p === slot(0)
                ? Promise.reject(Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }))
                : fsPromises.lstat(p));

            expect(await resolveRunTempDir({ ...key, baseDir: root }, vanishing)).toBe(slot(1));
        });

        it('propagates an lstat failure other than ENOENT', async () => {
            const failing: LstatFn = (p: string) => (p === slot(0)
                ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
                : fsPromises.lstat(p));

            await expect(resolveRunTempDir({ ...key, baseDir: root }, failing)).rejects.toThrow('EACCES: permission denied');
        });

        it(`refuses loudly, listing every candidate's problem, when all ${RUN_TEMP_DIR_SLOTS} slots are taken`, async () => {
            expect(RUN_TEMP_DIR_SLOTS).toBe(16);
            await Promise.all(Array.from({ length: 16 }, (_, n) => fsPromises.writeFile(slot(n), 'squatted')));

            const err = await resolveRunTempDir({ ...key, baseDir: root }).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            const prefix = runTempDirPrefix({ ...key, baseDir: root, uid });
            const problems = Array.from({ length: 16 }, (_, n) => `${path.basename(prefix)}-${n}: it is not a directory`).join('; ');
            expect((err as Error).message).toContain(
                `refusing to use temporary directory ${prefix}-<n>: all 16 candidates (-0 to -15) are unusable (${problems}).`
            );
            // A 17th is never tried
            expect(await exists(slot(16))).toBe(false);
        });
    });

    describe('writePrivateFile', () => {
        it('writes the content with mode 0600', async () => {
            const file = path.join(root, 'preload.ts');
            await writePrivateFile(file, 'console.log(1);');

            expect(await fsPromises.readFile(file, 'utf8')).toBe('console.log(1);');
            expect(await modeOf(file)).toBe(0o600);
        });

        it('writes mode 0600 even under a permissive umask', async () => {
            const previous = process.umask(0);
            try {
                const file = path.join(root, 'preload.ts');
                await writePrivateFile(file, 'x');
                expect(await modeOf(file)).toBe(0o600);
            } finally {
                process.umask(previous);
            }
        });

        it('replaces an existing file (a stale file from a previous worker with the same pid)', async () => {
            const file = path.join(root, 'preload.ts');
            await fsPromises.writeFile(file, 'stale', { mode: 0o644 });

            await writePrivateFile(file, 'fresh');

            expect(await fsPromises.readFile(file, 'utf8')).toBe('fresh');
            expect(await modeOf(file)).toBe(0o600);
        });

        it('creates the file exclusively: something reappearing at the path after the removal is refused, not written through', async () => {
            const victim = path.join(root, 'victim.txt');
            await fsPromises.writeFile(victim, 'untouched');
            const file = path.join(root, 'preload.ts');
            await fsPromises.symlink(victim, file);
            // Simulate the path being re-planted between the removal and the create
            const rmSpy = spyOn(fsPromises, 'rm').mockResolvedValue(undefined);
            try {
                await expect(writePrivateFile(file, 'fresh')).rejects.toThrow('EEXIST');
            } finally {
                rmSpy.mockRestore();
            }
            expect(await fsPromises.readFile(victim, 'utf8')).toBe('untouched');
        });

        it('replaces a symlink at the path instead of writing through it', async () => {
            const victim = path.join(root, 'victim.txt');
            await fsPromises.writeFile(victim, 'untouched');
            const file = path.join(root, 'preload.ts');
            await fsPromises.symlink(victim, file);

            await writePrivateFile(file, 'fresh');

            const st = await fsPromises.lstat(file);
            expect(st.isSymbolicLink()).toBe(false);
            expect(await fsPromises.readFile(file, 'utf8')).toBe('fresh');
            expect(await fsPromises.readFile(victim, 'utf8')).toBe('untouched');
        });
    });

    describe('pidSpace', () => {
        const tag = (ids: string): string => createHash('sha256').update(ids).digest('hex').slice(0, 8);

        it('tags a Linux pid space by its boot id and pid namespace', () => {
            expect(computePidSpace('linux', () => 'boot-1:pid:[4026531836]')).toEqual({ tag: tag('boot-1:pid:[4026531836]'), known: true });
            expect(computePidSpace('linux', () => 'boot-1:pid:[4026532001]').tag).not.toBe(computePidSpace('linux', () => 'boot-1:pid:[4026531836]').tag);
            expect(computePidSpace('linux', () => 'boot-2:pid:[4026531836]').tag).not.toBe(computePidSpace('linux', () => 'boot-1:pid:[4026531836]').tag);
        });

        it('is unknown on Linux when /proc cannot tell it, with a sentinel tag of its own, never another platform\'s constant', () => {
            const unknown = computePidSpace('linux', () => {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            });
            expect(unknown).toEqual({ tag: tag('stryker-bun-runner: unknown Linux pid space'), known: false });
            expect(unknown.tag).not.toBe(computePidSpace('darwin').tag);
        });

        it('is one known pid space per host elsewhere, without reading /proc', () => {
            const read = (): string => {
                throw new Error('must not be read');
            };
            expect(computePidSpace('darwin', read)).toEqual({ tag: tag(''), known: true });
        });

        // Not memoized like pidSpace(), so this test itself runs the /proc reads.
        it.if(process.platform === 'linux')('reads the boot id (trimmed) and the pid namespace link from /proc by default', () => {
            const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
            const pidNs = readlinkSync('/proc/self/ns/pid');
            expect(bootId).toMatch(/^[0-9a-f-]{36}\n$/);
            expect(pidNs).toMatch(/^pid:\[\d+\]$/);

            expect(computePidSpace('linux')).toEqual({ tag: tag(`${bootId.trim()}:${pidNs}`), known: true });
            expect(computePidSpace()).toEqual(computePidSpace('linux'));
        });

        it('reads this process\'s pid space once', () => {
            expect(pidSpace()).toBe(pidSpace());
            if(process.platform === 'linux') {
                const ids = `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${readlinkSync('/proc/self/ns/pid')}`;
                expect(pidSpace()).toEqual({ tag: tag(ids), known: true });
            }
        });
    });

    // Owner pids above every kernel's pid range (pid_max is at most 2^22 on Linux; macOS pids stay below 100000),
    // so no process ever has them: DEAD is dead for real. LIVE and EXITING are alive only through the injected isAlive.
    const DEAD = 5_000_001;
    const LIVE = 5_000_002;
    const EXITING = 5_000_003;
    const isAlive = (pid: number): boolean => pid !== DEAD;
    const byName = (a: string, b: string): number => a.localeCompare(b);

    describe('processExists', () => {
        it('is true for a running process', () => {
            expect(processExists(process.pid)).toBe(true);
        });

        it('is false for a pid no process has (above every kernel\'s pid range)', () => {
            expect(processExists(DEAD)).toBe(false);
        });

        it('is true when the process exists but may not be signalled (EPERM): another user\'s process is not a dead one', () => {
            const killSpy = spyOn(process, 'kill').mockImplementation(() => {
                throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
            });
            try {
                expect(processExists(12_345)).toBe(true);
            } finally {
                killSpy.mockRestore();
            }
        });

        it('never signals pid 0 or a negative pid (a process group) and reports them alive, as it does a non-integer', () => {
            const killSpy = spyOn(process, 'kill');
            try {
                expect([0, -1, -4242, 1.5, Number.NaN].map(pid => processExists(pid))).toEqual([true, true, true, true, true]);
                expect(killSpy).not.toHaveBeenCalled();
            } finally {
                killSpy.mockRestore();
            }
        });
    });

    /** How long ago {@link runDir} sets a directory's modification time by default: past the age gate. */
    const TWO_HOURS = 2 * 60 * 60 * 1000;

    /** Set `p`'s modification time `ageMs` into the past. */
    function age(p: string, ageMs: number = TWO_HOURS): void {
        const then = (Date.now() - ageMs) / 1000;
        utimesSync(p, then, then);
    }

    /** Create a run directory (mode 0700) of `owner`'s run under root, with a registry in it, last changed `ageMs` ago, and return its path. */
    function runDir(owner: number, opts: { uid?: number, cwd?: string, slot?: number, pidSpace?: string, ageMs?: number } = {}): string {
        const key = { baseDir: root, cwd: opts.cwd ?? '/sandbox/one', ppid: owner, uid: opts.uid ?? uid, pidSpace: opts.pidSpace };
        const dir = `${runTempDirPrefix(key)}-${opts.slot ?? 0}`;
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(path.join(dir, 'registry.json'), '{"version":2}', { mode: 0o600 });
        age(dir, opts.ageMs);
        return dir;
    }

    function existsSync(p: string): boolean {
        try {
            lstatSync(p);
            return true;
        } catch{
            return false;
        }
    }

    describe('removeFinishedRunTempDirs', () => {
        it('removes the directories of a run whose Stryker main process is gone, contents and all', () => {
            const stale = runDir(DEAD);
            const staleSlot = runDir(DEAD, { slot: 3 });

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive }).toSorted(byName)).toEqual([stale, staleSlot].toSorted(byName));

            expect(existsSync(stale)).toBe(false);
            expect(existsSync(staleSlot)).toBe(false);
        });

        it('removes a symlink inside a finished run\'s directory, never what it points at', () => {
            const outside = path.join(root, 'outside');
            mkdirSync(outside, { mode: 0o700 });
            writeFileSync(path.join(outside, 'precious'), 'keep');
            const stale = runDir(DEAD);
            symlinkSync(outside, path.join(stale, 'link-to-dir'));
            symlinkSync(path.join(outside, 'precious'), path.join(stale, 'link-to-file'));
            // Adding the links changed the directory: back past the age gate.
            age(stale);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([stale]);

            expect(existsSync(stale)).toBe(false);
            expect(readFileSync(path.join(outside, 'precious'), 'utf8')).toBe('keep');
        });

        it('leaves the directory of a run whose Stryker main process is alive, so a worker started or restarted later still finds the registry', () => {
            const live = runDir(LIVE);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);

            expect(readFileSync(path.join(live, 'registry.json'), 'utf8')).toBe('{"version":2}');
        });

        it('removes the exiting process\'s own run directories, though it is still alive, and only those of the live ones', () => {
            const mine = runDir(EXITING);
            const mineOtherSandbox = runDir(EXITING, { cwd: '/sandbox/two' });
            const concurrent = runDir(LIVE);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING }).toSorted(byName)).toEqual([mine, mineOtherSandbox].toSorted(byName));

            expect(existsSync(mine)).toBe(false);
            expect(existsSync(mineOtherSandbox)).toBe(false);
            expect(readFileSync(path.join(concurrent, 'registry.json'), 'utf8')).toBe('{"version":2}');
        });

        it('defaults to os.tmpdir(), the current uid and real process liveness, and treats no process as exiting', () => {
            const stale = runDir(DEAD);
            const ownedByMe = runDir(process.pid);
            const tmpdirSpy = spyOn(os, 'tmpdir').mockReturnValue(root);
            try {
                expect(removeFinishedRunTempDirs()).toEqual([stale]);
            } finally {
                tmpdirSpy.mockRestore();
            }
            expect(existsSync(ownedByMe)).toBe(true);
        });

        it('works from the real path of a symlinked base directory (TMPDIR)', () => {
            const real = path.join(root, 'real');
            mkdirSync(real, { mode: 0o700 });
            const link = path.join(root, 'link');
            symlinkSync(real, link);
            const stale = `${runTempDirPrefix({ baseDir: real, cwd: '/sandbox/one', ppid: DEAD, uid })}-0`;
            mkdirSync(stale, { mode: 0o700 });
            age(stale);

            expect(removeFinishedRunTempDirs({ baseDir: link, isAlive })).toEqual([stale]);
        });

        it('never follows or removes a symlink named like a finished run\'s directory, nor what it points at', () => {
            const target = path.join(root, 'target');
            mkdirSync(target, { mode: 0o700 });
            writeFileSync(path.join(target, 'precious'), 'keep');
            const link = `${runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: DEAD, uid })}-0`;
            symlinkSync(target, link);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);

            expect(lstatSync(link).isSymbolicLink()).toBe(true);
            expect(readFileSync(path.join(target, 'precious'), 'utf8')).toBe('keep');
        });

        it('leaves a directory owned by another user, though its name carries ours (a squatted slot)', () => {
            const squatted = runDir(DEAD);
            const asOtherOwner = (p: string): RunDirStat => {
                const st = lstatSync(p);
                return { uid: p === squatted ? OTHER : st.uid, mode: st.mode, mtimeMs: st.mtimeMs, isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() };
            };

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, lstat: asOtherOwner })).toEqual([]);

            expect(existsSync(path.join(squatted, 'registry.json'))).toBe(true);
        });

        // Real chown needs root; the injected-owner test above covers the same check as any user.
        it.if(uid === 0)('leaves a directory really owned by another (non-root) user', () => {
            const squatted = runDir(DEAD);
            chownSync(squatted, 1234, 1234);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);

            expect(existsSync(path.join(squatted, 'registry.json'))).toBe(true);
        });

        it('leaves a directory open to group or others, which the runner never made', () => {
            const loose = runDir(DEAD);
            chmodSync(loose, 0o750);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);

            expect(existsSync(loose)).toBe(true);
        });

        it('leaves entries that are not this user\'s run directories: another uid, a file, older names without an owner pid, and other names', () => {
            const otherUid = runDir(DEAD, { uid: uid + 1 });
            const file = `${runTempDirPrefix({ baseDir: root, cwd: '/sandbox/file', ppid: DEAD, uid })}-0`;
            writeFileSync(file, 'not a directory');
            // The name format of runner versions that did not record the owner: nothing says whose run it was.
            const legacy = path.join(root, `stryker-bun-runner-${uid}-${hash16('/sandbox/one:1')}-0`);
            mkdirSync(legacy, { mode: 0o700 });
            // An owner pid without a pid space: not a name this runner makes, so not judged either.
            const untaggedHash = hash16(`/sandbox/one:${DEAD}`);
            const untagged = path.join(root, `stryker-bun-runner-${uid}-${DEAD}-${untaggedHash}-0`);
            mkdirSync(untagged, { mode: 0o700 });
            const unrelated = ['stryker-bun-runner-bench.lock', `stryker-bun-runner-${uid}-${DEAD}-nothex-0`, `x-stryker-bun-runner-${uid}-${DEAD}-${hash16('a')}-0`]
                .map((name) => {
                    const p = path.join(root, name);
                    mkdirSync(p, { mode: 0o700 });
                    return p;
                });

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);

            for(const p of [otherUid, file, legacy, untagged, ...unrelated]) {
                expect(existsSync(p)).toBe(true);
            }
        });

        it('never judges a directory from another pid space (a container sharing the temp directory): its pids are not ours, even one equal to the exiting pid', () => {
            const other = pidSpace().tag === 'ffffffff' ? 'fffffffe' : 'ffffffff';
            const foreignDead = runDir(DEAD, { pidSpace: other });
            const foreignSamePid = runDir(EXITING, { pidSpace: other });
            const mine = runDir(EXITING);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING })).toEqual([mine]);

            expect(existsSync(path.join(foreignDead, 'registry.json'))).toBe(true);
            expect(existsSync(path.join(foreignSamePid, 'registry.json'))).toBe(true);
        });

        it('removes nothing when its own pid space is unknown, not even the exiting process\'s directories', () => {
            const stale = runDir(DEAD);
            const mine = runDir(EXITING);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING, pidSpace: { tag: pidSpace().tag, known: false } })).toEqual([]);

            expect(existsSync(stale)).toBe(true);
            expect(existsSync(mine)).toBe(true);
        });

        it('removes nothing when another user could change a directory above the base (it could swap a run directory in after the checks)', () => {
            const stale = runDir(DEAD);
            chmodSync(root, 0o777);

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);

            expect(existsSync(stale)).toBe(true);
        });

        it('checks every directory above the base, up to the root, not just the base itself', () => {
            const base = path.join(root, 'base');
            mkdirSync(base, { mode: 0o700 });
            const stale = `${runTempDirPrefix({ baseDir: base, cwd: '/sandbox/one', ppid: DEAD, uid })}-0`;
            mkdirSync(stale, { mode: 0o700 });
            age(stale);
            // Safe base, unsafe parent: another user could rename the base away.
            chmodSync(root, 0o777);
            expect(removeFinishedRunTempDirs({ baseDir: base, isAlive })).toEqual([]);
            expect(existsSync(stale)).toBe(true);

            // And the walk reaches `/`: every directory up to it is looked at, then it stops.
            chmodSync(root, 0o700);
            const looked: string[] = [];
            const recording = (p: string): RunDirStat => {
                looked.push(p);
                return lstatSync(p);
            };
            expect(removeFinishedRunTempDirs({ baseDir: base, isAlive, lstat: recording })).toEqual([stale]);
            const ancestors: string[] = [];
            for(let dir = base; ; dir = path.dirname(dir)) {
                ancestors.push(dir);
                if(dir === path.dirname(dir)) {
                    break;
                }
            }
            expect(looked).toEqual([...ancestors, stale]);
        });

        it('removes nothing, and does not throw, when the base directory is missing or the uid unknown', () => {
            expect(removeFinishedRunTempDirs({ baseDir: path.join(root, 'missing'), isAlive })).toEqual([]);
            const stale = runDir(DEAD);
            const getuid = process.getuid;
            (process as { getuid?: () => number }).getuid = undefined;
            try {
                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive })).toEqual([]);
            } finally {
                process.getuid = getuid;
            }
            expect(existsSync(stale)).toBe(true);
        });

        it('goes on with the other directories when one cannot be removed, and does not report it removed', () => {
            const stuck = runDir(DEAD);
            const stale = runDir(DEAD, { cwd: '/sandbox/two' });
            const remove = (dir: string): void => {
                if(dir === stuck) {
                    throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
                }
                rmSync(dir, { recursive: true });
            };

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, remove })).toEqual([stale]);

            expect(existsSync(stuck)).toBe(true);
            expect(existsSync(stale)).toBe(false);
        });

        it('asks about the owner of this user\'s run directories only', () => {
            runDir(LIVE, { uid: uid + 1 });
            mkdirSync(path.join(root, `stryker-bun-runner-${uid}-${hash16('/sandbox/one:1')}-0`), { mode: 0o700 });
            const asked: number[] = [];

            removeFinishedRunTempDirs({ baseDir: root, isAlive: (pid) => {
                asked.push(pid);
                return true;
            } });

            expect(asked).toEqual([]);
        });

        it('judges only names written the way the runner writes them: no leading zero, no pid 0', () => {
            const space = pidSpace().tag;
            const hash = hash16('/sandbox/one:x');
            const odd = [
                `stryker-bun-runner-0${uid}-${space}-${DEAD}-${hash}-0`,
                `stryker-bun-runner-${uid}-${space}-0${DEAD}-${hash}-0`,
                `stryker-bun-runner-${uid}-${space}-0-${hash}-0`,
                `stryker-bun-runner-${uid}-${space}-${DEAD}-${hash}-01`,
                `stryker-bun-runner-+${uid}-${space}-${DEAD}-${hash}-0`,
            ].map((name) => {
                const p = path.join(root, name);
                mkdirSync(p, { mode: 0o700 });
                age(p);
                return p;
            });
            const asked: number[] = [];

            expect(removeFinishedRunTempDirs({ baseDir: root, isAlive: (pid) => {
                asked.push(pid);
                return false;
            } })).toEqual([]);

            expect(asked).toEqual([]);
            for(const p of odd) {
                expect(existsSync(p)).toBe(true);
            }
        });

        it('checks the directory with lstat before it probes the owner: a symlink, a loose or a foreign directory never costs a signal', () => {
            const loose = runDir(DEAD);
            chmodSync(loose, 0o750);
            const target = path.join(root, 'target');
            mkdirSync(target, { mode: 0o700 });
            symlinkSync(target, `${runTempDirPrefix({ baseDir: root, cwd: '/sandbox/link', ppid: DEAD, uid })}-0`);
            const foreign = runDir(DEAD, { cwd: '/sandbox/foreign' });
            const asForeign = (p: string): RunDirStat => {
                const st = lstatSync(p);
                return { uid: p === foreign ? OTHER : st.uid, mode: st.mode, mtimeMs: st.mtimeMs, isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() };
            };
            const asked: number[] = [];

            const recording = (pid: number): boolean => {
                asked.push(pid);
                return false;
            };
            expect(removeFinishedRunTempDirs({ baseDir: root, lstat: asForeign, isAlive: recording })).toEqual([]);

            expect(asked).toEqual([]);
        });

        describe('age gate', () => {
            it('leaves a dead owner\'s directory changed within the last hour: its pid may only look dead (a VM snapshot clone shares the tag, not the process table)', () => {
                const fresh = runDir(DEAD, { ageMs: 0 });
                const asked: number[] = [];

                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive: (pid) => {
                    asked.push(pid);
                    return false;
                } })).toEqual([]);

                expect(existsSync(path.join(fresh, 'registry.json'))).toBe(true);
                // Not even probed: the age is checked first.
                expect(asked).toEqual([]);
            });

            // A fixed title: one built from the constant would change under the mutants that change the constant.
            it('removes it once it has gone unchanged for STALE_RUN_DIR_AGE_MS (an hour), not a millisecond before', () => {
                expect(STALE_RUN_DIR_AGE_MS).toBe(60 * 60 * 1000);
                const stale = runDir(DEAD, { ageMs: 0 });
                const { mtimeMs } = lstatSync(stale);

                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, now: mtimeMs + STALE_RUN_DIR_AGE_MS - 1 })).toEqual([]);
                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, now: mtimeMs + STALE_RUN_DIR_AGE_MS })).toEqual([stale]);
            });

            it('takes the minimum age from the options', () => {
                const stale = runDir(DEAD, { ageMs: 10_000 });

                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, minAgeMs: 60_000 })).toEqual([]);
                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, minAgeMs: 5000 })).toEqual([stale]);
            });

            it('does not delay the exiting process\'s own directories, however recently changed', () => {
                const mine = runDir(EXITING, { ageMs: 0 });

                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING })).toEqual([mine]);
            });

            it('is kept fresh by a working run: workers refresh their directory well within it', () => {
                expect(RUN_DIR_TOUCH_INTERVAL_MS).toBe(10 * 60 * 1000);
                expect(RUN_DIR_TOUCH_INTERVAL_MS * 3).toBeLessThan(STALE_RUN_DIR_AGE_MS);
            });
        });

        describe('cap', () => {
            it('examines at most MAX_RUN_DIRS_EXAMINED (1000) directories by default', () => {
                expect(MAX_RUN_DIRS_EXAMINED).toBe(1000);
            });

            it('examines at most maxExamined directories, the exiting process\'s own first', () => {
                const stale = ['/sandbox/a', '/sandbox/b', '/sandbox/c'].map(cwd => runDir(DEAD, { cwd }));
                const mine = runDir(EXITING, { cwd: '/sandbox/z' });

                const removed = removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING, maxExamined: 2 });

                expect(removed).toHaveLength(2);
                expect(removed).toContain(mine);
                expect(stale.filter(dir => existsSync(dir))).toHaveLength(2);
            });

            it('moves the exiting process\'s own directories ahead of the rest, keeping the listing\'s order otherwise', () => {
                const stale = ['/sandbox/a', '/sandbox/b', '/sandbox/c', '/sandbox/d'].map(cwd => runDir(DEAD, { cwd }));
                const mine = ['/sandbox/y', '/sandbox/z'].map(cwd => runDir(EXITING, { cwd }));
                // The listing puts the exiting process's directories late.
                const order = [stale[0], stale[1], mine[0], stale[2], mine[1], stale[3]].map(dir => path.basename(dir));
                const readdir = (): string[] => order;

                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING, maxExamined: 3, readdir })).toEqual([mine[0], mine[1], stale[0]]);
                expect(removeFinishedRunTempDirs({ baseDir: root, isAlive, exitingPid: EXITING, maxExamined: 3, readdir: () => order.filter(name => existsSync(path.join(root, name))) }))
                    .toEqual([stale[1], stale[2], stale[3]]);
            });
        });
    });

    describe('touchRunTempDir', () => {
        it('sets the directory\'s access and modification times to now (utimes takes seconds)', () => {
            const dir = runDir(LIVE);
            const now = Date.now();

            touchRunTempDir(dir, now);

            const st = lstatSync(dir);
            expect(Math.abs(st.mtimeMs - now)).toBeLessThan(1000);
            expect(Math.abs(st.atimeMs - now)).toBeLessThan(1000);
        });

        it('defaults to the current time', () => {
            const dir = runDir(LIVE);
            const before = Date.now();

            touchRunTempDir(dir);

            expect(lstatSync(dir).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
        });

        it('never throws, for a directory that is gone', () => {
            expect(() => touchRunTempDir(path.join(root, 'gone'), Date.now())).not.toThrow();
        });
    });

    // A stand-in for `process`, which is an EventEmitter, not an EventTarget.
    /* eslint-disable unicorn/prefer-event-target -- see above */
    describe('removeRunTempDirsOnExit', () => {
        it('registers one exit listener per process however often it is called, which removes the exiting process\'s run directories', () => {
            const proc = new EventEmitter();
            const tmpdirSpy = spyOn(os, 'tmpdir').mockReturnValue(root);
            const mine = `${runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: process.pid, uid })}-0`;
            mkdirSync(mine, { mode: 0o700 });
            // The listener checks real liveness: this test's parent process stands in for a concurrent run's main process.
            const concurrent = runDir(process.ppid);
            try {
                removeRunTempDirsOnExit(proc);
                removeRunTempDirsOnExit(proc);
                expect(proc.listenerCount('exit')).toBe(1);
                expect(existsSync(mine)).toBe(true);

                proc.emit('exit', 0);
            } finally {
                tmpdirSpy.mockRestore();
            }
            expect(existsSync(mine)).toBe(false);
            expect(existsSync(concurrent)).toBe(true);
        });

        it('never lets a cleanup failure escape the exit listener', () => {
            const proc = new EventEmitter();
            const getuidSpy = spyOn(process, 'getuid').mockImplementation(() => {
                throw new Error('getuid failed');
            });
            try {
                removeRunTempDirsOnExit(proc);
                expect(() => proc.emit('exit', 0)).not.toThrow();
                expect(getuidSpy).toHaveBeenCalled();
            } finally {
                getuidSpy.mockRestore();
            }
        });
    });
    /* eslint-enable unicorn/prefer-event-target -- end of the process stand-ins */
});
