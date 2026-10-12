/**
 * Mutant runs hide passing tests (real bun children, bun 1.4.0 and 1.4.2 measured).
 *
 * Mutant runs use the sanitized bunfig's mutant-run copy, which sets
 * `[test].onlyFailures = true`: bun then prints no line for a passing, skipped
 * or pending test, which on a whole-suite run is most of its output. What the
 * runner scores a mutant run from still prints: the failing tests with their
 * file headers, the summary counts, the `Ran N tests` and `Bailed out` lines,
 * the zero-match error, `# Unhandled error between tests` blocks, and anything
 * the tests (or the coverage preload's hit-limit report) write themselves.
 *
 * The first part runs one real bun child per outcome with the dry run's bunfig
 * and with the mutant-run copy, and checks that the parser reads the same
 * verdict out of both. The second part pins the runner's result for every
 * outcome through a real BunTestRunner (the hit limit is pinned the same way in
 * hit-limit-integration.test.ts).
 *
 * Bun prints passing tests unless an AI-agent variable (CLAUDECODE, AGENT, …)
 * switches it to its quiet agent reporter, so those are removed for this file.
 */

import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, type MutantRunOptions, type MutantRunResult } from '@stryker-mutator/api/test-runner';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { parseBunTestOutput } from '../../src/parsers/console-parser.js';
import { killAllLiveChildren, removeSignalCleanup, runBunTests, stripAnsi, type BunProcessResult } from '../../src/process-runner.js';
import { generateSanitizedBunfig, mutantRunBunfigPath } from '../../src/utils/bunfig-sanitizer.js';
import { resolveRunTempDir } from '../../src/utils/private-temp-dir.js';
import { rememberEnv } from '../helpers/env.js';
import { allowRealTimersFromSource } from '../real-clock-guard.js';
import { resetAllMocks } from '../test-preload.js';

// Real bun children: the runner's own timers have to run on real time here.
allowRealTimersFromSource();

/** Variables that change what `bun test` prints (see bench/README.md); FORCE_COLOR also breaks the inspector-URL scrape. */
const OUTPUT_CHANGING_ENV = ['CLAUDECODE', 'AGENT', 'AI_AGENT', 'REPL_ID', 'CURSOR_TRACE_ID', 'GITHUB_ACTIONS', 'FORCE_COLOR', 'NO_COLOR'];

/**
 * The active mutant: as the coverage preload sets it before any test file loads, or, for the
 * children spawned here without the preload, from the variable runBunTests passes it in.
 */
const ACTIVE = 'const active = () => globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__;';

const FILES: Record<string, string> = {
    'a.test.ts': [
        "import { describe, expect, test } from 'bun:test';",
        ACTIVE,
        "describe('A', () => {",
        "    test('a1', () => { console.log('chatter from a1'); expect(1).toBe(1); });",
        "    test('a2', () => { expect(['kill', 'two'].includes(active()) ? 2 : 1).toBe(1); });",
        "    test.skip('a skipped', () => {});",
        "    test.todo('a todo');",
        '});',
    ].join('\n'),
    'b.test.ts': [
        "import { expect, test } from 'bun:test';",
        ACTIVE,
        // A passing test that prints a line shaped like the header of another file of the run.
        "test('b1', () => { if(active() === 'noise') { console.error('a.test.ts:'); } expect(1).toBe(1); });",
        "test('b2', () => { expect(['two', 'noise', 'failExit'].includes(active()) ? 2 : 1).toBe(1); });",
        // Exits with tests of its own file still to run.
        "test('b3', () => { if(['exit0', 'failExit'].includes(active())) { process.exit(0); } if(active() === 'exit1') { process.exit(1); } });",
        "test('b title ' + (active() === 'rename' ? 'renamed' : 'plain'), () => { expect(active() === 'rename' ? 2 : 1).toBe(1); });",
        // The file's last test.
        "test('b hangs', async () => { if(active() === 'exitLast') { process.exit(0); } if(active() === 'hang') { await new Promise(() => {}); } });",
    ].join('\n'),
    'c.test.ts': [
        "import { expect, test } from 'bun:test';",
        ACTIVE,
        "if(active() === 'load') { throw new TypeError('boom at load'); }",
        "if(active() === 'exitLoad') { process.exit(0); }",
        "test('c1', () => { expect(1).toBe(1); });",
    ].join('\n'),
    'd.test.ts': [
        "import { describe, expect, test } from 'bun:test';",
        ACTIVE,
        "describe('D', () => {",
        "    if(active() === 'describe') { throw new Error('describe threw'); }",
        "    test('d1', () => { expect(1).toBe(1); });",
        '});',
    ].join('\n'),
    'e.test.ts': [
        "import { afterEach, beforeAll, describe, expect, test } from 'bun:test';",
        ACTIVE,
        "describe('E', () => {",
        "    beforeAll(() => { if(active() === 'beforeAll') { throw new Error('beforeAll threw'); } });",
        "    afterEach(() => { if(active() === 'afterEach') { throw new Error('afterEach threw'); } if(active() === 'exitHook') { process.exit(0); } });",
        "    test('e1', () => { expect(1).toBe(1); });",
        // Expected to throw; it fails when the mutant makes it pass.
        "    test.failing('e failing', () => { if(active() !== 'failing') { throw new Error('expected'); } });",
        '});',
    ].join('\n'),
};

