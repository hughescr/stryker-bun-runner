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

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
    currentUid,
    ensurePrivateDir,
    resolveRunTempDir,
    runTempDirPrefix,
    RUN_TEMP_DIR_SLOTS,
    UnsafeTempDirError,
    writePrivateFile,
    type DirStat,
    type LstatFn
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
        it('names the directory stryker-bun-runner-<uid>-<sha256(cwd:ppid) first 16 hex chars> under the base dir', () => {
            expect(runTempDirPrefix({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 501 }))
                .toBe(path.join(root, `stryker-bun-runner-501-${hash16('/sandbox/one:4242')}`));
        });

        it('defaults to os.tmpdir(), process.cwd(), process.ppid and the current uid', () => {
            const hash = hash16(`${process.cwd()}:${process.ppid}`);
            expect(runTempDirPrefix()).toBe(path.join(tmpdir(), `stryker-bun-runner-${uid}-${hash}`));
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
                expect(await resolveRunTempDir()).toBe(path.join(root, `stryker-bun-runner-${uid}-${hash}-0`));
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
});
