/**
 * Cheapest-first test-file order, randomize handling and run-file-aware output
 * parsing in mutant runs.
 *
 * - The dry run records how long each test FILE took (the sum of its tests'
 *   inspector durations), keeps it, and shares it through the dry-run registry.
 *   Every mutant run hands bun its files ordered by that time, cheapest first
 *   (ties and files with no recorded time keep their old relative order, files
 *   with no recorded time last), so with bail a fast unit test can kill the
 *   mutant before a slow integration file even loads.
 * - Mutant runs never randomize: they use the sanitizer's mutant-run copy of
 *   the bunfig when the project's randomizes, and drop --randomize/--seed from
 *   bun.bunArgs. The dry run keeps both.
 * - A mutant run's output is parsed with the files the run was given, so a
 *   header-shaped line inside a failure message cannot take over the failing
 *   test's name.
 *
 * The mock setup is the same as bun-test-runner.test.ts's.
 */

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, type DryRunOptions, type MutantRunResult } from '@stryker-mutator/api/test-runner';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import * as coverageCollector from '../../src/coverage/collector.js';
import * as coverageMapper from '../../src/coverage/coverage-mapper.js';
import * as preloadGenerator from '../../src/coverage/preload-generator.js';
import * as dryRunCompleteness from '../../src/dry-run-completeness.js';
import * as inspectorModule from '../../src/inspector/inspector-client.js';
import type { TestInfo } from '../../src/inspector/types.js';
import * as processRunner from '../../src/process-runner.js';
import * as bunVersion from '../../src/utils/bun-version.js';
import * as bunfigSanitizer from '../../src/utils/bunfig-sanitizer.js';
import * as privateTempDir from '../../src/utils/private-temp-dir.js';
import * as syncServerModule from '../../src/utils/sync-server.js';
import { buildTestFileArgs, MAX_TEST_FILE_ARGS_BYTES } from '../../src/utils/test-file-args.js';
import * as testFileDiscovery from '../../src/utils/test-file-discovery.js';
import { mockReadFile, mockRename, mockWriteFile, resetAllMocks } from '../test-preload.js';

/** The run's private temp directory, derived independently (see survivors-a's copy of this helper). */
function expectedRunTempDir(cwd: string = process.cwd(), ppid: number = process.ppid): string {
    const hash = createHash('sha256').update(`${cwd}:${ppid}`).digest('hex').slice(0, 16);
    return path.join(tmpdir(), `stryker-bun-runner-${process.getuid!()}-${hash}-0`);
}

const REGISTRY_PATH = (): string => path.join(expectedRunTempDir(), 'registry.json');

const ALPHA = 'tests/alpha.test.ts';
const BETA  = 'tests/beta.test.ts';
const GAMMA = 'tests/gamma.test.ts';
const SANITIZED = '/tmp/stryker-bun-runner-bunfig-0-0.toml';
const RANDOMIZE_DEBUG = 'Randomized test order applies to the dry run only; mutant runs turn it off (%s) and run test files cheapest-first';

type Drop = bunfigSanitizer.DroppedBunfigKey;