const silentLogger = {
    debug:          () => {},
    info:           () => {},
    warn:           () => {},
    error:          () => {},
    trace:          () => {},
    fatal:          () => {},
    isDebugEnabled: () => false,
    isInfoEnabled:  () => false,
    isWarnEnabled:  () => false,
    isErrorEnabled: () => false,
    isTraceEnabled: () => false,
    isFatalEnabled: () => false,
} as unknown as Logger;

let tempDir: string;
let testFiles: string[];
let restoreEnv: () => void;
let originalCwd: string;

beforeAll(async () => {
    restoreEnv = rememberEnv();
    for(const name of OUTPUT_CHANGING_ENV) {
        Reflect.deleteProperty(process.env, name);
    }
    tempDir = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(tmpdir(), 'quiet-output-integration-')));
    await fsPromises.mkdir(path.join(tempDir, 'private'), { mode: 0o700 });
    testFiles = Object.keys(FILES).map(name => path.join(tempDir, name));
    await Promise.all(Object.entries(FILES).map(([name, content]) => fsPromises.writeFile(path.join(tempDir, name), content)));
    // The fixture is the project, as a Stryker sandbox is: bun prints its headers relative to it.
    originalCwd = process.cwd();
    process.chdir(tempDir);
});

afterEach(() => {
    // The runner's real children go through the preload's shared mocks, and its first
    // spawn attaches the signal-cleanup listeners: undo both after each test.
    killAllLiveChildren();
    removeSignalCleanup();
    resetAllMocks();
});

afterAll(async () => {
    process.chdir(originalCwd);
    restoreEnv();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
    await fsPromises.rm(await resolveRunTempDir(), { recursive: true, force: true });
    resetAllMocks();
});

