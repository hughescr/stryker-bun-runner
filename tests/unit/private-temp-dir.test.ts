/**
 * Unit tests for utils/private-temp-dir
 *
 * Real filesystem throughout: every test works inside its own mkdtemp root under
 * the OS temp directory, injected as the base directory, so permission, ownership
 * and symlink checks run against the kernel rather than against mocks.
 */

/* eslint-disable no-bitwise, sonarjs/file-permissions -- these tests read mode bitmasks and deliberately plant directories with unsafe permissions */

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
    currentUid,
    ensurePrivateDir,
    runTempDirPath,
    UnsafeTempDirError,
    writePrivateFile
} from '../../src/utils/private-temp-dir.js';
import { mockMkdir, resetFsMocks } from '../test-preload.js';

const uid = process.getuid!();

describe('private-temp-dir', () => {
    let root: string;

    beforeEach(async () => {
        root = await fsPromises.mkdtemp(path.join(tmpdir(), 'sbr-private-dir-test-'));
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

    describe('runTempDirPath', () => {
        it('names the directory stryker-bun-runner-<uid>-<sha256(cwd:ppid) first 16 hex chars> under the base dir', () => {
            const hash = createHash('sha256').update('/sandbox/one:4242').digest('hex').slice(0, 16);
            expect(runTempDirPath({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 501 }))
                .toBe(path.join(root, `stryker-bun-runner-501-${hash}`));
        });

        it('defaults to os.tmpdir(), process.cwd(), process.ppid and the current uid', () => {
            const hash = createHash('sha256').update(`${process.cwd()}:${process.ppid}`).digest('hex').slice(0, 16);
            expect(runTempDirPath()).toBe(path.join(tmpdir(), `stryker-bun-runner-${uid}-${hash}`));
        });

        it('derives the same path for every worker of one run (same cwd and Stryker main pid)', () => {
            const key = { baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid };
            expect(runTempDirPath({ ...key })).toBe(runTempDirPath({ ...key }));
        });

        it('derives a different path when the cwd, the parent pid or the user differs', () => {
            const base = runTempDirPath({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 501 });
            expect(runTempDirPath({ baseDir: root, cwd: '/sandbox/two', ppid: 4242, uid: 501 })).not.toBe(base);
            expect(runTempDirPath({ baseDir: root, cwd: '/sandbox/one', ppid: 4243, uid: 501 })).not.toBe(base);
            expect(runTempDirPath({ baseDir: root, cwd: '/sandbox/one', ppid: 4242, uid: 502 })).not.toBe(base);
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
            // Shown by Stryker/loggers as the error's name
            expect((err as Error).name).toBe('UnsafeTempDirError');
            expect((err as Error).message).toContain(`refusing to use temporary directory ${dir}`);
            expect((err as Error).message).toContain('has mode 0755');
            expect((err as Error).message).toContain('TMPDIR');
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

            // The directory belongs to the test's own uid; seen from any other uid it is "someone else's".
            const err = await ensurePrivateDir(dir, uid + 1).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`is owned by uid ${uid}, not the current user (uid ${uid + 1})`);
        });

        it('refuses a symlink at the directory path, even one pointing at a private directory', async () => {
            const target = path.join(root, 'elsewhere');
            await fsPromises.mkdir(target, { mode: 0o700 });
            const dir = path.join(root, 'run');
            await fsPromises.symlink(target, dir);

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain('is a symbolic link');
        });

        it('refuses a non-directory at the directory path', async () => {
            const dir = path.join(root, 'run');
            await fsPromises.writeFile(dir, 'not a dir');

            await expect(ensurePrivateDir(dir)).rejects.toThrow('is not a directory');
        });

        it('refuses a parent directory that other users can write to without the sticky bit', async () => {
            const parent = path.join(root, 'shared');
            await fsPromises.mkdir(parent);
            await fsPromises.chmod(parent, 0o777);
            const dir = path.join(parent, 'run');

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`its parent ${parent} is writable by other users and lacks the sticky bit`);
            // Refused before creating anything
            await expect(fsPromises.lstat(dir)).rejects.toThrow();
        });

        it('refuses a group-writable parent without the sticky bit', async () => {
            const parent = path.join(root, 'shared');
            await fsPromises.mkdir(parent);
            await fsPromises.chmod(parent, 0o770);

            await expect(ensurePrivateDir(path.join(parent, 'run'))).rejects.toThrow('lacks the sticky bit');
        });

        it('accepts a world-writable parent that has the sticky bit (like /tmp)', async () => {
            const parent = path.join(root, 'shared');
            await fsPromises.mkdir(parent);
            await fsPromises.chmod(parent, 0o1777);
            const dir = path.join(parent, 'run');

            expect(await ensurePrivateDir(dir)).toBe(dir);
            expect(await modeOf(dir)).toBe(0o700);
        });

        // chown needs root; under a normal user these two are skipped and every other test exercises a self-owned parent.
        it.if(uid === 0)('refuses a parent owned by another (non-root) user, who could rename the directory away', async () => {
            const parent = path.join(root, 'theirs');
            await fsPromises.mkdir(parent, { mode: 0o755 });
            await fsPromises.chown(parent, 1234, 1234);
            const dir = path.join(parent, 'run');

            const err = await ensurePrivateDir(dir).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(UnsafeTempDirError);
            expect((err as Error).message).toContain(`its parent ${parent} is owned by uid 1234, who could replace it`);
        });

        it.if(uid === 0)('accepts a root-owned parent for a directory belonging to another (non-root) user', async () => {
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
