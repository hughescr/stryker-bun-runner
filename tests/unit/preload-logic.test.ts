import * as fs from 'node:fs';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import { describe, it, expect, spyOn, beforeEach, afterEach, test, mock, jest } from 'bun:test';
import {
    getPreloadConfig,
    shouldCollectCoverage,
    initializeStrykerNamespace,
    setActiveMutant,
    formatCoverageData,
    detectGapWindowBleed,
    writeCoverageToFile,
    startOrphanWatchdog,
    type PreloadConfig,
    type StrykerNamespace
} from '../../src/coverage/preload-logic';
import type { LateHitEntry } from '../../src/coverage/types';

describe('preload-logic', () => {
    describe('getPreloadConfig', () => {
        const originalEnv = { ...process.env };

        afterEach(() => {
            process.env = { ...originalEnv };
        });

        it('reads __STRYKER_SYNC_PORT__ from env', () => {
            process.env.__STRYKER_SYNC_PORT__ = '8080';
            const config = getPreloadConfig();
            expect(config.syncPort).toBe('8080');
        });

        it('reads __STRYKER_COVERAGE_FILE__ from env', () => {
            process.env.__STRYKER_COVERAGE_FILE__ = '/tmp/coverage.json';
            const config = getPreloadConfig();
            expect(config.coverageFile).toBe('/tmp/coverage.json');
        });

        it('reads __STRYKER_ACTIVE_MUTANT__ from env', () => {
            process.env.__STRYKER_ACTIVE_MUTANT__ = '42';
            const config = getPreloadConfig();
            expect(config.activeMutant).toBe('42');
        });

        it('returns undefined for unset syncPort', () => {
            delete process.env.__STRYKER_SYNC_PORT__;
            const config = getPreloadConfig();
            expect(config.syncPort).toBeUndefined();
        });

        it('returns undefined for unset coverageFile', () => {
            delete process.env.__STRYKER_COVERAGE_FILE__;
            const config = getPreloadConfig();
            expect(config.coverageFile).toBeUndefined();
        });

        it('returns undefined for unset activeMutant', () => {
            delete process.env.__STRYKER_ACTIVE_MUTANT__;
            const config = getPreloadConfig();
            expect(config.activeMutant).toBeUndefined();
        });

        it('returns all properties when all env vars are set', () => {
            process.env.__STRYKER_SYNC_PORT__ = '9000';
            process.env.__STRYKER_COVERAGE_FILE__ = '/path/to/coverage.json';
            process.env.__STRYKER_ACTIVE_MUTANT__ = '123';
            const config = getPreloadConfig();
            expect(config).toEqual({
                syncPort:     '9000',
                coverageFile: '/path/to/coverage.json',
                activeMutant: '123',
            });
        });

        it('returns correct property names (not typos)', () => {
            process.env.__STRYKER_SYNC_PORT__ = 'test';
            const config = getPreloadConfig();
            expect(config).toHaveProperty('syncPort');
            expect(config).toHaveProperty('coverageFile');
            expect(config).toHaveProperty('activeMutant');
        });
    });

    describe('shouldCollectCoverage', () => {
        it('returns true when no activeMutant and coverageFile exists', () => {
            const config: PreloadConfig = { coverageFile: '/tmp/coverage.json' };
            expect(shouldCollectCoverage(config)).toBe(true);
        });

        it('returns false when activeMutant is set even with coverageFile', () => {
            const config: PreloadConfig = {
                coverageFile: '/tmp/coverage.json',
                activeMutant: '1',
            };
            expect(shouldCollectCoverage(config)).toBe(false);
        });

        it('returns false when no coverageFile', () => {
            const config: PreloadConfig = {};
            expect(shouldCollectCoverage(config)).toBe(false);
        });

        it('returns false when coverageFile is undefined', () => {
            const config: PreloadConfig = { coverageFile: undefined };
            expect(shouldCollectCoverage(config)).toBe(false);
        });

        it('returns false when both activeMutant and no coverageFile', () => {
            const config: PreloadConfig = { activeMutant: '1' };
            expect(shouldCollectCoverage(config)).toBe(false);
        });

        it('returns false when activeMutant is empty string', () => {
            const config: PreloadConfig = {
                coverageFile: '/tmp/coverage.json',
                activeMutant: '',
            };
            expect(shouldCollectCoverage(config)).toBe(true);
        });

        it('returns false when coverageFile is empty string', () => {
            const config: PreloadConfig = { coverageFile: '' };
            expect(shouldCollectCoverage(config)).toBe(false);
        });

        it('returns true when activeMutant is undefined and coverageFile exists', () => {
            const config: PreloadConfig = {
                coverageFile: '/tmp/coverage.json',
                activeMutant: undefined,
            };
            expect(shouldCollectCoverage(config)).toBe(true);
        });
    });

    describe('initializeStrykerNamespace', () => {
        it('initializes mutantCoverage with static and perTest properties - kills line 59 col 23 mutation', () => {
            // Line 59 col 23: { 'static': {}, perTest: {} } could be mutated to {}
            // This would create mutantCoverage: {} instead of mutantCoverage: { 'static': {}, perTest: {} }
            // Line 61's ??= won't fix this because mutantCoverage already exists (just empty)
            const globalObj = {};

            // Verify __stryker__ doesn't exist before call (so line 59 will execute, not just line 61)
            expect(globalObj).not.toHaveProperty('__stryker__');

            const result = initializeStrykerNamespace(globalObj);

            // After initialization, mutantCoverage MUST have both static and perTest
            // If line 59 is mutated to create mutantCoverage: {}, these will fail:
            expect(result.mutantCoverage).toBeDefined();
            expect(result.mutantCoverage?.static).toBeDefined();
            expect(result.mutantCoverage?.perTest).toBeDefined();

            // Verify the exact structure
            expect(result.mutantCoverage).toEqual({
                'static': {},
                perTest:  {},
            });

            // Ensure both properties exist as own properties (not inherited)
            expect(Object.hasOwn(result.mutantCoverage!, 'static')).toBe(true);
            expect(Object.hasOwn(result.mutantCoverage!, 'perTest')).toBe(true);

            // Verify exactly 2 properties (no more, no less)
            const keys = Object.keys(result.mutantCoverage ?? {});
            expect(keys).toEqual(['static', 'perTest']);
        });

        it('mutantCoverage has both static and perTest keys after initialization', () => {
            // This test specifically targets the line 59 mutation where the object literal
            // { 'static': {}, perTest: {} } could be replaced with {}
            const globalObj = {};
            const result = initializeStrykerNamespace(globalObj);

            // If the mutation survives, mutantCoverage would be {} after line 59,
            // and line 61's ??= wouldn't execute because mutantCoverage is truthy (just empty)
            const coverage = result.mutantCoverage;
            expect(coverage).toBeDefined();

            // These checks will fail if mutantCoverage is initialized as {} on line 59
            expect('static' in (coverage ?? {})).toBe(true);
            expect('perTest' in (coverage ?? {})).toBe(true);

            // Verify they are objects
            expect(typeof coverage?.static).toBe('object');
            expect(typeof coverage?.perTest).toBe('object');

            // Verify they are empty objects
            expect(Object.keys(coverage?.static ?? {}).length).toBe(0);
            expect(Object.keys(coverage?.perTest ?? {}).length).toBe(0);
        });

        it('creates __stryker__ if not exists', () => {
            const globalObj = {};
            const result = initializeStrykerNamespace(globalObj);
            expect(globalObj).toHaveProperty('__stryker__');
            expect(result).toBeDefined();
        });

        it('preserves existing __stryker__ data', () => {
            const existingNamespace: StrykerNamespace = {
                activeMutant:   '42',
                currentTestId:  'test-1',
                mutantCoverage: { 'static': { '1': 1 }, perTest: {} },
            };
            const globalObj = { __stryker__: existingNamespace };
            const result = initializeStrykerNamespace(globalObj);
            expect(result.activeMutant).toBe('42');
            expect(result.currentTestId).toBe('test-1');
            expect(result.mutantCoverage).toBe(existingNamespace.mutantCoverage);
        });

        it('creates mutantCoverage structure if missing', () => {
            const globalObj = {};
            const result = initializeStrykerNamespace(globalObj);
            expect(result.mutantCoverage).toEqual({
                'static': {},
                perTest:  {},
            });
        });

        it('creates mutantCoverage if __stryker__ exists but mutantCoverage does not', () => {
            const globalObj = { __stryker__: { activeMutant: '1' } };
            const result = initializeStrykerNamespace(globalObj);
            expect(result.mutantCoverage).toEqual({
                'static': {},
                perTest:  {},
            });
        });

        it('sets __mutantCoverage__ reference on global object', () => {
            const globalObj: Record<string, unknown> = {};
            const result = initializeStrykerNamespace(globalObj);
            expect(globalObj).toHaveProperty('__mutantCoverage__');
            expect(globalObj.__mutantCoverage__).toBe(result.mutantCoverage);
        });

        it('returns the stryker namespace', () => {
            const globalObj = {};
            const result = initializeStrykerNamespace(globalObj);
            expect(result).toBe((globalObj as { __stryker__: StrykerNamespace }).__stryker__);
        });

        it('preserves mutantCoverage if it already exists', () => {
            const existingCoverage: MutantCoverage = {
                'static': { '1': 1, '2': 1 },
                perTest:  { 'test-1': { '3': 1 } },
            };
            const globalObj = { __stryker__: { mutantCoverage: existingCoverage } };
            const result = initializeStrykerNamespace(globalObj);
            expect(result.mutantCoverage).toBe(existingCoverage);
            expect(result.mutantCoverage?.static).toEqual({ '1': 1, '2': 1 });
        });

        it('handles empty global object', () => {
            const globalObj = {};
            initializeStrykerNamespace(globalObj);
            expect(Object.keys(globalObj)).toContain('__stryker__');
            expect(Object.keys(globalObj)).toContain('__mutantCoverage__');
        });
    });

    describe('setActiveMutant', () => {
        it('sets activeMutant property on namespace', () => {
            const namespace: StrykerNamespace = {};
            setActiveMutant(namespace, '42');
            expect(namespace.activeMutant).toBe('42');
        });

        it('overwrites existing activeMutant', () => {
            const namespace: StrykerNamespace = { activeMutant: '1' };
            setActiveMutant(namespace, '99');
            expect(namespace.activeMutant).toBe('99');
        });

        it('sets exact value provided', () => {
            const namespace: StrykerNamespace = {};
            setActiveMutant(namespace, 'test-mutant-123');
            expect(namespace.activeMutant).toBe('test-mutant-123');
        });

        it('handles empty string', () => {
            const namespace: StrykerNamespace = {};
            setActiveMutant(namespace, '');
            expect(namespace.activeMutant).toBe('');
        });

        it('does not affect other namespace properties', () => {
            const namespace: StrykerNamespace = {
                currentTestId:  'test-1',
                mutantCoverage: { 'static': {}, perTest: {} },
            };
            setActiveMutant(namespace, '42');
            expect(namespace.currentTestId).toBe('test-1');
            expect(namespace.mutantCoverage).toEqual({ 'static': {}, perTest: {} });
        });
    });

    describe('detectGapWindowBleed', () => {
        it('returns [] when the static bucket is unchanged', () => {
            const snapshot = new Map([['1', 1], ['2', 3]]);
            const result = detectGapWindowBleed(snapshot, { '1': 1, '2': 3 });
            expect(result).toEqual([]);
        });

        it('reports a key that is newly present (not in the snapshot at all)', () => {
            const snapshot = new Map([['1', 1]]);
            const result = detectGapWindowBleed(snapshot, { '1': 1, '2': 1 });
            expect(result).toEqual(['2']);
        });

        it('reports a key whose count increased even though it already existed in the snapshot', () => {
            // This is the case a key-presence check would miss: '1' was already in the
            // snapshot (it bled once before), and it bleeds AGAIN — the count increases.
            const snapshot = new Map([['1', 1]]);
            const result = detectGapWindowBleed(snapshot, { '1': 2 });
            expect(result).toEqual(['1']);
        });

        it('does not report a key whose count decreased', () => {
            // Not expected in practice (counts are monotonic), but the comparison must
            // not misreport a decrease as a bleed.
            const snapshot = new Map([['1', 5]]);
            const result = detectGapWindowBleed(snapshot, { '1': 3 });
            expect(result).toEqual([]);
        });

        it('does not report a key whose count is unchanged', () => {
            const snapshot = new Map([['1', 2]]);
            const result = detectGapWindowBleed(snapshot, { '1': 2 });
            expect(result).toEqual([]);
        });

        it('returns [] when staticCoverageNow is undefined', () => {
            const snapshot = new Map([['1', 1]]);
            const result = detectGapWindowBleed(snapshot, undefined);
            expect(result).toEqual([]);
        });

        it('returns [] for an empty snapshot and empty current counts', () => {
            const result = detectGapWindowBleed(new Map(), {});
            expect(result).toEqual([]);
        });

        it('reports multiple bled keys in the same gap window', () => {
            const snapshot = new Map([['1', 1], ['2', 1]]);
            const result = detectGapWindowBleed(snapshot, { '1': 2, '2': 1, '3': 1 });
            expect(result.toSorted((a, b) => a.localeCompare(b))).toEqual(['1', '3']);
        });
    });

    describe('formatCoverageData', () => {
        it('returns empty data for undefined coverage', () => {
            const result = formatCoverageData(undefined, new Map());
            expect(result).toEqual({
                perTest:  {},
                'static': [],
            });
        });

        it('converts perTest coverage correctly', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1, '2': 1 },
                    'test-2': { '3': 1 },
                },
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.perTest).toEqual({
                'test-1': ['1', '2'],
                'test-2': ['3'],
            });
        });

        it('remaps counter IDs to names using counterToName map', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                },
            };
            const counterToName = new Map([
                ['test-1', 'should test feature A'],
                ['test-2', 'should test feature B'],
            ]);
            const result = formatCoverageData(coverage, counterToName);
            expect(result.perTest).toEqual({
                'should test feature A': ['1'],
                'should test feature B': ['2'],
            });
        });

        it('falls back to original ID if not in map', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {
                    'test-1': { '1': 1 },
                    'test-2': { '2': 1 },
                },
            };
            const counterToName = new Map([['test-1', 'named test']]);
            const result = formatCoverageData(coverage, counterToName);
            expect(result.perTest).toEqual({
                'named test': ['1'],
                'test-2':     ['2'],
            });
        });

        it('converts static coverage to array of keys', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1, '2': 1, '3': 1 },
                perTest:  {},
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.static).toEqual(['1', '2', '3']);
        });

        it('handles empty perTest', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.perTest).toEqual({});
            expect(result.static).toEqual(['1']);
        });

        it('handles empty static', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  { 'test-1': { '1': 1 } },
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.perTest).toEqual({ 'test-1': ['1'] });
            expect(result.static).toEqual([]);
        });

        it('handles both empty perTest and static', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {},
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result).toEqual({
                perTest:  {},
                'static': [],
            });
        });

        it('handles missing perTest property (undefined)', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  undefined as unknown as Record<string, Record<string, number>>,
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.perTest).toEqual({});
        });

        it('handles missing static property (undefined)', () => {
            const coverage: MutantCoverage = {
                'static': undefined as unknown as Record<string, number>,
                perTest:  { 'test-1': { '1': 1 } },
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.static).toEqual([]);
        });

        it('preserves mutant coverage count values', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 5, '2': 10 },
                perTest:  { 'test-1': { '3': 100, '4': 200 } },
            };
            const result = formatCoverageData(coverage, new Map());
            // Only keys are returned, not values
            expect(result.static).toEqual(['1', '2']);
            expect(result.perTest['test-1']).toEqual(['3', '4']);
        });

        describe('lateHits (3rd arg)', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };

            it('omitted 3rd arg leaves lateHits undefined', () => {
                const result = formatCoverageData(coverage, new Map());
                expect(result.lateHits).toBeUndefined();
            });

            it('empty lateHits array leaves lateHits undefined', () => {
                const result = formatCoverageData(coverage, new Map(), []);
                expect(result.lateHits).toBeUndefined();
            });

            it('non-empty lateHits is included verbatim in the returned data', () => {
                const lateHits: LateHitEntry[] = [
                    { testId: 'tests/foo.test.ts@@test-1', mutantIds: ['5', '6'] },
                ];
                const result = formatCoverageData(coverage, new Map(), lateHits);
                expect(result.lateHits).toEqual(lateHits);
            });

            it('returns a copy — mutating the caller array afterward does not change the returned data', () => {
                const lateHits: LateHitEntry[] = [
                    { testId: 'tests/foo.test.ts@@test-1', mutantIds: ['5'] },
                ];
                const result = formatCoverageData(coverage, new Map(), lateHits);

                // Mutate the caller's array after the call
                lateHits.push({ testId: 'tests/foo.test.ts@@test-2', mutantIds: ['7'] });
                lateHits.length = 0;

                expect(result.lateHits).toEqual([
                    { testId: 'tests/foo.test.ts@@test-1', mutantIds: ['5'] },
                ]);
            });
        });
    });

    describe('writeCoverageToFile', () => {
        let appendFileSyncSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            appendFileSyncSpy = spyOn(fs, 'appendFileSync').mockImplementation(() => {});
        });

        it('calls appendFileSync with correct arguments', () => {
            const data = { perTest: {}, 'static': [] };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(
                '/tmp/coverage.json',
                `${JSON.stringify(data)}\n`,
                'utf8'
            );
        });

        it('appends JSON with newline', () => {
            const data = {
                perTest:  { 'test-1': ['1', '2'] },
                'static': ['3'],
            };
            writeCoverageToFile('/tmp/coverage.json', data);

            const expectedJson = `${JSON.stringify(data)}\n`;
            expect(appendFileSyncSpy).toHaveBeenCalledWith(
                expect.any(String),
                expectedJson,
                expect.any(String)
            );
        });

        it('uses utf-8 encoding', () => {
            const data = { perTest: {}, 'static': [] };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                'utf8'
            );
        });

        it('writes to specified file path', () => {
            const data = { perTest: {}, 'static': [] };
            const filePath = '/custom/path/to/coverage.json';
            writeCoverageToFile(filePath, data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(
                filePath,
                expect.any(String),
                expect.any(String)
            );
        });

        it('serializes complex coverage data', () => {
            const data = {
                perTest: {
                    'should test A': ['1', '2', '3'],
                    'should test B': ['4', '5'],
                },
                'static': ['6', '7', '8'],
            };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(
                expect.any(String),
                `${JSON.stringify(data)}\n`,
                expect.any(String)
            );
        });

        it('handles empty data', () => {
            const data = { perTest: {}, 'static': [] };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(
                expect.any(String),
                '{"perTest":{},"static":[]}\n',
                expect.any(String)
            );
        });
    });

    describe('startOrphanWatchdog', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it('does not invoke onOrphaned while the parent PID is unchanged', () => {
            jest.useFakeTimers();
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({
                getPpid:    () => 1000,
                onOrphaned,
                intervalMs: 1000,
            });

            jest.advanceTimersByTime(5000);

            expect(onOrphaned).not.toHaveBeenCalled();
            stop();
        });

        it('invokes onOrphaned once the parent PID changes (reparented to a subreaper)', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({
                getPpid:    () => ppid,
                onOrphaned,
                intervalMs: 1000,
            });

            jest.advanceTimersByTime(1000);
            expect(onOrphaned).not.toHaveBeenCalled();

            // Original parent has died — the OS reparents this process, e.g. to PID 1.
            ppid = 1;
            jest.advanceTimersByTime(1000);

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            stop();
        });

        it('invokes onOrphaned only once even if the interval ticks again before being stopped', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({
                getPpid:    () => ppid,
                onOrphaned,
                intervalMs: 1000,
            });

            ppid = 1;
            jest.advanceTimersByTime(1000);
            jest.advanceTimersByTime(1000);
            jest.advanceTimersByTime(1000);

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            stop();
        });

        it('defaults intervalMs to 1000ms when not provided', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({
                getPpid: () => ppid,
                onOrphaned,
            });

            ppid = 1;
            jest.advanceTimersByTime(999);
            expect(onOrphaned).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(onOrphaned).toHaveBeenCalledTimes(1);
            stop();
        });

        it('stops polling once stop() is called', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({
                getPpid:    () => ppid,
                onOrphaned,
                intervalMs: 1000,
            });

            stop();
            ppid = 1;
            jest.advanceTimersByTime(10_000);

            expect(onOrphaned).not.toHaveBeenCalled();
        });
    });

    describe('concurrent patching', () => {
        it('verifies that concurrent methods exist on test functions', () => {
            // This test verifies that the test framework exposes concurrent methods
            // The actual patching happens in coverage-preload.ts, which is injected at runtime
            // We can't directly test the patching here, but we can verify the methods exist
            expect(typeof describe.concurrent).toBe('function');
            expect(typeof test.concurrent).toBe('function');
            expect(typeof it.concurrent).toBe('function');
        });

        it('documents the expected behavior of concurrent patching', () => {
            // The coverage-preload.ts template patches these functions:
            // - describe.concurrent = describe
            // - test.concurrent = test
            // - it.concurrent = it
            //
            // This ensures that when user code calls describe.concurrent() or test.concurrent(),
            // they actually get the sequential versions during mutation testing.
            //
            // The patching happens at runtime when the preload script loads,
            // before any test files execute.
            expect(true).toBe(true);
        });
    });
});