describe('BunTestRunner cheapest-first file order and fixed test order in mutant runs', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let mockCollectCoverage: ReturnType<typeof mock>;
    let mockGenerateSanitizedBunfig: ReturnType<typeof mock>;
    let mockInspectorClient: Record<string, unknown> & {
        getTests:          ReturnType<typeof mock>
        getExecutionOrder: ReturnType<typeof mock>
    };
    let discoverTestFilesSpy: ReturnType<typeof spyOn>;
    let writePrivateFileSpy: ReturnType<typeof spyOn>;
    let mutantOutcome: { exitCode: number, stdout: string, stderr: string, timedOut: boolean };

    beforeEach(() => {
        mockLogger = {
            debug:          mock(),
            info:           mock(),
            warn:           mock(),
            error:          mock(),
            trace:          mock(),
            fatal:          mock(),
            isTraceEnabled: mock().mockReturnValue(false),
            isDebugEnabled: mock().mockReturnValue(true),
            isInfoEnabled:  mock().mockReturnValue(true),
            isWarnEnabled:  mock().mockReturnValue(true),
            isErrorEnabled: mock().mockReturnValue(true),
            isFatalEnabled: mock().mockReturnValue(true),
        };

        mutantOutcome = { exitCode: 0, stdout: ' 1 pass\n', stderr: '', timedOut: false };
        mockRunBunTests = mock((options: { onInspectorReady?: (url: string) => void }) => {
            if(options.onInspectorReady) {
                options.onInspectorReady('ws://127.0.0.1:6499/inspector');
                return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
            }
            return Promise.resolve(mutantOutcome);
        });
        spyOn(processRunner, 'runBunTests').mockImplementation(mockRunBunTests);

        mockCollectCoverage = mock().mockResolvedValue({ perTest: {}, 'static': { '1': 1 } });
        spyOn(coverageCollector, 'collectCoverage').mockImplementation(mockCollectCoverage);
        spyOn(coverageCollector, 'collectLateHits').mockResolvedValue([]);
        spyOn(coverageCollector, 'cleanupCoverageFile').mockResolvedValue(undefined);
        spyOn(preloadGenerator, 'generatePreloadScript').mockResolvedValue('/tmp/preload.ts');
        spyOn(preloadGenerator, 'cleanupPreloadScript').mockResolvedValue(undefined);
        spyOn(preloadGenerator, 'resolveEagerModulesFromGlobs').mockResolvedValue([]);

        mockGenerateSanitizedBunfig = mock().mockResolvedValue(SANITIZED);
        spyOn(bunfigSanitizer, 'generateSanitizedBunfig').mockImplementation(mockGenerateSanitizedBunfig);
        spyOn(bunfigSanitizer, 'cleanupSanitizedBunfig').mockResolvedValue(undefined);

        const mockSyncServer = {
            start:           mock().mockResolvedValue(undefined),
            signalReady:     mock(),
            setDrainHandler: mock(),
            close:           mock().mockResolvedValue(undefined),
            clientCount:     0,
            port:            6500,
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        spyOn(syncServerModule, 'SyncServer').mockImplementation(() => mockSyncServer);

        mockInspectorClient = {
            connect:                  mock().mockResolvedValue(undefined),
            send:                     mock().mockResolvedValue(undefined),
            getTests:                 mock().mockReturnValue([]),
            getExecutionOrder:        mock().mockReturnValue([]),
            close:                    mock().mockResolvedValue(undefined),
            expectClose:              mock(),
            waitForClose:             mock().mockResolvedValue(undefined),
            wasClosedUnexpectedly:    false,
            getMsSinceLastFrame:      mock().mockReturnValue(0),
            getFoundIdGaps:           mock().mockReturnValue([]),
            getEventCounts:           mock().mockReturnValue({ found: 0, start: 0, end: 0 }),
            getCloseInfo:             mock().mockReturnValue({ code: undefined, reason: undefined, wasClean: undefined, msFromLastFrameToClose: undefined }),
            getFoundIdCollisionStats: mock().mockReturnValue({ rawFoundCount: 0, uniqueFoundIdCount: 0, duplicateFoundIdCount: 0 }),
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        spyOn(inspectorModule, 'InspectorClient').mockImplementation(() => mockInspectorClient);

        spyOn(coverageMapper, 'mapCoverageToInspectorIds').mockImplementation(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional pass-through mock
            (coverage: any) => ({ coverage, inspectorIdToProjectFile: new Map(), counterKeyToTestName: new Map(), rawKeyCount: 0, orphanedKeyCount: 0 })
        );
        // These dry runs mock only the file order and durations they are about; the exact
        // completeness checks have their own tests (dry-run-completeness.test.ts and the
        // 'dry-run completeness gate' describe in bun-test-runner.test.ts).
        spyOn(dryRunCompleteness, 'findDryRunDataLoss').mockReturnValue([]);

        // No real fs: the registry write goes to the mocked writeFile and is read back from writePrivateFile's calls.
        mockWriteFile.mockResolvedValue(undefined);
        mockRename.mockResolvedValue(undefined);

        discoverTestFilesSpy = spyOn(testFileDiscovery, 'discoverTestFiles').mockResolvedValue([ALPHA, BETA, GAMMA]);
        spyOn(bunVersion, 'checkBunVersion').mockResolvedValue('1.4.2');
        spyOn(privateTempDir, 'ensurePrivateDir').mockImplementation((dir: string) => Promise.resolve(dir));
        spyOn(privateTempDir, 'resolveRunTempDir').mockImplementation(() => Promise.resolve(expectedRunTempDir()));
        writePrivateFileSpy = spyOn(privateTempDir, 'writePrivateFile').mockImplementation(
            (file: string, data: string) => fsPromises.writeFile(file, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        resetAllMocks();
    });

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /** One inspector test in `file` that took `ms` milliseconds. */
    function inspectorTest(id: number, file: string, name: string, ms: number | undefined): TestInfo {
        return {
            id,
            name,
            fullName: name,
            bunName:  name,
            type:     'test',
            status:   'pass',
            url:      path.join(process.cwd(), file),
            elapsed:  ms === undefined ? undefined : ms * 1_000_000,
        };
    }

    /** Make the dry run see these tests, in this execution order. */
    function dryRunSees(tests: TestInfo[]): void {
        mockInspectorClient.getTests.mockReturnValue(tests);
        mockInspectorClient.getExecutionOrder.mockReturnValue(tests.map(t => t.id));
    }

    /** alpha: 2 tests, 30 ms in all; beta: 1 test, 5 ms; gamma: 1 test, 12 ms. */
    function standardSuite(): void {
        dryRunSees([
            inspectorTest(1, ALPHA, 'a1', 10),
            inspectorTest(2, ALPHA, 'a2', 20),
            inspectorTest(3, BETA, 'b1', 5),
            inspectorTest(4, GAMMA, 'g1', 12),
        ]);
    }

    async function initRunner(options: Record<string, unknown> = {}): Promise<BunTestRunner> {
        const runner = new BunTestRunner(mockLogger, options as unknown as StrykerOptions);
        await runner.init();
        return runner;
    }

    async function dryRunWorker(options: Record<string, unknown> = {}, dryRunOptions?: Partial<DryRunOptions>): Promise<BunTestRunner> {
        const runner = await initRunner(options);
        const result = await runner.dryRun(dryRunOptions as DryRunOptions | undefined);
        expect(result.status).toBe(DryRunStatus.Complete);
        return runner;
    }

    function mutantRun(runner: BunTestRunner, testFilter: string[] = []): Promise<MutantRunResult> {
        return runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant:    { id: '7' } as any,
            testFilter,
            sandboxFileName: 'sandbox',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
        } as any);
    }

    /** The options of the last mutant-run spawn. */
    function lastMutantSpawn(): { testFiles?: string[], bunfigPath?: string, bunArgs?: string[], testNamePattern?: string } {
        const calls = mockRunBunTests.mock.calls as [{ onInspectorReady?: unknown, testFiles?: string[], bunfigPath?: string, bunArgs?: string[], testNamePattern?: string }][];
        return calls.findLast(([options]) => options.onInspectorReady === undefined)![0];
    }

    /** The options of the dry-run spawn. */
    function dryRunSpawn(): { bunfigPath?: string, bunArgs?: string[] } {
        const calls = mockRunBunTests.mock.calls as [{ onInspectorReady?: unknown, bunfigPath?: string, bunArgs?: string[] }][];
        return calls.find(([options]) => options.onInspectorReady !== undefined)![0];
    }

    /** The registry the dry run wrote, parsed. */
    function writtenRegistry(): Record<string, unknown> {
        const call = (writePrivateFileSpy.mock.calls as [string, string][]).find(([file]) => file.endsWith('registry.json.tmp'));
        return JSON.parse(call![1]) as Record<string, unknown>;
    }

    /** A worker that never ran the dry run, loading `registry` from the shared file. */
    async function registryWorker(registry: Record<string, unknown>): Promise<BunTestRunner> {
        mockReadFile.mockImplementation((file: unknown) => (String(file) === REGISTRY_PATH()
            ? Promise.resolve(JSON.stringify(registry))
            : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))));
        return initRunner();
    }

    const id = (file: string, name: string): string => `${file} > ${name}`;
    const baseRegistry = {
        version:         2,
        writtenAt:       0,
        cachedTestNames: [id(ALPHA, 'a1'), id(BETA, 'b1'), id(GAMMA, 'g1')],
        baseNameIndex:   [],
        testNameIndex:   [],
    };

    const debugCalls = (needle: string): unknown[][] =>
        ((mockLogger.debug as ReturnType<typeof mock>).mock.calls as unknown[][]).filter(args => String(args[0]).includes(needle));

    // ---------------------------------------------------------------------
    // Recording file durations
    // ---------------------------------------------------------------------

    describe('the dry run records each test file\'s duration', () => {
        it('writes the per-file sum of test durations to the registry', async () => {
            standardSuite();

            await dryRunWorker();

            expect(writtenRegistry().testFileDurations).toEqual([[ALPHA, 30], [BETA, 5], [GAMMA, 12]]);
        });

        it('keeps the registry at version 2: the field is optional and older readers ignore it', async () => {
            standardSuite();

            await dryRunWorker();

            expect(writtenRegistry().version).toBe(2);
        });

        it('sums the rounded per-test milliseconds, including skipped tests', async () => {
            dryRunSees([
                inspectorTest(1, ALPHA, 'a1', 1.4),
                inspectorTest(2, ALPHA, 'a2', 1.4),
                { ...inspectorTest(3, ALPHA, 'a3', 0), status: 'skip' },
            ]);

            await dryRunWorker();

            expect(writtenRegistry().testFileDurations).toEqual([[ALPHA, 2]]);
        });

        it('leaves out tests whose id carries no file (console-fallback ids)', async () => {
            // An empty execution order makes the runner build tests from console output.
            mockInspectorClient.getExecutionOrder.mockReturnValue([]);
            mockRunBunTests.mockImplementation((options: { onInspectorReady?: (url: string) => void }) => {
                options.onInspectorReady?.('ws://127.0.0.1:6499/inspector');
                return Promise.resolve({ exitCode: 0, stdout: '✓ bare test [3.00ms]\n 1 pass\n', stderr: '', timedOut: false });
            });

            await dryRunWorker();

            expect(writtenRegistry().testFileDurations).toEqual([]);
        });

        it('logs how many files it timed', async () => {
            standardSuite();

            await dryRunWorker();

            expect(mockLogger.debug).toHaveBeenCalledWith('Recorded dry-run durations for %d test file(s) to order mutant runs cheapest-first', 3);
        });
    });

    // ---------------------------------------------------------------------
    // Ordering
    // ---------------------------------------------------------------------

    describe('mutant runs hand bun their files cheapest first', () => {
        it('orders a targeted run\'s covering files by dry-run duration', async () => {
            standardSuite();
            const runner = await dryRunWorker();

            await mutantRun(runner, [id(ALPHA, 'a1'), id(BETA, 'b1'), id(GAMMA, 'g1')]);

            expect(lastMutantSpawn().testFiles).toEqual([BETA, GAMMA, ALPHA]);
        });

        it('orders a static mutant\'s full-suite run', async () => {
            standardSuite();
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toEqual([BETA, GAMMA, ALPHA]);
        });

        it('orders the full-suite retry after a pattern that matched no test', async () => {
            standardSuite();
            const runner = await dryRunWorker();
            mutantOutcome = { exitCode: 1, stdout: '', stderr: 'error: regex "x" matched 0 tests. Searched 4 files', timedOut: false };
            mockRunBunTests.mockClear();

            await mutantRun(runner, [id(ALPHA, 'a1')]);

            const spawns = (mockRunBunTests.mock.calls as [{ testFiles?: string[], testNamePattern?: string }][]).map(([o]) => o);
            expect(spawns).toHaveLength(2);
            expect(spawns[0].testFiles).toEqual([ALPHA]);
            expect(spawns[1].testNamePattern).toBeUndefined();
            expect(spawns[1].testFiles).toEqual([BETA, GAMMA, ALPHA]);
        });

        it('orders a run scoped to Stryker\'s testFiles selection (absolute sandbox paths)', async () => {
            standardSuite();
            const cwd = process.cwd();
            const [alpha, beta, gamma] = [ALPHA, BETA, GAMMA].map(file => path.join(cwd, file));
            const runner = await dryRunWorker({}, { testFiles: [alpha, beta, gamma] });
            spyOn(fsPromises, 'stat').mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fsPromises.stat>>);

            await mutantRun(runner, [alpha, gamma, beta]);

            expect(lastMutantSpawn().testFiles).toEqual([beta, gamma, alpha]);
        });

        it('keeps the alphabetical order between files that took the same time', async () => {
            dryRunSees([
                inspectorTest(1, GAMMA, 'g1', 7),
                inspectorTest(2, BETA, 'b1', 7),
                inspectorTest(3, ALPHA, 'a1', 9),
            ]);
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toEqual([BETA, GAMMA, ALPHA]);
        });

        it('puts files with no recorded duration last, in their old order', async () => {
            discoverTestFilesSpy.mockResolvedValue(['tests/a-untimed.test.ts', ALPHA, BETA, 'tests/z-untimed.test.ts']);
            dryRunSees([
                inspectorTest(1, ALPHA, 'a1', 9),
                inspectorTest(2, BETA, 'b1', 4),
            ]);
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toEqual([BETA, ALPHA, 'tests/a-untimed.test.ts', 'tests/z-untimed.test.ts']);
        });

        it('treats a file whose tests took 0 ms as timed, ahead of untimed files', async () => {
            discoverTestFilesSpy.mockResolvedValue(['tests/a-untimed.test.ts', ALPHA]);
            dryRunSees([inspectorTest(1, ALPHA, 'a1', 0)]);
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toEqual([ALPHA, 'tests/a-untimed.test.ts']);
        });

        it('leaves bun to find the files when there is no list to order', async () => {
            standardSuite();
            discoverTestFilesSpy.mockResolvedValue(undefined);
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toBeUndefined();
        });

        it('does not reorder the cached file list itself', async () => {
            standardSuite();
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect((runner as unknown as { effectiveTestFiles: string[] }).effectiveTestFiles).toEqual([ALPHA, BETA, GAMMA]);
        });
    });

    describe('workers that did not run the dry run read the durations from the registry', () => {
        it('orders by the registry\'s durations', async () => {
            const runner = await registryWorker({ ...baseRegistry, testFileDurations: [[ALPHA, 3], [BETA, 2], [GAMMA, 1]] });

            await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toEqual([GAMMA, BETA, ALPHA]);
        });

        it('keeps the alphabetical order for a registry written without durations', async () => {
            const runner = await registryWorker(baseRegistry);

            await mutantRun(runner, [id(GAMMA, 'g1'), id(ALPHA, 'a1')]);

            expect(lastMutantSpawn().testFiles).toEqual([ALPHA, GAMMA]);
        });

        it.each([
            ['not an array', { [ALPHA]: 1 }],
            ['an entry that is not an array', [[GAMMA, 1], { '0': ALPHA, '1': 2, length: 2 }]],
            ['an entry with too few elements', [[GAMMA, 1], [ALPHA]]],
            ['an entry with too many elements', [[GAMMA, 1], [ALPHA, 2, 3]]],
            ['a non-string file', [[GAMMA, 1], [7, 2]]],
            ['a non-number duration', [[GAMMA, 1], [ALPHA, '2']]],
        ])('ignores durations that are %s, and still loads the rest of the registry', async (_label, testFileDurations) => {
            const runner = await registryWorker({ ...baseRegistry, testFileDurations });
            mutantOutcome = { exitCode: 1, stdout: '', stderr: `${GAMMA}:\n(fail) g1 [1.00ms]\n`, timedOut: false };

            const result = await mutantRun(runner, []);

            expect(lastMutantSpawn().testFiles).toEqual([ALPHA, BETA, GAMMA]);
            expect(result).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id(GAMMA, 'g1')] });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------------
    // Randomize: dry run only
    // ---------------------------------------------------------------------

    describe('randomized test order is kept for the dry run and turned off for mutant runs', () => {
        /** The mocked sanitizer reports `drops` (and returns `outPath`) on every call. */
        function sanitizerReports(drops: Drop[], outPath = SANITIZED): void {
            mockGenerateSanitizedBunfig.mockImplementation((_cwd: string, _tmp: string, _src: string | undefined, onDropped?: (d: Drop[]) => void) => {
                onDropped?.(drops);
                return Promise.resolve(outPath);
            });
        }
        const randomizeDrop: Drop = { key: 'test.randomize', reason: 'R', warn: false, mutantRunsOnly: true };
        const otherDrop: Drop = { key: 'test.coverageDir', reason: 'C', warn: false };

        it('runs mutants with the mutant-run copy of a bunfig that randomizes, and the dry run with the bunfig itself', async () => {
            sanitizerReports([otherDrop, randomizeDrop]);
            standardSuite();
            const runner = await dryRunWorker();

            await mutantRun(runner, [id(ALPHA, 'a1')]);

            expect(dryRunSpawn().bunfigPath).toBe(SANITIZED);
            expect(lastMutantSpawn().bunfigPath).toBe(bunfigSanitizer.mutantRunBunfigPath(SANITIZED));
        });

        it('runs mutants with the sanitized bunfig itself when it does not randomize', async () => {
            sanitizerReports([otherDrop]);
            const runner = await initRunner();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().bunfigPath).toBe(SANITIZED);
        });

        it('runs mutants with the sanitized bunfig itself when the sanitizer reports nothing', async () => {
            const runner = await initRunner();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().bunfigPath).toBe(SANITIZED);
        });

        it('follows the bunfig regenerated for a new cwd', async () => {
            let cwd = process.cwd();
            const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => cwd);
            sanitizerReports([randomizeDrop], '/tmp/first.toml');
            const runner = await initRunner();
            await mutantRun(runner, []);
            expect(lastMutantSpawn().bunfigPath).toBe('/tmp/first.mutant-runs.toml');

            cwd = path.join(cwd, 'other-sandbox');
            sanitizerReports([otherDrop], '/tmp/second.toml');
            await mutantRun(runner, []);

            expect(lastMutantSpawn().bunfigPath).toBe('/tmp/second.toml');
            cwdSpy.mockRestore();
        });

        it('drops --randomize and --seed from mutant runs\' bunArgs, and keeps them for the dry run', async () => {
            standardSuite();
            const runner = await dryRunWorker({ bun: { bunArgs: ['--randomize', '--only', '--seed', '9'] } });

            await mutantRun(runner, []);

            expect(dryRunSpawn().bunArgs).toEqual(['--randomize', '--only', '--seed', '9']);
            expect(lastMutantSpawn().bunArgs).toEqual(['--only']);
        });

        it('passes no bunArgs to mutant runs when none are configured', async () => {
            const runner = await initRunner();

            await mutantRun(runner, []);

            expect(lastMutantSpawn().bunArgs).toBeUndefined();
        });

        it('logs once, at debug, that the bunfig\'s randomize is off for mutant runs', async () => {
            sanitizerReports([randomizeDrop]);
            const runner = await initRunner();

            await mutantRun(runner, []);
            await mutantRun(runner, []);

            expect(debugCalls('Randomized test order')).toEqual([[RANDOMIZE_DEBUG, 'the bunfig\'s [test].randomize/seed']]);
        });

        it('logs once, at debug, that bunArgs\' --randomize/--seed are dropped from mutant runs', async () => {
            const runner = await initRunner({ bun: { bunArgs: ['--seed=4'] } });

            await mutantRun(runner, []);
            await mutantRun(runner, []);

            expect(debugCalls('Randomized test order')).toEqual([[RANDOMIZE_DEBUG, '--randomize/--seed in bun.bunArgs']]);
        });

        it('names both sources when both randomize', async () => {
            sanitizerReports([randomizeDrop]);
            const runner = await initRunner({ bun: { bunArgs: ['--randomize'] } });

            await mutantRun(runner, []);

            expect(debugCalls('Randomized test order')).toEqual([[RANDOMIZE_DEBUG, 'the bunfig\'s [test].randomize/seed and --randomize/--seed in bun.bunArgs']]);
        });

        it('logs nothing about it when nothing randomizes', async () => {
            sanitizerReports([otherDrop]);
            const runner = await initRunner({ bun: { bunArgs: ['--only'] } });

            await mutantRun(runner, []);

            expect(debugCalls('Randomized test order')).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------
    // Output parsing with the run's files
    // ---------------------------------------------------------------------

    describe('a mutant run\'s output is read with the files it ran', () => {
        it('credits the real failing test when its failure message holds a header-shaped line', async () => {
            standardSuite();
            const runner = await dryRunWorker();
            mutantOutcome = {
                exitCode: 1,
                stdout:   '',
                stderr:   [
                    '', `${BETA}:`, 'error: expect(received).toBe(expected)', '', '- "x"', '+ "bun test v1.4.2', '+ ',
                    '+ tests/foo.test.ts:', '+ ✓ my test [1ms]"', '(fail) b1 [3.56ms]', 'Bailed out after 1 failure',
                ].join('\n'),
                timedOut: false,
            };

            const result = await mutantRun(runner, [id(BETA, 'b1')]);

            expect(result).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id(BETA, 'b1')] });
        });
    });

    // ---------------------------------------------------------------------
    // The argv budget for the file list
    // ---------------------------------------------------------------------

    describe('a file list too long for the argv budget', () => {
        const generated = (i: number): string => `tests/gen/f${String(i).padStart(5, '0')}.test.ts`;
        /** The fewest generated files whose spellings, at `cost` bytes each, are over the budget. */
        const filesOver = (spell: (file: string) => string): string[] => {
            const cost = spell(generated(0)).length + 9;
            return Array.from({ length: Math.floor(MAX_TEST_FILE_ARGS_BYTES / cost) + 1 }, (_, i) => generated(i));
        };
        const overAbsolute = (): string[] => filesOver(file => path.resolve(file));
        const overRelative = (): string[] => filesOver(file => `./${file}`);
        const bytesOf = (files: string[], budget: number): number => buildTestFileArgs(files, process.cwd(), budget).bytes;

        const infoCalls = (needle: string): unknown[][] =>
            ((mockLogger.info as ReturnType<typeof mock>).mock.calls as unknown[][]).filter(args => String(args[0]).includes(needle));
        const warnCalls = (needle: string): unknown[][] =>
            ((mockLogger.warn as ReturnType<typeof mock>).mock.calls as unknown[][]).filter(args => String(args[0]).includes(needle));

        /** Every spawn's test files: the dry run's, then each mutant run's. */
        const spawnedFiles = (): (string[] | undefined)[] =>
            (mockRunBunTests.mock.calls as [{ testFiles?: string[] }][]).map(([options]) => options.testFiles);

        it('says nothing about the budget for a list that fits', async () => {
            standardSuite();
            const runner = await dryRunWorker();

            await mutantRun(runner, []);

            expect(debugCalls('budget')).toEqual([]);
            expect(infoCalls('budget')).toEqual([]);
            expect(warnCalls('budget')).toEqual([]);
        });

        describe('that fits as ./-relative paths', () => {
            it('hands bun the list unchanged (runBunTests picks the spelling) and says so once, at debug', async () => {
                const files = overAbsolute();
                expect(bytesOf(files, 1)).toBeLessThanOrEqual(MAX_TEST_FILE_ARGS_BYTES);
                discoverTestFilesSpy.mockResolvedValue([ALPHA, BETA, GAMMA, ...files]);
                standardSuite();
                const runner = await dryRunWorker();

                await mutantRun(runner, []);
                await mutantRun(runner, [id(ALPHA, 'a1')]);

                const expectedCount = files.length + 3;
                expect(spawnedFiles()[0]).toHaveLength(expectedCount);
                expect(spawnedFiles()[1]).toHaveLength(expectedCount);
                expect(spawnedFiles()[2]).toEqual([ALPHA]);
                const notes = debugCalls('budget');
                expect(notes).toHaveLength(1);
                expect(notes[0]).toEqual([
                    expect.stringContaining('as absolute paths'),
                    expectedCount,
                    MAX_TEST_FILE_ARGS_BYTES,
                    bytesOf([ALPHA, BETA, GAMMA, ...files], 1),
                ]);
                expect(infoCalls('budget')).toEqual([]);
                expect(warnCalls('budget')).toEqual([]);
            });
        });

        describe('that does not fit even as ./-relative paths', () => {
            const listed = (): string[] => [ALPHA, BETA, GAMMA, ...overRelative()];

            it('lets bun find the files when they were auto-discovered: the dry run and a static mutant', async () => {
                discoverTestFilesSpy.mockResolvedValue(listed());
                standardSuite();
                const runner = await dryRunWorker();

                await mutantRun(runner, []);

                expect(spawnedFiles()).toEqual([undefined, undefined]);
            });

            it('still narrows a targeted run whose covering files fit', async () => {
                discoverTestFilesSpy.mockResolvedValue(listed());
                standardSuite();
                const runner = await dryRunWorker();

                await mutantRun(runner, [id(ALPHA, 'a1')]);

                expect(lastMutantSpawn().testFiles).toEqual([ALPHA]);
            });

            it('lets bun find the files for a targeted run whose covering files do not fit, which keeps its test-name pattern', async () => {
                const files = overRelative();
                discoverTestFilesSpy.mockResolvedValue([ALPHA, BETA, ...files]);
                standardSuite();
                const runner = await dryRunWorker();

                await mutantRun(runner, [...files.map(file => id(file, 'a1')), id(ALPHA, 'a1')]);

                expect(lastMutantSpawn().testFiles).toBeUndefined();
                // Only the covering tests run, in every file bun finds.
                expect(lastMutantSpawn().testNamePattern).toContain('a1');
                expect(infoCalls('no file list')).toHaveLength(1);
            });

            it('says so once, at info, with the figures', async () => {
                const files = listed();
                discoverTestFilesSpy.mockResolvedValue(files);
                standardSuite();
                const runner = await dryRunWorker();

                await mutantRun(runner, []);
                await mutantRun(runner, [id(ALPHA, 'a1')]);

                const notes = infoCalls('no file list');
                expect(notes).toHaveLength(1);
                expect(notes[0]).toEqual([
                    expect.stringContaining('even as ./-relative paths'),
                    files.length,
                    bytesOf(files, 1),
                    MAX_TEST_FILE_ARGS_BYTES,
                ]);
                expect(debugCalls('budget')).toEqual([]);
                expect(warnCalls('budget')).toEqual([]);
            });

            it('still attributes a kill to its covering test when bun was handed no list', async () => {
                discoverTestFilesSpy.mockResolvedValue(listed());
                standardSuite();
                const runner = await dryRunWorker();
                mutantOutcome = {
                    exitCode: 1,
                    stdout:   '',
                    stderr:   [`${BETA}:`, '(fail) b1 [3.56ms]', 'Bailed out after 1 failure'].join('\n'),
                    timedOut: false,
                };

                const result = await mutantRun(runner, [id(BETA, 'b1')]);

                expect(result).toMatchObject({ status: MutantRunStatus.Killed, killedBy: [id(BETA, 'b1')] });
            });

            it('keeps bun.testFiles whole, and warns once that bun may fail to start', async () => {
                const files = overRelative();
                standardSuite();
                const runner = await dryRunWorker({ bun: { testFiles: files } });

                await mutantRun(runner, []);
                await mutantRun(runner, []);

                expect(spawnedFiles()).toEqual([files, files, files]);
                const notes = warnCalls('E2BIG');
                expect(notes).toHaveLength(1);
                expect(notes[0]).toEqual([
                    expect.stringContaining('even as ./-relative paths'),
                    files.length,
                    'bun.testFiles',
                    bytesOf(files, 1),
                    MAX_TEST_FILE_ARGS_BYTES,
                ]);
                expect(infoCalls('no file list')).toEqual([]);
            });

            it('keeps Stryker\'s testFiles selection whole', async () => {
                const files = overRelative().map(file => path.join(process.cwd(), file));
                standardSuite();
                const runner = await dryRunWorker({}, { testFiles: files });

                await mutantRun(runner, []);

                expect(spawnedFiles()).toEqual([files, files]);
                expect(warnCalls('E2BIG')).toHaveLength(1);
                expect(warnCalls('E2BIG')[0]).toEqual([
                    expect.stringContaining('even as ./-relative paths'),
                    files.length,
                    'Stryker\'s testFiles option',
                    bytesOf(files, 1),
                    MAX_TEST_FILE_ARGS_BYTES,
                ]);
            });

            it('keeps the file-scoped list of a Stryker testFiles run, though the dry run auto-discovered its files', async () => {
                const files = overRelative().map(file => path.join(process.cwd(), file));
                standardSuite();
                const runner = await dryRunWorker();
                spyOn(fsPromises, 'stat').mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fsPromises.stat>>);

                await mutantRun(runner, files);

                expect(lastMutantSpawn().testFiles).toEqual(files);
                expect(warnCalls('E2BIG')).toHaveLength(1);
                expect(warnCalls('E2BIG')[0][2]).toBe('Stryker\'s testFiles option');
                expect(infoCalls('no file list')).toEqual([]);
            });
        });
    });
});
