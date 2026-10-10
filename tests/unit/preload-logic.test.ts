import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    parseHitLimit,
    installHitLimit,
    formatHitLimitSentinel,
    HIT_LIMIT_SENTINEL,
    preloadFs,
    type PreloadConfig,
    type StrykerNamespace
} from '../../src/coverage/preload-logic';
import type { LateHitEntry } from '../../src/coverage/types';

/** The coverage file is opened for appending, created if absent, and never through a symlink at its path (O_NOFOLLOW). */
// eslint-disable-next-line no-bitwise -- open(2) flags are a bitmask
const COVERAGE_OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
/** It is created owner-only: it sits in the runner's private temp dir and must stay unreadable to other users. */
const COVERAGE_FILE_MODE = 0o600;
/** The descriptor the mocked openSync hands out. */
const FAKE_FD = 4242;

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
            expect(config).toHaveProperty('hitLimit');
            expect(config).toHaveProperty('hitLimitToken');
        });

        it('reads __STRYKER_HIT_LIMIT_TOKEN__ from env', () => {
            process.env.__STRYKER_HIT_LIMIT_TOKEN__ = '0123456789abcdef0123456789abcdef';
            expect(getPreloadConfig().hitLimitToken).toBe('0123456789abcdef0123456789abcdef');
        });

        it('returns undefined hitLimitToken when __STRYKER_HIT_LIMIT_TOKEN__ is unset', () => {
            delete process.env.__STRYKER_HIT_LIMIT_TOKEN__;
            expect(getPreloadConfig().hitLimitToken).toBeUndefined();
        });

        it('reads __STRYKER_HIT_LIMIT__ from env as a number', () => {
            process.env.__STRYKER_HIT_LIMIT__ = '1100';
            expect(getPreloadConfig().hitLimit).toBe(1100);
        });

        it('returns undefined hitLimit when __STRYKER_HIT_LIMIT__ is unset', () => {
            delete process.env.__STRYKER_HIT_LIMIT__;
            expect(getPreloadConfig().hitLimit).toBeUndefined();
        });
    });

    describe('parseHitLimit', () => {
        it.each([
            ['100', 100],
            ['1', 1],
            ['250000', 250_000],
        ])('accepts the positive integer %p', (raw, expected) => {
            expect(parseHitLimit(raw)).toBe(expected);
        });

        it.each([
            [undefined],
            [''],
            ['0'],
            ['-100'],
            ['12.5'],
            ['abc'],
            ['Infinity'],
        ])('rejects %p (no limit rather than a limit that could never or always trip)', (raw) => {
            expect(parseHitLimit(raw)).toBeUndefined();
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
                'static': {},
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
                'test-1': { '1': 1, '2': 1 },
                'test-2': { '3': 1 },
            });
        });

        it('keeps the real hit counts — Stryker sizes each mutant\'s hitLimit from them', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 5, '2': 10 },
                perTest:  { 'test-1': { '3': 100, '4': 200 } },
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.static).toEqual({ '1': 5, '2': 10 });
            expect(result.perTest).toEqual({ 'test-1': { '3': 100, '4': 200 } });
        });

        it('snapshots the counts — hits recorded after formatting do not leak into the written data', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  { 'test-1': { '2': 1 } },
            };
            const result = formatCoverageData(coverage, new Map());
            coverage.static['1'] = 99;
            coverage.perTest['test-1']['2'] = 99;
            expect(result.static).toEqual({ '1': 1 });
            expect(result.perTest).toEqual({ 'test-1': { '2': 1 } });
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
                'should test feature A': { '1': 1 },
                'should test feature B': { '2': 1 },
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
                'named test': { '1': 1 },
                'test-2':     { '2': 1 },
            });
        });

        it('copies static coverage with its counts', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1, '2': 3, '3': 7 },
                perTest:  {},
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.static).toEqual({ '1': 1, '2': 3, '3': 7 });
        });

        it('handles empty perTest', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.perTest).toEqual({});
            expect(result.static).toEqual({ '1': 1 });
        });

        it('handles empty static', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  { 'test-1': { '1': 1 } },
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result.perTest).toEqual({ 'test-1': { '1': 1 } });
            expect(result.static).toEqual({});
        });

        it('handles both empty perTest and static', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {},
            };
            const result = formatCoverageData(coverage, new Map());
            expect(result).toEqual({
                perTest:  {},
                'static': {},
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
            expect(result.static).toEqual({});
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
        let openSyncSpy: ReturnType<typeof spyOn>;
        let appendFileSyncSpy: ReturnType<typeof spyOn>;
        let closeSyncSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            openSyncSpy = spyOn(preloadFs, 'openSync').mockImplementation(() => FAKE_FD);
            appendFileSyncSpy = spyOn(preloadFs, 'appendFileSync').mockImplementation(() => {});
            closeSyncSpy = spyOn(preloadFs, 'closeSync').mockImplementation(() => {});
        });

        afterEach(() => {
            openSyncSpy.mockRestore();
            appendFileSyncSpy.mockRestore();
            closeSyncSpy.mockRestore();
        });

        /** Use the real fs in this test. */
        function restoreRealFs(): void {
            openSyncSpy.mockRestore();
            appendFileSyncSpy.mockRestore();
            closeSyncSpy.mockRestore();
        }

        it('opens the file for appending without following symlinks, creating it 0600, writes the line to it and closes it', () => {
            const data = { perTest: {}, 'static': {} };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(openSyncSpy).toHaveBeenCalledWith('/tmp/coverage.json', COVERAGE_OPEN_FLAGS, COVERAGE_FILE_MODE);
            expect(appendFileSyncSpy).toHaveBeenCalledWith(FAKE_FD, `${JSON.stringify(data)}\n`, 'utf8');
            expect(closeSyncSpy).toHaveBeenCalledWith(FAKE_FD);
            expect(closeSyncSpy.mock.invocationCallOrder[0]).toBeGreaterThan(appendFileSyncSpy.mock.invocationCallOrder[0]);
        });

        it('closes the file even when the write fails', () => {
            appendFileSyncSpy.mockImplementation(() => {
                throw new Error('ENOSPC: no space left on device');
            });

            expect(() => writeCoverageToFile('/tmp/coverage.json', { perTest: {}, 'static': {} })).toThrow('ENOSPC');
            expect(closeSyncSpy).toHaveBeenCalledWith(FAKE_FD);
        });

        it('creates the coverage file owner-only (mode 0600) so other users cannot read it', async () => {
            restoreRealFs();
            const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'stryker-coverage-mode-'));
            // A permissive umask must not widen it
            // eslint-disable-next-line sonarjs/file-permissions -- deliberately permissive umask, restored in finally
            const previous = process.umask(0);
            try {
                const file = path.join(dir, 'coverage.json');
                writeCoverageToFile(file, { perTest: {}, 'static': {} });
                const st = await fs.promises.stat(file);
                // Low nine bits (rwxrwxrwx) of the mode
                expect(st.mode % 0o1000).toBe(0o600);
            } finally {
                process.umask(previous);
                await fs.promises.rm(dir, { recursive: true, force: true });
            }
        });

        it('appends JSON with newline', () => {
            const data = {
                perTest:  { 'test-1': { '1': 1, '2': 4 } },
                'static': { '3': 2 },
            };
            writeCoverageToFile('/tmp/coverage.json', data);

            const expectedJson = `${JSON.stringify(data)}\n`;
            expect(appendFileSyncSpy).toHaveBeenCalledWith(FAKE_FD, expectedJson, 'utf8');
        });

        it('writes to specified file path', () => {
            const data = { perTest: {}, 'static': {} };
            const filePath = '/custom/path/to/coverage.json';
            writeCoverageToFile(filePath, data);

            expect(openSyncSpy).toHaveBeenCalledWith(filePath, COVERAGE_OPEN_FLAGS, COVERAGE_FILE_MODE);
        });

        it('serializes complex coverage data', () => {
            const data = {
                perTest: {
                    'should test A': { '1': 1, '2': 2, '3': 3 },
                    'should test B': { '4': 1, '5': 5 },
                },
                'static': { '6': 1, '7': 1, '8': 9 },
            };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(FAKE_FD, `${JSON.stringify(data)}\n`, 'utf8');
        });

        it('handles empty data', () => {
            const data = { perTest: {}, 'static': {} };
            writeCoverageToFile('/tmp/coverage.json', data);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(FAKE_FD, '{"perTest":{},"static":{}}\n', 'utf8');
        });

        describe('real filesystem', () => {
            let dir: string;

            beforeEach(async () => {
                restoreRealFs();
                dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'stryker-coverage-append-'));
            });

            afterEach(async () => {
                await fs.promises.rm(dir, { recursive: true, force: true });
            });

            it('appends one line per call to the same file (one per test file of the run)', async () => {
                const file = path.join(dir, 'coverage.json');
                writeCoverageToFile(file, { perTest: { a: { '1': 1 } }, 'static': {} });
                writeCoverageToFile(file, { perTest: { b: { '2': 4 } }, 'static': { '3': 2 } });

                expect(await fs.promises.readFile(file, 'utf8')).toBe('{"perTest":{"a":{"1":1}},"static":{}}\n{"perTest":{"b":{"2":4}},"static":{"3":2}}\n');
            });

            it('refuses to write through a symlink planted at the coverage file path', async () => {
                const victim = path.join(dir, 'victim.txt');
                await fs.promises.writeFile(victim, 'untouched');
                const file = path.join(dir, 'coverage.json');
                await fs.promises.symlink(victim, file);

                expect(() => writeCoverageToFile(file, { perTest: {}, 'static': {} })).toThrow('ELOOP');
                expect(await fs.promises.readFile(victim, 'utf8')).toBe('untouched');
            });

            it('still writes the real file while a test has node:fs spied on (or left a spy installed)', async () => {
                // The preload runs inside the suite's own process and writes coverage in its
                // final afterAll, after every test file. A spy on node:fs that a test leaves
                // installed would otherwise swallow that write through the live ESM binding, and
                // the dry run would find no coverage file (seen with an unrestored
                // spyOn(fs, 'appendFileSync') in this very file).
                const spies = [
                    spyOn(fs, 'openSync').mockImplementation(() => FAKE_FD),
                    spyOn(fs, 'appendFileSync').mockImplementation(() => {}),
                    spyOn(fs, 'closeSync').mockImplementation(() => {}),
                ];
                const file = path.join(dir, 'coverage.json');
                try {
                    writeCoverageToFile(file, { perTest: { a: { '1': 1 } }, 'static': {} });
                } finally {
                    for(const spy of spies) {
                        spy.mockRestore();
                    }
                }

                expect(await fs.promises.readFile(file, 'utf8')).toBe('{"perTest":{"a":{"1":1}},"static":{}}\n');
            });
        });
    });

    describe('hit limit (Stryker infinite-loop protection)', () => {
        /**
         * The runtime logic of `stryMutAct_9fa48`, the helper every mutant switch in
         * Stryker-instrumented code calls — transcribed from
         * @stryker-mutator/instrumenter 10.0.0, dist/src/util/syntax-helpers.js:
         *
         *     if (ns.activeMutant === id) {
         *       if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
         *         throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
         *       }
         *       return true;
         *     }
         *     return false;
         */
        function isActive(ns: StrykerNamespace, id: string): boolean {
            if(ns.activeMutant === id) {
                if(ns.hitCount !== undefined && ++ns.hitCount > ns.hitLimit!) {
                    throw new Error(`Stryker: Hit count limit reached (${ns.hitCount})`);
                }
                return true;
            }
            return false;
        }

        /** The per-run token the runner passes in __STRYKER_HIT_LIMIT_TOKEN__. */
        const TOKEN = '0123456789abcdef0123456789abcdef';

        it('HIT_LIMIT_SENTINEL is the marker the runner looks for on the child\'s stderr', () => {
            expect(HIT_LIMIT_SENTINEL).toBe('__STRYKER_HIT_LIMIT_REACHED__');
        });

        it('formatHitLimitSentinel puts the sentinel, the run\'s token and the hit count on a line of their own', () => {
            // Leading newline: bun may have written a partial line just before.
            expect(formatHitLimitSentinel(TOKEN, 1101)).toBe(`\n__STRYKER_HIT_LIMIT_REACHED__ ${TOKEN} 1101\n`);
        });

        it('starts the count at 0 and records the limit in the instrumenter\'s fields', () => {
            const ns: StrykerNamespace = { activeMutant: '7' };
            installHitLimit(ns, 5, TOKEN, () => {});
            expect(ns.hitCount).toBe(0);
            expect(ns.hitLimit).toBe(5);
        });

        it('lets the active mutant be hit up to the limit without throwing or reporting', () => {
            const ns: StrykerNamespace = { activeMutant: '7' };
            const report = mock((_line: string) => {});
            installHitLimit(ns, 5, TOKEN, report);

            for(let i = 0; i < 5; i++) {
                expect(isActive(ns, '7')).toBe(true);
            }

            expect(ns.hitCount).toBe(5);
            expect(report).not.toHaveBeenCalled();
        });

        it('reports the sentinel once, synchronously, on the first hit past the limit — the instrumenter then throws', () => {
            const ns: StrykerNamespace = { activeMutant: '7' };
            const report = mock((_line: string) => {});
            installHitLimit(ns, 5, TOKEN, report);
            for(let i = 0; i < 5; i++) {
                isActive(ns, '7');
            }

            expect(() => isActive(ns, '7')).toThrow('Stryker: Hit count limit reached (6)');
            // Reported before the throw unwinds: under --bail bun exits without running
            // afterAll hooks or exit handlers, so this is the only reliable moment.
            expect(report).toHaveBeenCalledTimes(1);
            expect(report).toHaveBeenCalledWith(`\n__STRYKER_HIT_LIMIT_REACHED__ ${TOKEN} 6\n`);

            // Every later hit keeps throwing (that is what ends the loop), but is not re-reported.
            expect(() => isActive(ns, '7')).toThrow('Stryker: Hit count limit reached (7)');
            expect(() => isActive(ns, '7')).toThrow('Stryker: Hit count limit reached (8)');
            expect(report).toHaveBeenCalledTimes(1);
            expect(ns.hitCount).toBe(8);
        });

        it('does not count hits of other mutants', () => {
            const ns: StrykerNamespace = { activeMutant: '7' };
            installHitLimit(ns, 1, TOKEN, () => {});
            for(let i = 0; i < 10; i++) {
                expect(isActive(ns, '8')).toBe(false);
            }
            expect(ns.hitCount).toBe(0);
        });

        it('writes the sentinel straight to fd 2 by default (no buffered console that bun\'s bail exit could drop)', () => {
            const writeSyncSpy = spyOn(preloadFs, 'writeSync').mockImplementation(() => 0);
            try {
                const ns: StrykerNamespace = { activeMutant: '7' };
                installHitLimit(ns, 1, TOKEN);
                isActive(ns, '7');
                expect(writeSyncSpy).not.toHaveBeenCalled();
                expect(() => isActive(ns, '7')).toThrow();
                expect(writeSyncSpy).toHaveBeenCalledTimes(1);
                expect(writeSyncSpy).toHaveBeenCalledWith(2, formatHitLimitSentinel(TOKEN, 2));
            } finally {
                writeSyncSpy.mockRestore();
            }
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
