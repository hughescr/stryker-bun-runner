/**
 * The run's private temporary directory is removed when the run ends, through a
 * real process tree shaped like a Stryker run.
 *
 * A "main" process plays Stryker's main process: it loads the plugin entry
 * (src/index.ts), as Stryker's plugin loader does, and spawns "workers" as its
 * direct children, as Stryker forks its test-runner workers. Each worker finds
 * the run directory the way the runner does (resolveRunTempDir: uid, parent pid
 * and cwd) and reads or writes the dry-run registry there. Workers run one step
 * at a time, so a step's workers are gone before the next step's start: that is
 * how Stryker restarts a worker (dispose and kill the old process, then fork and
 * init a new one), for maxTestRunnerReuse, a timeout or a crash.
 *
 * TMPDIR points at a fresh, resolved directory per test (macOS: tmpdir() lies
 * under the /var -> /private/var symlink, which the directory checks refuse).
 *
 * Every wait is on a process event or a pipe, never a timer.
 */

/* eslint-disable n/no-sync -- fixtures and checks between process events; nothing else runs meanwhile */

import { chownSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { runTempDirPrefix } from '../../src/utils/private-temp-dir.js';

const uid = process.getuid!();
const indexUrl = new URL('../../src/index.ts', import.meta.url).href;
const privateTempDirUrl = new URL('../../src/utils/private-temp-dir.ts', import.meta.url).href;

/**
 * A worker. `dry` writes the registry the way the dry run does (a private tmp file renamed into
 * place); `mutant` writes a file of its own and removes it again, as dispose() does. Both then
 * read the registry and print what they saw.
 */
const WORKER = [
    `const { resolveRunTempDir, writePrivateFile } = await import(${JSON.stringify(privateTempDirUrl)});`,
    "const { readFile, rename, rm } = await import('node:fs/promises');",
    'const dir = await resolveRunTempDir();',
    "const registryPath = dir + '/registry.json';",
    "if(process.env.WORKER_ACTION === 'dry') {",
    "    await writePrivateFile(registryPath + '.tmp', JSON.stringify({ writer: process.pid }));",
    "    await rename(registryPath + '.tmp', registryPath);",
    '} else {',
    "    const own = dir + '/preload-' + process.pid + '.ts';",
    "    await writePrivateFile(own, '// preload');",
    '    await rm(own);',
    '}',
    "const registry = await readFile(registryPath, 'utf8').then(JSON.parse, (error) => ({ error: error.code }));",
    'console.log(JSON.stringify({ dir, registry, pid: process.pid }));',
].join('\n');

/**
 * The main process. RUN_STEPS is a `;`-separated list of steps: workers to run at once
 * (actions joined by `|`), `wait` (until a line arrives on stdin) or `hang` (stay alive until killed).
 */
const MAIN = [
    `await import(${JSON.stringify(indexUrl)});`,
    "for(const step of process.env.RUN_STEPS.split(';')) {",
    "    if(step === 'wait') {",
    '        const reader = Bun.stdin.stream().getReader();',
    '        await reader.read();',
    '        await reader.cancel();',
    '        continue;',
    '    }',
    "    if(step === 'hang') {",
    '        setInterval(() => {}, 1 << 30);',
    '        console.log(JSON.stringify({ hanging: true }));',
    '        break;',
    '    }',
    "    const results = await Promise.all(step.split('|').map(async (action) => {",
    `        const worker = Bun.spawn([process.execPath, '--eval', ${JSON.stringify(WORKER)}], { env: { ...process.env, WORKER_ACTION: action }, stdout: 'pipe', stderr: 'inherit' });`,
    '        const out = await new Response(worker.stdout).text();',
    '        if(await worker.exited !== 0) {',
    "            throw new Error('worker failed: ' + out);",
    '        }',
    '        return JSON.parse(out);',
    '    }));',
    '    for(const result of results) {',
    '        console.log(JSON.stringify(result));',
    '    }',
    '}',
].join('\n');

interface WorkerReport {
    dir:      string
    registry: { writer?: number, error?: string }
    pid:      number
}

/** Reads a stream line by line, each line on demand. */
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- executed only by Bun's integration-test runtime
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    return async () => {
        for(;;) {
            const newline = buffered.indexOf('\n');
            if(newline !== -1) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                return line;
            }
            // eslint-disable-next-line no-await-in-loop -- one chunk at a time until a whole line is in
            const { value, done } = await reader.read();
            if(done) {
                throw new Error(`the main process's output ended without a complete line (had: ${JSON.stringify(buffered)})`);
            }
            buffered += decoder.decode(value, { stream: true });
        }
    };
}

function exists(p: string): boolean {
    try {
        lstatSync(p);
        return true;
    } catch{
        return false;
    }
}

/** The run directories (of any user, any format) in `base`. */
function runDirsIn(base: string): string[] {
    return readdirSync(base).filter(name => name.startsWith('stryker-bun-runner-'))
        .map(name => path.join(base, name));
}

/** A pid that belonged to a process that has exited and been reaped. */
function deadPid(): number {
    return Bun.spawnSync(['true']).pid;
}