describe('the mutant-run bunfig in a real bun test child', () => {
    interface Outcome { name: string, active: string, bail: boolean, pattern?: string }
    /** Each outcome, with what the dry run's bunfig gives for it (the second part shows how the runner scores it). */
    const OUTCOMES: [Outcome, Record<string, unknown>][] = [
        [{ name: 'every test passes', active: 'none', bail: true }, { exitCode: 0, failedTests: 0, summaryPassed: 11 }],
        [{ name: 'a test fails, with bail', active: 'kill', bail: true }, { exitCode: 1, failedTests: 1, bailLine: 'Bailed out after 1 failure' }],
        [{ name: 'two tests fail, without bail', active: 'two', bail: false }, { exitCode: 1, failedTests: 2, summaryFailed: 2 }],
        [{ name: 'a test fails after a passing test printed a header-shaped line', active: 'noise', bail: true }, { exitCode: 1, failedTests: 1 }],
        [{ name: 'a test file fails to load, with bail', active: 'load', bail: true }, { exitCode: 1, failedTests: 0, unhandled: true, bailLine: 'Bailed out after 1 failure' }],
        [{ name: 'a test file fails to load, without bail', active: 'load', bail: false }, { exitCode: 1, failedTests: 0, unhandled: true, summaryErrors: 1 }],
        [{ name: 'a describe body throws', active: 'describe', bail: true }, { exitCode: 1, failedTests: 0, unhandled: true, summaryErrors: 1 }],
        [{ name: 'a test.failing test passes, with bail', active: 'failing', bail: true }, { exitCode: 1, failedTests: 1, bailLine: 'Bailed out after 1 failure' }],
        [{ name: 'a test.failing test passes, without bail', active: 'failing', bail: false }, { exitCode: 1, failedTests: 1, summaryFailed: 1 }],
        [{ name: 'a beforeAll hook throws, with bail', active: 'beforeAll', bail: true }, { exitCode: 1, bailLine: 'Bailed out after 1 failure' }],
        [{ name: 'a beforeAll hook throws, without bail', active: 'beforeAll', bail: false }, { exitCode: 1 }],
        [{ name: 'an afterEach hook throws, with bail', active: 'afterEach', bail: true }, { exitCode: 1, failedTests: 1, bailLine: 'Bailed out after 1 failure' }],
        [{ name: 'an afterEach hook throws, without bail', active: 'afterEach', bail: false }, { exitCode: 1 }],
        // Bun prints its summary only after the last file, so an exit 0 anywhere before that leaves none.
        [{ name: 'a test exits 0', active: 'exit0', bail: true }, { exitCode: 0, summaryPrinted: false }],
        [{ name: 'a file\'s last test exits 0', active: 'exitLast', bail: true }, { exitCode: 0, failedTests: 0, summaryPrinted: false }],
        [{ name: 'a test file exits 0 at load', active: 'exitLoad', bail: true }, { exitCode: 0, failedTests: 0, summaryPrinted: false }],
        [{ name: 'an afterEach hook exits 0', active: 'exitHook', bail: true }, { exitCode: 0, failedTests: 0, summaryPrinted: false }],
        // Without bail a failed test does not stop the run, and the exit 0 after it is still bun's exit code.
        [{ name: 'a test fails, then a later one exits 0, without bail', active: 'failExit', bail: false }, { exitCode: 0, failedTests: 1, summaryPrinted: false }],
        [{ name: 'a test exits 1', active: 'exit1', bail: true }, { exitCode: 1, summaryPrinted: false }],
        [{ name: 'the name pattern matches no test', active: 'rename', bail: true, pattern: '^b title plain$' }, { exitCode: 1, zeroMatch: true }],
        [{ name: 'the name pattern matches some tests', active: 'kill', bail: true, pattern: 'a2|nothing' }, { exitCode: 1, failedTests: 1, zeroMatch: false }],
    ];

    /** The sanitized bunfig (the dry run's) and its mutant-run copy. */
    const bunfig = { dryRun: '', mutantRun: '' };

    beforeAll(async () => {
        bunfig.dryRun = await generateSanitizedBunfig(tempDir, path.join(tempDir, 'private'));
        bunfig.mutantRun = mutantRunBunfigPath(bunfig.dryRun);
    });

    function run(bunfigPath: string, outcome: Outcome, env?: Record<string, string>): Promise<BunProcessResult> {
        return runBunTests({
            bunPath:         process.execPath,
            timeout:         30_000,
            maxSpawnDepth:   2, // under Stryker this suite is itself a depth-1 run
            bunfigPath,
            activeMutant:    outcome.active,
            bail:            outcome.bail,
            sequentialMode:  true,
            testFiles,
            testNamePattern: outcome.pattern,
            env,
        });
    }

    /** Everything the runner scores a mutant run from. */
    function verdict(result: BunProcessResult): Record<string, unknown> {
        const parsed = parseBunTestOutput(result.stdout, result.stderr, testFiles);
        const stderr = stripAnsi(result.stderr);
        return {
            exitCode:       result.exitCode,
            signal:         result.signal,
            failedTests:    parsed.tests.filter(t => t.status === 'failed').map(t => t.name),
            parsedTests:    parsed.tests.length,
            failed:         parsed.failed,
            totalTests:     parsed.totalTests,
            summaryPassed:  parsed.summaryPassed,
            summaryFailed:  parsed.summaryFailed,
            summarySkipped: parsed.summarySkipped,
            summaryTodo:    parsed.summaryTodo,
            summaryErrors:  parsed.summaryErrors,
            summaryPrinted: parsed.summaryPrinted,
            zeroMatch:      stderr.includes('matched 0 tests.'),
            unhandled:      stderr.includes('# Unhandled error between tests'),
            ranLine:        /^Ran \d+ tests? across/m.exec(stderr)?.[0],
            bailLine:       /^Bailed out after \d+ failures?$/m.exec(stderr)?.[0],
        };
    }

    for(const [outcome, expected] of OUTCOMES) {
        // FORCE_COLOR set where Stryker runs reaches every child, and bun then colours its output even when piped.
        test(`${outcome.name}: the same verdict from both bunfigs, with and without FORCE_COLOR`, async () => {
            const [full, quiet, colouredQuiet] = await Promise.all([
                run(bunfig.dryRun, outcome),
                run(bunfig.mutantRun, outcome),
                run(bunfig.mutantRun, outcome, { FORCE_COLOR: '1' }),
            ]);

            const fullVerdict = verdict(full);
            // The fixture really produces this outcome.
            expect({ ...fullVerdict, failedTests: (fullVerdict.failedTests as string[]).length }).toMatchObject(expected);
            expect(verdict(quiet)).toEqual(fullVerdict);
            // The colour is real, and changes nothing the runner reads.
            expect(colouredQuiet.stdout + colouredQuiet.stderr).toContain('\u001B[');
            expect(verdict(colouredQuiet)).toEqual(fullVerdict);
        }, 60_000);
    }

    test('the mutant-run copy prints no passing, skipped or pending test, and keeps what the tests print', async () => {
        const outcome = { name: '', active: 'none', bail: true };
        const [full, quiet] = await Promise.all([run(bunfig.dryRun, outcome), run(bunfig.mutantRun, outcome)]);

        expect(full.stderr).toMatch(/^\(pass\) A > a1/m);
        expect(full.stderr).toMatch(/^\(skip\) A > a skipped/m);
        expect(full.stderr).toMatch(/^\(todo\) A > a todo/m);
        expect(quiet.stderr).not.toMatch(/^\((?:pass|skip|todo)\) /m);
        expect(quiet.stdout).toContain('chatter from a1');
        expect(quiet.stderr).toMatch(/^a\.test\.ts:$/m);
        expect(quiet.stderr.length).toBeLessThan(full.stderr.length / 2);
    }, 60_000);

    test('the mutant-run copy still prints the failing test\'s own file header', async () => {
        const quiet = await run(bunfig.mutantRun, { name: '', active: 'two', bail: false });

        expect(quiet.stderr).toMatch(/^b\.test\.ts:$/m);
        expect(parseBunTestOutput(quiet.stdout, quiet.stderr, testFiles).tests.map(t => t.name)).toEqual([
            `${path.relative(process.cwd(), testFiles[0])} > A > a2`,
            `${path.relative(process.cwd(), testFiles[1])} > b2`,
        ]);
    }, 60_000);
});

