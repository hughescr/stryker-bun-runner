/**
 * The runner's side of the opt-in run profile (src/run-profile.ts): with
 * STRYKER_BUN_PROFILE unset nothing is profiled or written; with it set, each
 * dry and mutant run appends its line and dispose() appends the worker's summary.
 *
 * The mock setup is a trimmed copy of bun-test-runner.cheapest-first.test.ts's.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus } from '@stryker-mutator/api/test-runner';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import * as coverageCollector from '../../src/coverage/collector.js';
import * as coverageMapper from '../../src/coverage/coverage-mapper.js';
import * as preloadGenerator from '../../src/coverage/preload-generator.js';
import { formatPreloadTimings } from '../../src/coverage/preload-logic.js';
import * as dryRunCompleteness from '../../src/dry-run-completeness.js';
import * as inspectorModule from '../../src/inspector/inspector-client.js';
import type { TestInfo } from '../../src/inspector/types.js';
import * as processRunner from '../../src/process-runner.js';
import { RunProfile, WorkerProfiler, type RunRecord, type WorkerSummary } from '../../src/run-profile.js';
import * as bunVersion from '../../src/utils/bun-version.js';
import * as bunfigSanitizer from '../../src/utils/bunfig-sanitizer.js';
import * as privateTempDir from '../../src/utils/private-temp-dir.js';
import * as syncServerModule from '../../src/utils/sync-server.js';
import * as testFileDiscovery from '../../src/utils/test-file-discovery.js';
import { rememberEnv } from '../helpers/env.js';
import { mockRename, mockWriteFile, resetAllMocks } from '../test-preload.js';

function expectedRunTempDir(): string {
    const hash = createHash('sha256').update(`${process.cwd()}:${process.ppid}`).digest('hex').slice(0, 16);
    return path.join(tmpdir(), `stryker-bun-runner-${process.getuid!()}-${hash}-0`);
}

const ALPHA = 'tests/alpha.test.ts';
const BETA  = 'tests/beta.test.ts';

interface SpawnOptions {
    onInspectorReady?: (url: string) => void
    profile?:          RunProfile
    testFiles?:        string[]
    testNamePattern?:  string
}

describe('BunTestRunner run profile', () => {
    let mockLogger: Logger;
    let mockRunBunTests: ReturnType<typeof mock>;
    let inspectorClientSpy: ReturnType<typeof spyOn>;
    let appendSpy: ReturnType<typeof spyOn>;
    let restoreEnv: () => void;
    let dir: string;
    let file: string;

    beforeEach(async () => {
        restoreEnv = rememberEnv();
        delete process.env[processRunner.PROFILE_ENV];
        dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'sbr-runner-profile-'));
        file = path.join(dir, 'profile.jsonl');

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

        // A profiled spawn reports its child the way process-runner would, so the runner's own marks have a child to land on.
        mockRunBunTests = mock((options: SpawnOptions) => {
            options.profile?.beginSpawn(false, options.testFiles, options.testNamePattern);
            options.profile?.mark('spawned');
            if(options.onInspectorReady) {
                options.onInspectorReady('ws://127.0.0.1:6499/inspector');
            }
            options.profile?.mark('exit');
            options.profile?.mark('close');
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: ' 1 pass\n', timedOut: false });
        });
        spyOn(processRunner, 'runBunTests').mockImplementation(mockRunBunTests);
        appendSpy = spyOn(fs, 'appendFileSync');

        spyOn(coverageCollector, 'collectCoverage').mockResolvedValue({ perTest: {}, 'static': { '1': 1 } });
        spyOn(coverageCollector, 'collectLateHits').mockResolvedValue([]);
        spyOn(coverageCollector, 'cleanupCoverageFile').mockResolvedValue(undefined);
        spyOn(preloadGenerator, 'generatePreloadScript').mockResolvedValue('/tmp/preload.ts');
        spyOn(preloadGenerator, 'cleanupPreloadScript').mockResolvedValue(undefined);
        spyOn(preloadGenerator, 'resolveEagerModulesFromGlobs').mockResolvedValue([]);
        spyOn(bunfigSanitizer, 'generateSanitizedBunfig').mockResolvedValue('/tmp/stryker-bun-runner-bunfig-0-0.toml');
        spyOn(bunfigSanitizer, 'cleanupSanitizedBunfig').mockResolvedValue(undefined);

        const mockSyncServer = {
            start:           mock().mockResolvedValue(undefined),
            signalReady:     mock(),
            setDrainHandler: mock(),
            close:           mock().mockResolvedValue(undefined),
            clientCount:     0,
            port:            6500,
            token:           'run-token',
        };
        // @ts-expect-error - Mocking constructor, type system doesn't understand this pattern
        spyOn(syncServerModule, 'SyncServer').mockImplementation(() => mockSyncServer);

        const test: TestInfo = { id: 1, name: 'a1', fullName: 'a1', bunName: 'a1', type: 'test', status: 'pass', url: path.join(process.cwd(), ALPHA), elapsed: 1_000_000 };
        const mockInspectorClient = {
            connect:                  mock().mockResolvedValue(undefined),
            send:                     mock().mockResolvedValue(undefined),
            getTests:                 mock().mockReturnValue([test]),
            getExecutionOrder:        mock().mockReturnValue([1]),
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
        inspectorClientSpy = spyOn(inspectorModule, 'InspectorClient').mockImplementation(() => mockInspectorClient);
        spyOn(coverageMapper, 'mapCoverageToInspectorIds').mockImplementation(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional pass-through mock
            (coverage: any) => ({ coverage, inspectorIdToProjectFile: new Map(), counterKeyToTestName: new Map(), rawKeyCount: 0, orphanedKeyCount: 0 })
        );
        spyOn(dryRunCompleteness, 'findDryRunDataLoss').mockReturnValue([]);

        mockWriteFile.mockResolvedValue(undefined);
        mockRename.mockResolvedValue(undefined);
        spyOn(testFileDiscovery, 'discoverTestFiles').mockResolvedValue([ALPHA, BETA]);
        spyOn(bunVersion, 'checkBunVersion').mockResolvedValue('1.4.2');
        spyOn(privateTempDir, 'ensurePrivateDir').mockImplementation((d: string) => Promise.resolve(d));
        spyOn(privateTempDir, 'resolveRunTempDir').mockImplementation(() => Promise.resolve(expectedRunTempDir()));
        spyOn(privateTempDir, 'writePrivateFile').mockImplementation(
            (f: string, data: string) => fsPromises.writeFile(f, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        );
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        resetAllMocks();
        restoreEnv();
        await fs.promises.rm(dir, { recursive: true, force: true });
    });

    /** A worker's whole life: init, the dry run, one mutant run (no covering tests), dispose. */
    async function workerLife(): Promise<void> {
        const runner = new BunTestRunner(mockLogger, {} as StrykerOptions);
        await runner.init();
        const dryRun = await runner.dryRun();
        expect(dryRun.status).toBe(DryRunStatus.Complete);
        const result = await runner.mutantRun({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock object
            activeMutant: { id: '7' } as any,
            testFilter:   [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test uses simplified mock data
        } as any);
        expect(result.status).toBe(MutantRunStatus.Survived);
        await runner.dispose();
    }

    const spawnProfiles = (): (RunProfile | undefined)[] => (mockRunBunTests.mock.calls as [SpawnOptions][]).map(([options]) => options.profile);
    const inspectorHandlers = (): Record<string, unknown> => (inspectorClientSpy.mock.calls[0] as [{ handlers: Record<string, unknown> }])[0].handlers;

    it('profiles nothing and writes no file with STRYKER_BUN_PROFILE unset', async () => {
        await workerLife();

        expect(spawnProfiles()).toEqual([undefined, undefined]);
        expect(inspectorHandlers()).not.toHaveProperty('onTestFound');
        expect(appendSpy).not.toHaveBeenCalled();
        expect(await fs.promises.readdir(dir)).toEqual([]);
    });

    it('appends a line per run and a summary at dispose with STRYKER_BUN_PROFILE set', async () => {
        process.env[processRunner.PROFILE_ENV] = file;

        await workerLife();

        const profiles = spawnProfiles();
        expect(profiles).toHaveLength(2);
        expect(profiles[0]).toBeInstanceOf(RunProfile);
        expect(profiles[1]).toBeInstanceOf(RunProfile);
        expect(profiles[0]).not.toBe(profiles[1]);
        expect(inspectorHandlers().onTestFound).toBeInstanceOf(Function);

        const text = await fs.promises.readFile(file, 'utf8');
        const lines = text.trimEnd().split('\n').map(line => JSON.parse(line) as RunRecord | WorkerSummary);
        expect(lines.map(line => line.type)).toEqual(['run', 'run', 'summary']);
        // One write per line, through the spy the unset case checks is never called.
        expect(appendSpy).toHaveBeenCalledTimes(3);
        const [dry, mutant, summary] = lines as [RunRecord, RunRecord, WorkerSummary];
        expect(dry).toMatchObject({ kind: 'dry', status: 'complete', scope: 'dry', files: 2, spawns: 1, pid: process.pid });
        expect(Object.keys(dry.marks[0]).toSorted((a, b) => a.localeCompare(b))).toEqual(['close', 'exit', 'inspector', 'spawned', 'spawnStart']);
        expect(dry.phases.inspector).toBeNumber();
        expect(mutant).toMatchObject({ kind: 'mutant', mutant: '7', status: 'survived', scope: 'static', files: 2, spawns: 1 });
        expect(mutant.patternBytes).toBeUndefined();
        expect(summary.runs).toBe(2);
        expect(Object.keys(summary.groups)).toEqual(['all', 'dry', 'dry/complete', 'mutant', 'mutant/*/static', 'mutant/survived', 'mutant/survived/static']);
    });

    it('still stops the in-flight child and cleans up at dispose when the profile summary throws', async () => {
        process.env[processRunner.PROFILE_ENV] = file;
        spyOn(WorkerProfiler.prototype, 'writeSummary').mockImplementation(() => {
            throw new RangeError('Maximum call stack size exceeded.');
        });
        // A dry run whose child only ends when it is aborted.
        let aborted = false;
        let spawned!: () => void;
        const childStarted = new Promise<void>((resolve) => {
            spawned = resolve;
        });
        mockRunBunTests.mockImplementation((options: SpawnOptions & { signal?: AbortSignal }) => new Promise((resolve) => {
            spawned();
            options.onInspectorReady?.('ws://127.0.0.1:6499/inspector');
            options.signal?.addEventListener('abort', () => {
                aborted = true;
                resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true });
            });
        }));
        const cleanupSpy = spyOn(preloadGenerator, 'cleanupPreloadScript').mockResolvedValue(undefined);
        const runner = new BunTestRunner(mockLogger, {} as StrykerOptions);
        await runner.init();
        const dryRun = runner.dryRun();
        await childStarted;

        await runner.dispose();
        await dryRun;

        expect(aborted).toBe(true);
        expect(cleanupSpy).toHaveBeenCalledWith('/tmp/preload.ts');
        expect((mockLogger.warn as ReturnType<typeof mock>).mock.calls.some(call => String(call[0]).includes('run profile\'s summary'))).toBe(true);
    });

    it('adds the dry run\'s finer timings: the preload\'s, from its stderr line, and the runner\'s own steps after the child', async () => {
        process.env[processRunner.PROFILE_ENV] = file;
        const preloadEpoch = Date.now();
        mockRunBunTests.mockImplementation((options: SpawnOptions) => {
            options.profile?.beginSpawn(false, options.testFiles, options.testNamePattern);
            options.profile?.mark('spawned');
            options.onInspectorReady?.('ws://127.0.0.1:6499/inspector');
            options.profile?.mark('close');
            const timings = formatPreloadTimings({ 'at.preloadStart': preloadEpoch, 'ms.beforeEach': 1.5, tests: 1 });
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: ` 1 pass\n${timings}`, timedOut: false });
        });

        await workerLife();

        const text = await fs.promises.readFile(file, 'utf8');
        const [dry, mutant] = text.trimEnd().split('\n').map(line => JSON.parse(line) as RunRecord);
        const detail = dry.detail ?? {};
        // The preload's epoch time, relative to the run's start like every mark.
        expect(detail['at.preload.preloadStart']).toBeCloseTo(preloadEpoch - dry.startEpochMs, 0);
        expect(detail['preload.ms.beforeEach']).toBe(1.5);
        expect(detail['preload.tests']).toBe(1);
        const steps = ['inspectorClosed', 'outputParsed', 'coverageRead', 'coverageMapped', 'testsBuilt', 'gateChecked', 'coverageChecked', 'registryWritten'];
        const times = steps.map(step => detail[`at.${step}`]);
        expect(times.every(time => typeof time === 'number')).toBe(true);
        expect(times).toEqual(times.toSorted((a, b) => a - b));
        expect(times.at(-1)).toBeLessThanOrEqual(dry.totalMs);
        // Mutant runs carry no detail.
        expect(mutant.detail).toBeUndefined();
    });
});