describe('the run directory is removed when the run ends', () => {
    let base: string;
    const live: ReturnType<typeof Bun.spawn>[] = [];

    afterEach(async () => {
        for(const proc of live.splice(0)) {
            proc.kill('SIGKILL');
            // eslint-disable-next-line no-await-in-loop -- reaped one at a time; there are at most two
            await proc.exited;
        }
        await rm(base, { recursive: true, force: true });
    });

    async function freshBase(): Promise<string> {
        base = await realpath(await mkdtemp(path.join(tmpdir(), 'sbr-run-cleanup-')));
        mkdirSync(path.join(base, 'sandbox'));
        return base;
    }

    /** Start a main process (a Stryker run) in the shared sandbox directory. */
    function startRun(steps: string): { proc: Bun.Subprocess<'pipe', 'pipe', 'inherit'>, next: () => Promise<string> } {
        const proc = Bun.spawn([process.execPath, '--eval', MAIN], {
            cwd:    path.join(base, 'sandbox'),
            env:    { ...process.env, TMPDIR: base, RUN_STEPS: steps },
            stdin:  'pipe',
            stdout: 'pipe',
            stderr: 'inherit',
        });
        live.push(proc);
        // Created on first use: a reader locks the stream, and run() reads it whole instead.
        let read: (() => Promise<string>) | undefined;
        const next = async (): Promise<string> => {
            read ??= lineReader(proc.stdout);
            return read();
        };
        return { proc, next };
    }

    /** Run a main process to its normal end and return what its workers reported. */
    async function run(steps: string): Promise<WorkerReport[]> {
        const { proc } = startRun(steps);
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- executed only by Bun's integration-test runtime
        const out = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        return out.trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as WorkerReport);
    }

    it('a normal run leaves no directory, though its workers shared it until the end', async () => {
        await freshBase();

        const reports = await run('dry;mutant|mutant');

        const [dry, ...mutants] = reports;
        expect(reports).toHaveLength(3);
        // Every worker used the same directory, and the later ones found the dry run's registry in it.
        expect(new Set(reports.map(r => r.dir)).size).toBe(1);
        expect(path.dirname(dry.dir)).toBe(base);
        for(const mutant of mutants) {
            expect(mutant.registry).toEqual({ writer: dry.pid });
        }
        expect(runDirsIn(base)).toEqual([]);
    }, 30_000);

    it('a worker started after the previous one was disposed and killed (a restart) still finds the registry', async () => {
        await freshBase();

        // Each step's workers are gone before the next step's start, as in Stryker's
        // dispose-then-recreate restart; with one worker, none is alive in between.
        const reports = await run('dry;mutant;mutant;mutant');

        const [dry, ...restarted] = reports;
        expect(restarted).toHaveLength(3);
        for(const worker of restarted) {
            expect(worker.dir).toBe(dry.dir);
            expect(worker.registry).toEqual({ writer: dry.pid });
        }
        expect(runDirsIn(base)).toEqual([]);
    }, 30_000);

    it('two concurrent runs in the same sandbox never remove each other\'s directory', async () => {
        await freshBase();
        const second = startRun('dry;wait;mutant');
        const secondDry = JSON.parse(await second.next()) as WorkerReport;

        // The first run starts and ends while the second one is still going.
        const [firstDry] = await run('dry;mutant');

        expect(firstDry.dir).not.toBe(secondDry.dir);
        expect(exists(firstDry.dir)).toBe(false);
        expect(JSON.parse(readFileSync(path.join(secondDry.dir, 'registry.json'), 'utf8'))).toEqual({ writer: secondDry.pid });

        // The second run's next worker still finds its registry; then the second run ends too.
        await second.proc.stdin.write('go\n');
        await second.proc.stdin.end();
        const secondMutant = JSON.parse(await second.next()) as WorkerReport;
        expect(secondMutant.registry).toEqual({ writer: secondDry.pid });
        expect(await second.proc.exited).toBe(0);
        expect(runDirsIn(base)).toEqual([]);
    }, 30_000);

    it('the directory of a run that was killed outright is removed when a later run ends', async () => {
        await freshBase();
        const killed = startRun('dry;hang');
        const { dir } = JSON.parse(await killed.next()) as WorkerReport;
        expect(JSON.parse(await killed.next())).toEqual({ hanging: true });

        // SIGKILL: no exit handler runs, so the directory stays behind for now.
        killed.proc.kill('SIGKILL');
        await killed.proc.exited;
        expect(exists(path.join(dir, 'registry.json'))).toBe(true);

        await run('dry');

        expect(runDirsIn(base)).toEqual([]);
    }, 30_000);

    it('leaves the directory of a run whose main process is still alive', async () => {
        await freshBase();
        // A process that stays alive for the whole test, standing in for another run's main process.
        const owner = Bun.spawn(['sleep', '600']);
        live.push(owner);
        const liveDir = `${runTempDirPrefix({ baseDir: base, cwd: '/elsewhere', ppid: owner.pid, uid })}-0`;
        mkdirSync(liveDir, { mode: 0o700 });
        writeFileSync(path.join(liveDir, 'registry.json'), '{}');

        await run('dry');

        expect(runDirsIn(base)).toEqual([liveDir]);
        expect(readFileSync(path.join(liveDir, 'registry.json'), 'utf8')).toBe('{}');
    }, 30_000);

    it('never touches a symlink named like a finished run\'s directory, what it points at, or a directory another user owns', async () => {
        await freshBase();
        const dead = deadPid();
        const target = path.join(base, 'target');
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(path.join(target, 'precious'), 'keep');
        const link = `${runTempDirPrefix({ baseDir: base, cwd: '/elsewhere', ppid: dead, uid })}-0`;
        symlinkSync(target, link);
        const kept = [link];
        // Real chown needs root; tests/unit/private-temp-dir.test.ts covers the ownership check as any user.
        if(uid === 0) {
            const foreign = `${runTempDirPrefix({ baseDir: base, cwd: '/elsewhere', ppid: dead, uid })}-1`;
            mkdirSync(foreign, { mode: 0o700 });
            chownSync(foreign, 1234, 1234);
            kept.push(foreign);
        }

        await run('dry');

        const byName = (a: string, b: string): number => a.localeCompare(b);
        expect(runDirsIn(base).toSorted(byName)).toEqual(kept.toSorted(byName));
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(path.join(target, 'precious'), 'utf8')).toBe('keep');
    }, 30_000);
});