describe('mutant-run verdicts through a real BunTestRunner', () => {
    let runner: BunTestRunner;
    let ids: Map<string, string>;

    beforeAll(async () => {
        runner = new BunTestRunner(silentLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                maxSpawnDepth:    2, // under Stryker this suite is itself a depth-1 run
                testFiles,
            },
            coverageAnalysis: 'perTest',
            testRunner:       { name: 'bun' },
        } as unknown as StrykerOptions);
        await runner.init();
        const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);
        if(dryRun.status !== DryRunStatus.Complete) {
            throw new Error(`dry run did not complete: ${JSON.stringify(dryRun)}`);
        }
        // Each test's id by the last segment of its name.
        ids = new Map(dryRun.tests.map(t => [t.name.split(' > ').at(-1)!, t.id]));
        // As afterEach does for each test: the dry run's spawn attached the signal-cleanup listeners.
        removeSignalCleanup();
        resetAllMocks();
    }, 60_000);

    afterAll(async () => {
        await runner.dispose();
        resetAllMocks();
    });

    function mutantRun(active: string, testFilter: string[] | undefined, extra: Partial<MutantRunOptions> = {}): Promise<MutantRunResult> {
        return runner.mutantRun({
            activeMutant:    { id: active },
            testFilter,
            sandboxFileName: path.join(tempDir, 'source.js'),
            timeout:         30_000,
            ...extra,
        } as unknown as MutantRunOptions);
    }

    const id = (name: string): string => ids.get(name)!;
    const allIds = (): string[] => [...ids.values()];

    test('every covering test passes: Survived, counting the tests bun ran', async () => {
        // Every test but the skipped and the pending one, which the pattern filters out.
        expect(await mutantRun('none', allIds())).toEqual({ status: MutantRunStatus.Survived, nrOfTests: 11 });
    }, 60_000);

    test('a static run in which every test passes: Survived', async () => {
        expect(await mutantRun('none', undefined)).toEqual({ status: MutantRunStatus.Survived, nrOfTests: 12 });
    }, 60_000);

    test('a covering test fails: Killed by it', async () => {
        const result = await mutantRun('kill', [id('a1'), id('a2')]);

        expect(result).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('a2')], nrOfTests: 1 });
    }, 60_000);

    /** `run` with FORCE_COLOR set, as it is in the children when it is set where Stryker runs. */
    async function withForceColor<T>(run: () => Promise<T>): Promise<T> {
        process.env.FORCE_COLOR = '1';
        try {
            return await run();
        } finally {
            Reflect.deleteProperty(process.env, 'FORCE_COLOR');
        }
    }

    test('under FORCE_COLOR, a covering test fails: Killed by it', async () => {
        expect(await withForceColor(() => mutantRun('kill', [id('a1'), id('a2')]))).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('a2')], nrOfTests: 1 });
    }, 60_000);

    test('under FORCE_COLOR, a test fails and a later one exits 0, without bail: Killed by the failing test', async () => {
        expect(await withForceColor(() => mutantRun('failExit', [id('b2'), id('b3'), id('b title plain')], { disableBail: true })))
            .toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('b2')] });
    }, 60_000);

    test('a test.failing test passes: Killed by it', async () => {
        expect(await mutantRun('failing', [id('e1'), id('e failing')])).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('e failing')], nrOfTests: 1 });
    }, 60_000);

    test('a beforeAll hook throws: Killed', async () => {
        expect(await mutantRun('beforeAll', [id('e1'), id('e failing')])).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [], nrOfTests: 1 });
    }, 60_000);

    test('an afterEach hook throws: Killed by the test it ran after', async () => {
        expect(await mutantRun('afterEach', [id('e1'), id('e failing')])).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('e1')], nrOfTests: 1 });
    }, 60_000);

    test('without bail, every failing test is in killedBy', async () => {
        const result = await mutantRun('two', allIds(), { disableBail: true });

        // In the order the files ran, which depends on the dry run's timings.
        const byName = (a: string, b: string): number => a.localeCompare(b);
        expect({ ...result, killedBy: (result as { killedBy: string[] }).killedBy.toSorted(byName) }).toMatchObject({
            status:    MutantRunStatus.Killed,
            killedBy:  [id('a2'), id('b2')].toSorted(byName),
            nrOfTests: 11,
        });
    }, 60_000);

    test('a test fails after a passing test printed the header of a file outside the run: Killed by it', async () => {
        expect(await mutantRun('noise', [id('b1'), id('b2')])).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('b2')], nrOfTests: 1 });
    }, 60_000);

    test('a test file fails to load: Killed with an empty killedBy', async () => {
        expect(await mutantRun('load', undefined)).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [], nrOfTests: 1 });
    }, 60_000);

    test('a test file fails to load, without bail: Killed with an empty killedBy', async () => {
        expect(await mutantRun('load', undefined, { disableBail: true })).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [], nrOfTests: 12 });
    }, 60_000);

    test('a describe body throws: Killed with an empty killedBy', async () => {
        expect(await mutantRun('describe', undefined)).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [], nrOfTests: 11 });
    }, 60_000);

    /** The verdict for a run that exited 0 before bun printed its summary: caught, but by no failing test. */
    const earlyExit = { status: MutantRunStatus.Error, errorMessage: expect.stringMatching(/^bun exited 0 before running every selected test: /) as string } as const;

    test('a test exits 0 in a static run, with files left to run: Error, not Survived', async () => {
        expect(await mutantRun('exit0', undefined)).toEqual(earlyExit);
    }, 60_000);

    test('a covering test exits 0 mid-file, with covering tests after it: Error, not Survived', async () => {
        expect(await mutantRun('exit0', [id('b2'), id('b3'), id('b title plain'), id('b hangs')])).toEqual(earlyExit);
    }, 60_000);

    test('the last covering test exits 0, after every other one passed: Error, not Survived', async () => {
        expect(await mutantRun('exitLast', [id('b1'), id('b2'), id('b hangs')])).toEqual(earlyExit);
    }, 60_000);

    test('a test file exits 0 at load: Error, not Survived', async () => {
        expect(await mutantRun('exitLoad', undefined)).toEqual(earlyExit);
    }, 60_000);

    test('an afterEach hook exits 0: Error, not Survived', async () => {
        expect(await mutantRun('exitHook', [id('e1'), id('e failing')])).toEqual(earlyExit);
    }, 60_000);

    test('a test fails and a later one exits 0, without bail: Killed by the failing test', async () => {
        expect(await mutantRun('failExit', [id('b2'), id('b3'), id('b title plain')], { disableBail: true }))
            .toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id('b2')] });
    }, 60_000);

    test('a test exits 1 with no failing test: Error', async () => {
        const result = await mutantRun('exit1', undefined);

        expect(result.status).toBe(MutantRunStatus.Error);
        expect((result as { errorMessage: string }).errorMessage).toContain('no failing test and no fail/error count');
    }, 60_000);

    test('a pattern that matches nothing retries with the full suite, which kills the mutant', async () => {
        expect(await mutantRun('rename', [id('b title plain')])).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [], nrOfTests: 1 });
    }, 60_000);

    test('a test that never settles: Timeout at the deadline', async () => {
        expect(await mutantRun('hang', [id('b hangs')], { timeout: 2000 })).toEqual({ status: MutantRunStatus.Timeout });
    }, 60_000);
});
