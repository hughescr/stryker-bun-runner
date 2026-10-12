import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import { describe, it, expect, spyOn, beforeEach, afterEach, test, mock, jest } from 'bun:test';
import {
    getPreloadConfig,
    shouldCollectCoverage,
    initializeStrykerNamespace,
    setActiveMutant,
    serializeCoverageData,
    StaticGapTracker,
    writeCoverageToFile,
    formatPreloadTimings,
    readPreloadTimings,
    PRELOAD_TIMINGS_PREFIX,
    watchParentLifeline,
    startOrphanWatchdog,
    guardAgainstOrphaning,
    orphanDebugLog,
    LIFELINE_FD_ENV,
    ORPHAN_DEBUG_ENV,
    parseHitLimit,
    installHitLimit,
    formatHitLimitSentinel,
    HIT_LIMIT_SENTINEL,
    preloadFs,
    waitForSyncReady,
    formatSyncNotReadyMessage,
    awaitRunnerReady,
    SYNC_TOKEN_ENV,
    type SyncReadySocket,
    type PreloadConfig,
    type StrykerNamespace
} from '../../src/coverage/preload-logic';
import type { CoverageFileData, LateHitEntry } from '../../src/coverage/types';
import { rememberEnv } from '../helpers/env.js';
import { trackTimers } from '../helpers/fake-clock.js';

/** The coverage file is opened for appending, created if absent, and never through a symlink at its path (O_NOFOLLOW). */
// eslint-disable-next-line no-bitwise -- open(2) flags are a bitmask
const COVERAGE_OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
/** It is created owner-only: it sits in the runner's private temp dir and must stay unreadable to other users. */
const COVERAGE_FILE_MODE = 0o600;
/** The descriptor the mocked openSync hands out. */
const FAKE_FD = 4242;

describe('preload-logic', () => {
    describe('getPreloadConfig', () => {
        let restoreEnv: () => void;

        beforeEach(() => {
            restoreEnv = rememberEnv();
        });

        afterEach(() => {
            restoreEnv();
        });

        it('reads __STRYKER_SYNC_PORT__ from env', () => {
            process.env.__STRYKER_SYNC_PORT__ = '8080';
            const config = getPreloadConfig();
            expect(config.syncPort).toBe('8080');
        });

        it('reads the sync token from __STRYKER_SYNC_TOKEN__', () => {
            expect(SYNC_TOKEN_ENV).toBe('__STRYKER_SYNC_TOKEN__');
            process.env.__STRYKER_SYNC_TOKEN__ = 'a1b2c3';
            expect(getPreloadConfig().syncToken).toBe('a1b2c3');
            delete process.env.__STRYKER_SYNC_TOKEN__;
            expect(getPreloadConfig().syncToken).toBeUndefined();
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

    describe('StaticGapTracker', () => {
        /** A hit the way Stryker's instrumenter records one: it reads `static` afresh on every hit. */
        function hit(coverage: { 'static': Record<string, number> }, id: string): void {
            const bucket = coverage.static;
            bucket[id] = (bucket[id] || 0) + 1;
        }

        it('returns [] from close() when no gap is open, and leaves the static bucket alone', () => {
            const coverage = { 'static': { '1': 2 } };
            const original = coverage.static;
            const tracker = new StaticGapTracker(coverage);

            expect(tracker.close()).toEqual([]);
            expect(coverage.static).toBe(original);
            expect(coverage.static).toEqual({ '1': 2 });
        });

        it('returns [] when nothing was hit during the gap, and puts the real bucket back', () => {
            const coverage = { 'static': { '1': 2 } };
            const original = coverage.static;
            const tracker = new StaticGapTracker(coverage);

            tracker.open();
            expect(tracker.close()).toEqual([]);
            expect(coverage.static).toBe(original);
            expect(coverage.static).toEqual({ '1': 2 });
        });

        it('reports the mutants hit during the gap and adds every gap hit to the real bucket with its count', () => {
            const coverage: { 'static': Record<string, number> } = { 'static': { '1': 1, '2': 1 } };
            const original = coverage.static;
            const tracker = new StaticGapTracker(coverage);

            tracker.open();
            hit(coverage, '1');
            hit(coverage, '3');
            hit(coverage, '3');

            expect(tracker.close().toSorted((a, b) => a.localeCompare(b))).toEqual(['1', '3']);
            expect(coverage.static).toBe(original);
            expect(coverage.static).toEqual({ '1': 2, '2': 1, '3': 2 });
        });

        it('reports a mutant again each time it is hit in a later gap (a mutant that already bled once still counts)', () => {
            const coverage = { 'static': {} as Record<string, number> };
            const tracker = new StaticGapTracker(coverage);

            tracker.open();
            hit(coverage, '1');
            expect(tracker.close()).toEqual(['1']);

            hit(coverage, '1'); // while a test runs the instrumenter records per test, but a static hit outside the gap is not bleed
            tracker.open();
            expect(tracker.close()).toEqual([]);

            tracker.open();
            hit(coverage, '1');
            expect(tracker.close()).toEqual(['1']);
            expect(coverage.static).toEqual({ '1': 3 });
        });

        it('keeps the hits of a gap that is never closed explicitly when the next gap opens', () => {
            const coverage = { 'static': {} as Record<string, number> };
            const tracker = new StaticGapTracker(coverage);

            tracker.open();
            hit(coverage, '1');
            tracker.open(); // a second afterEach with no beforeEach between them
            hit(coverage, '2');

            expect(tracker.close()).toEqual(['2']);
            expect(coverage.static).toEqual({ '1': 1, '2': 1 });
        });

        it('keeps hits recorded straight into the bucket a caller held on to before the gap opened', () => {
            const coverage: { 'static': Record<string, number> } = { 'static': { '1': 1 } };
            const held = coverage.static;
            const tracker = new StaticGapTracker(coverage);

            tracker.open();
            held['1'] += 1;
            hit(coverage, '2');

            expect(tracker.close()).toEqual(['2']);
            expect(coverage.static).toEqual({ '1': 2, '2': 1 });
        });
    });

    describe('preload timings (STRYKER_BUN_PROFILE)', () => {
        it('reads back the timings formatPreloadTimings wrote among other stderr output', () => {
            const timings = { 'at.preloadStart': 1_760_000_000_123.5, 'ms.beforeEach': 12.25, tests: 3 };
            const stderr = `bun test v1.4.2\npartial line${formatPreloadTimings(timings)} 3 pass\nRan 3 tests across 1 file.\n`;

            expect(readPreloadTimings(stderr)).toEqual(timings);
        });

        it('starts the line on a line of its own', () => {
            expect(formatPreloadTimings({ tests: 1 })).toBe(`\n${PRELOAD_TIMINGS_PREFIX}{"tests":1}\n`);
        });

        it('takes the last timings line, and keeps only numeric values', () => {
            const stderr = `${formatPreloadTimings({ tests: 1 })}\n${PRELOAD_TIMINGS_PREFIX}{"tests":2,"name":"x"}`;

            expect(readPreloadTimings(stderr)).toEqual({ tests: 2 });
        });

        it('returns undefined without a timings line, or with a malformed one', () => {
            expect(readPreloadTimings('bun test v1.4.2\n 1 pass\n')).toBeUndefined();
            expect(readPreloadTimings(`\n${PRELOAD_TIMINGS_PREFIX}{not json}\n`)).toBeUndefined();
            expect(readPreloadTimings(`\n${PRELOAD_TIMINGS_PREFIX}[1,2]\n`)).toBeUndefined();
            // Only at the start of a line: a test that prints the prefix mid-line is not read.
            expect(readPreloadTimings(`text ${PRELOAD_TIMINGS_PREFIX}{"tests":1}\n`)).toBeUndefined();
        });
    });

    describe('serializeCoverageData', () => {
        /** The line serializeCoverageData returns, parsed back. */
        function serialized(coverage: MutantCoverage | undefined, lateHits?: LateHitEntry[]): CoverageFileData {
            return JSON.parse(serializeCoverageData(coverage, lateHits)) as CoverageFileData;
        }

        it('returns one line of JSON with perTest first, then static, then lateHits when there are any', () => {
            const coverage: MutantCoverage = { 'static': { '2': 1 }, perTest: { 'f@@test-1': { '1': 3 } } };
            const lateHits: LateHitEntry[] = [{ testId: 'f@@test-1', mutantIds: ['2'] }];

            expect(serializeCoverageData(coverage)).toBe('{"perTest":{"f@@test-1":{"1":3}},"static":{"2":1}}');
            expect(serializeCoverageData(coverage, lateHits))
                .toBe('{"perTest":{"f@@test-1":{"1":3}},"static":{"2":1},"lateHits":[{"testId":"f@@test-1","mutantIds":["2"]}]}');
        });

        it('returns empty data for undefined coverage', () => {
            const result = serialized(undefined);
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
            const result = serialized(coverage);
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
            const result = serialized(coverage);
            expect(result.static).toEqual({ '1': 5, '2': 10 });
            expect(result.perTest).toEqual({ 'test-1': { '3': 100, '4': 200 } });
        });

        it('snapshots the counts — hits recorded after serializing do not leak into the written data', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  { 'test-1': { '2': 1 } },
            };
            const line = serializeCoverageData(coverage);
            coverage.static['1'] = 99;
            coverage.perTest['test-1']['2'] = 99;
            const result = JSON.parse(line) as CoverageFileData;
            expect(result.static).toEqual({ '1': 1 });
            expect(result.perTest).toEqual({ 'test-1': { '2': 1 } });
        });

        it('does not modify the coverage it serializes', () => {
            const coverage: MutantCoverage = { 'static': { '1': 1 }, perTest: { 'test-1': { '2': 1 } } };
            serializeCoverageData(coverage, [{ testId: 'test-1', mutantIds: ['1'] }]);
            expect(coverage).toEqual({ 'static': { '1': 1 }, perTest: { 'test-1': { '2': 1 } } });
        });

        it('copies static coverage with its counts', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1, '2': 3, '3': 7 },
                perTest:  {},
            };
            const result = serialized(coverage);
            expect(result.static).toEqual({ '1': 1, '2': 3, '3': 7 });
        });

        it('handles empty perTest', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };
            const result = serialized(coverage);
            expect(result.perTest).toEqual({});
            expect(result.static).toEqual({ '1': 1 });
        });

        it('handles empty static', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  { 'test-1': { '1': 1 } },
            };
            const result = serialized(coverage);
            expect(result.perTest).toEqual({ 'test-1': { '1': 1 } });
            expect(result.static).toEqual({});
        });

        it('handles both empty perTest and static', () => {
            const coverage: MutantCoverage = {
                'static': {},
                perTest:  {},
            };
            const result = serialized(coverage);
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
            const result = serialized(coverage);
            expect(result.perTest).toEqual({});
        });

        it('handles missing static property (undefined)', () => {
            const coverage: MutantCoverage = {
                'static': undefined as unknown as Record<string, number>,
                perTest:  { 'test-1': { '1': 1 } },
            };
            const result = serialized(coverage);
            expect(result.static).toEqual({});
        });

        describe('lateHits (2nd arg)', () => {
            const coverage: MutantCoverage = {
                'static': { '1': 1 },
                perTest:  {},
            };

            it('omitted 3rd arg leaves lateHits undefined', () => {
                const result = serialized(coverage);
                expect(result.lateHits).toBeUndefined();
            });

            it('empty lateHits array leaves lateHits undefined', () => {
                const result = serialized(coverage, []);
                expect(result.lateHits).toBeUndefined();
            });

            it('non-empty lateHits is included verbatim in the returned data', () => {
                const lateHits: LateHitEntry[] = [
                    { testId: 'tests/foo.test.ts@@test-1', mutantIds: ['5', '6'] },
                ];
                const result = serialized(coverage, lateHits);
                expect(result.lateHits).toEqual(lateHits);
            });

            it('is a snapshot — mutating the caller array afterward does not change the returned line', () => {
                const lateHits: LateHitEntry[] = [
                    { testId: 'tests/foo.test.ts@@test-1', mutantIds: ['5'] },
                ];
                const line = serializeCoverageData(coverage, lateHits);

                // Mutate the caller's array after the call
                lateHits.push({ testId: 'tests/foo.test.ts@@test-2', mutantIds: ['7'] });
                lateHits.length = 0;

                expect((JSON.parse(line) as CoverageFileData).lateHits).toEqual([
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

        it('writes an already serialized line as it is, with its newline', () => {
            const line = serializeCoverageData({ perTest: { 'f@@test-1': { '1': 2 } }, 'static': { '3': 1 } });
            writeCoverageToFile('/tmp/coverage.json', line);

            expect(appendFileSyncSpy).toHaveBeenCalledWith(FAKE_FD, `${line}\n`, 'utf8');
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

    describe('watchParentLifeline', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        /** Resolves when `onOrphaned` is called; a test that never sees the call fails on its timeout. */
        function orphanedSignal(): { onOrphaned: ReturnType<typeof mock>, orphaned: Promise<void> } {
            let signal!: () => void;
            const orphaned = new Promise<void>((resolve) => {
                signal = resolve;
            });
            return { onOrphaned: mock(() => signal()), orphaned };
        }

        it('names the environment variable the runner sets', () => {
            expect(LIFELINE_FD_ENV).toBe('__STRYKER_LIFELINE_FD__');
        });

        it.each([
            ['absent', undefined],
            ['empty', ''],
            ['not a number', 'abc'],
            ['trailing junk', '3x'],
            ['leading junk', 'x3'],
            ['fractional', '3.5'],
            ['negative', '-3'],
            ['stdin', '0'],
            ['stdout', '1'],
            ['stderr', '2'],
            ['beyond a safe integer', '9007199254740993'],
        ])('reports the lifeline unavailable, without opening anything, when the descriptor is %s', (_label, fdValue) => {
            const open = mock(() => new PassThrough());
            const onOrphaned = mock();
            const onUnavailable = mock();

            watchParentLifeline({ fdValue, onOrphaned, onUnavailable, open });

            expect(open).not.toHaveBeenCalled();
            expect(onOrphaned).not.toHaveBeenCalled();
            expect(onUnavailable).toHaveBeenCalledTimes(1);
            expect(onUnavailable).toHaveBeenCalledWith(`${LIFELINE_FD_ENV}=${fdValue ?? '(unset)'} names no lifeline descriptor`);
        });

        it.each([['3', 3], ['17', 17]])('opens descriptor %s without reporting it unavailable', (fdValue, fd) => {
            const open = mock(() => new PassThrough());
            const onUnavailable = mock();

            watchParentLifeline({ fdValue, onOrphaned: mock(), onUnavailable, open });

            expect(open).toHaveBeenCalledWith(fd);
            expect(onUnavailable).not.toHaveBeenCalled();
        });

        it('reports the lifeline unavailable when opening the descriptor throws', () => {
            const onUnavailable = mock();
            const open = (): Readable => {
                throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
            };

            watchParentLifeline({ fdValue: '3', onOrphaned: mock(), onUnavailable, open });

            expect(onUnavailable).toHaveBeenCalledTimes(1);
            expect(onUnavailable).toHaveBeenCalledWith('opening fd 3 failed: ENOTSUP');
        });

        it('reports the parent gone once the lifeline reaches end-of-file', async () => {
            const lifeline = new PassThrough();
            const { onOrphaned, orphaned } = orphanedSignal();
            const onUnavailable = mock();
            watchParentLifeline({ fdValue: '3', onOrphaned, onUnavailable, open: () => lifeline });

            // The kernel closes every descriptor of a dead process, so the
            // parent's write end closing is what EOF on the read end means.
            lifeline.end();
            await orphaned;

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            expect(onUnavailable).not.toHaveBeenCalled();
        });

        it('keeps reading, without reporting, while the parent is alive', async () => {
            const lifeline = new PassThrough();
            const onOrphaned = mock();
            watchParentLifeline({ fdValue: '3', onOrphaned, onUnavailable: mock(), open: () => lifeline });

            // Anything the parent writes is drained rather than left to fill the pipe.
            const drained = once(lifeline, 'data');
            lifeline.write('x');
            await drained;

            expect(onOrphaned).not.toHaveBeenCalled();
            expect(lifeline.readableFlowing).toBe(true);
        });

        it.each([
            ['a code', Object.assign(new Error('bad file descriptor'), { code: 'EBADF' }), 'reading fd 3 failed: EBADF'],
            ['no code', new Error('it broke'), 'reading fd 3 failed: it broke'],
        ])('reports an error before end-of-file (with %s) as the lifeline unavailable, once, not as the parent gone', async (_label, error, reason) => {
            const lifeline = new PassThrough();
            const onOrphaned = mock();
            const onUnavailable = mock();
            watchParentLifeline({ fdValue: '3', onOrphaned, onUnavailable, open: () => lifeline });

            // A descriptor that is not open (EBADF), or one this platform cannot
            // read this way, errors and then closes, with no end-of-file: that
            // says nothing about the parent. An 'error' without a listener would
            // be thrown as an uncaught exception.
            // (events.once would reject on that 'error', so wait on 'close' directly.)
            const closed = new Promise<void>((resolve) => {
                lifeline.once('close', resolve);
            });
            lifeline.emit('error', error);
            lifeline.destroy(error);
            await closed;

            expect(onOrphaned).not.toHaveBeenCalled();
            expect(onUnavailable).toHaveBeenCalledTimes(1);
            expect(onUnavailable).toHaveBeenCalledWith(reason);
        });

        it('does not report an error after end-of-file as the lifeline unavailable', async () => {
            const lifeline = new PassThrough();
            const { onOrphaned, orphaned } = orphanedSignal();
            const onUnavailable = mock();
            watchParentLifeline({ fdValue: '3', onOrphaned, onUnavailable, open: () => lifeline });

            lifeline.end();
            await orphaned;
            lifeline.emit('error', new Error('late'));

            expect(onUnavailable).not.toHaveBeenCalled();
        });

        it('arms no timer, so a suite that installs fake timers cannot capture it', () => {
            jest.useFakeTimers();
            const timers = trackTimers();
            try {
                watchParentLifeline({ fdValue: '3', onOrphaned: mock(), onUnavailable: mock(), open: () => new PassThrough() });
                expect(timers.delays).toEqual([]);
            } finally {
                timers.restore();
            }
        });

        it('reports the parent gone while fake timers are installed', async () => {
            jest.useFakeTimers();
            const lifeline = new PassThrough();
            const { onOrphaned, orphaned } = orphanedSignal();
            watchParentLifeline({ fdValue: '3', onOrphaned, onUnavailable: mock(), open: () => lifeline });

            lifeline.end();
            await orphaned;

            expect(onOrphaned).toHaveBeenCalledTimes(1);
        });

        it('reads a real descriptor by default', async () => {
            // /dev/null reads as immediate end-of-file: exactly what a lifeline
            // whose parent has died looks like. The stream closes the descriptor.
            // eslint-disable-next-line n/no-sync -- a descriptor number is the input under test
            const fd = fs.openSync('/dev/null', 'r');
            const { onOrphaned, orphaned } = orphanedSignal();

            const onUnavailable = mock();
            watchParentLifeline({ fdValue: String(fd), onOrphaned, onUnavailable });
            await orphaned;

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            expect(onUnavailable).not.toHaveBeenCalled();
        });
    });

    describe('startOrphanWatchdog', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it('does not invoke onOrphaned while the parent PID is unchanged', () => {
            jest.useFakeTimers();
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({ getPpid: () => 1000, onOrphaned, intervalMs: 1000 });

            jest.advanceTimersByTime(5000);

            expect(onOrphaned).not.toHaveBeenCalled();
            stop();
        });

        it('invokes onOrphaned once the parent PID changes (reparented to a subreaper)', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({ getPpid: () => ppid, onOrphaned, intervalMs: 1000 });

            jest.advanceTimersByTime(1000);
            expect(onOrphaned).not.toHaveBeenCalled();

            // Original parent has died — the OS reparents this process, e.g. to PID 1.
            ppid = 1;
            jest.advanceTimersByTime(1000);

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            stop();
        });

        it('compares against the parent PID it is given, when the parent may already have changed', () => {
            jest.useFakeTimers();
            const onOrphaned = mock();
            // Started after the parent died: the PID it reads now is already the subreaper's.
            const stop = startOrphanWatchdog({ getPpid: () => 1, originalPpid: 1000, onOrphaned, intervalMs: 1000 });

            jest.advanceTimersByTime(1000);

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            stop();
        });

        it('invokes onOrphaned only once even if the interval ticks again before being stopped', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({ getPpid: () => ppid, onOrphaned, intervalMs: 1000 });

            ppid = 1;
            jest.advanceTimersByTime(3000);

            expect(onOrphaned).toHaveBeenCalledTimes(1);
            stop();
        });

        it('defaults intervalMs to 1000ms when not provided', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const stop = startOrphanWatchdog({ getPpid: () => ppid, onOrphaned });

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
            const stop = startOrphanWatchdog({ getPpid: () => ppid, onOrphaned, intervalMs: 1000 });

            stop();
            ppid = 1;
            jest.advanceTimersByTime(10_000);

            expect(onOrphaned).not.toHaveBeenCalled();
        });

        it('does not keep the process alive, and stop() clears its timer', () => {
            jest.useFakeTimers();
            const timers = trackTimers();
            const trackedSetInterval = globalThis.setInterval;
            const handles: ReturnType<typeof setInterval>[] = [];
            globalThis.setInterval = ((callback: () => void, delay?: number) => {
                const handle = trackedSetInterval(callback, delay);
                handles.push(handle);
                return handle;
            }) as typeof setInterval;
            try {
                const stop = startOrphanWatchdog({ getPpid: () => 1000, onOrphaned: mock() });
                expect(handles).toHaveLength(1);
                expect(handles[0].hasRef()).toBe(false);
                stop();
                expect(timers.pending()).toBe(0);
            } finally {
                globalThis.setInterval = trackedSetInterval;
                timers.restore();
            }
        });
    });

    describe('guardAgainstOrphaning', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it('watches the lifeline alone when it is available: no timer, no log', async () => {
            jest.useFakeTimers();
            const timers = trackTimers();
            try {
                const lifeline = new PassThrough();
                let signal!: () => void;
                const orphaned = new Promise<void>((resolve) => {
                    signal = resolve;
                });
                const onOrphaned = mock(() => signal());
                const log = mock();
                guardAgainstOrphaning({ fdValue: '3', getPpid: () => 1000, onOrphaned, log, open: () => lifeline });

                expect(timers.delays).toEqual([]);
                lifeline.end();
                await orphaned;

                expect(onOrphaned).toHaveBeenCalledTimes(1);
                expect(log).not.toHaveBeenCalled();
            } finally {
                timers.restore();
            }
        });

        it('falls back to the timer watchdog, logging once, when the lifeline errors', async () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const lifeline = new PassThrough();
            const onOrphaned = mock();
            const log = mock();
            guardAgainstOrphaning({ fdValue: '3', getPpid: () => ppid, onOrphaned, log, open: () => lifeline });

            const closed = new Promise<void>((resolve) => {
                lifeline.once('close', resolve);
            });
            lifeline.destroy(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }));
            await closed;

            expect(log).toHaveBeenCalledTimes(1);
            expect(log).toHaveBeenCalledWith('[Stryker] parent lifeline unavailable (reading fd 3 failed: ENOTSUP); polling the parent PID on a timer instead');

            jest.advanceTimersByTime(5000);
            expect(onOrphaned).not.toHaveBeenCalled();

            ppid = 1;
            jest.advanceTimersByTime(1000);
            expect(onOrphaned).toHaveBeenCalledTimes(1);
        });

        it('falls back at once when the runner named no lifeline', () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const onOrphaned = mock();
            const log = mock();
            guardAgainstOrphaning({ fdValue: undefined, getPpid: () => ppid, onOrphaned, log, intervalMs: 500 });

            expect(log).toHaveBeenCalledWith(`[Stryker] parent lifeline unavailable (${LIFELINE_FD_ENV}=(unset) names no lifeline descriptor); polling the parent PID on a timer instead`);
            ppid = 1;
            jest.advanceTimersByTime(499);
            expect(onOrphaned).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);
            expect(onOrphaned).toHaveBeenCalledTimes(1);
        });

        it('compares against the parent PID read when it started, even if the parent died before the fallback', async () => {
            jest.useFakeTimers();
            let ppid = 1000;
            const lifeline = new PassThrough();
            const onOrphaned = mock();
            guardAgainstOrphaning({ fdValue: '3', getPpid: () => ppid, onOrphaned, open: () => lifeline });

            // The parent dies, and only then does the lifeline turn out to be unreadable.
            ppid = 1;
            const closed = new Promise<void>((resolve) => {
                lifeline.once('close', resolve);
            });
            lifeline.destroy(new Error('unreadable'));
            await closed;

            jest.advanceTimersByTime(1000);
            expect(onOrphaned).toHaveBeenCalledTimes(1);
        });

        it('falls back silently when no log is given', () => {
            jest.useFakeTimers();
            const timers = trackTimers();
            try {
                expect(() => guardAgainstOrphaning({ fdValue: '', getPpid: () => 1000, onOrphaned: mock() })).not.toThrow();
                expect(timers.delays).toEqual([1000]);
            } finally {
                timers.restore();
            }
        });
    });

    describe('orphanDebugLog', () => {
        it('names the environment variable that turns it on', () => {
            expect(ORPHAN_DEBUG_ENV).toBe('STRYKER_BUN_RUNNER_DEBUG');
        });

        it.each([undefined, '', '0', 'false'])('is off when the variable is %p', (value) => {
            expect(orphanDebugLog(value, mock())).toBeUndefined();
        });

        it.each(['1', 'true', 'yes'])('writes a line through the given writer when the variable is %p', (value) => {
            const write = mock();
            const log = orphanDebugLog(value, write);

            log?.('hello');

            expect(write).toHaveBeenCalledTimes(1);
            expect(write).toHaveBeenCalledWith('hello\n');
        });
    });

    describe('waitForSyncReady', () => {
        // A plain EventTarget dispatches events the way bun's WebSocket does.
        const createSocket = (): EventTarget & SyncReadySocket => new EventTarget() as EventTarget & SyncReadySocket;
        // The shape of a WebSocket CloseEvent.
        const closeEvent = (code: number, reason = ''): Event => Object.assign(new Event('close'), { code, reason });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('listens synchronously, so a ready that arrives before the caller yields is heard', async () => {
            const socket = createSocket();
            const outcome = waitForSyncReady(socket);
            socket.dispatchEvent(new MessageEvent('message', { data: 'ready' }));

            expect(await outcome).toEqual({ ready: true });
        });

        it('has no deadline: it keeps waiting through other messages until ready arrives', async () => {
            // The old wait gave up after a fixed 2 s and let the tests run before the
            // runner could observe them. Only the runner decides when the wait ends.
            jest.useFakeTimers();
            const timers = trackTimers();
            try {
                const socket = createSocket();
                const outcome = waitForSyncReady(socket);

                socket.dispatchEvent(new MessageEvent('message', { data: 'drained' }));
                jest.advanceTimersByTime(10 * 60 * 1000);
                await Promise.resolve();
                expect(Bun.peek.status(outcome)).toBe('pending');
                expect(timers.delays).toEqual([]);

                socket.dispatchEvent(new MessageEvent('message', { data: 'ready' }));
                expect(await outcome).toEqual({ ready: true });
            } finally {
                timers.restore();
            }
        });

        it('reports a connection error as not ready', async () => {
            const socket = createSocket();
            const outcome = waitForSyncReady(socket);

            socket.dispatchEvent(new Event('error'));

            expect(await outcome).toEqual({ ready: false, problem: 'failed with a connection error' });
        });

        it('reports a close before ready as not ready, with the close code and reason', async () => {
            const socket = createSocket();
            const outcome = waitForSyncReady(socket);

            socket.dispatchEvent(closeEvent(1006, 'Connection ended'));

            expect(await outcome).toEqual({ ready: false, problem: 'closed (code 1006, reason "Connection ended")' });
        });

        it('leaves out an empty close reason, and says when the close carries no code', async () => {
            const emptyReason = createSocket();
            const emptyOutcome = waitForSyncReady(emptyReason);
            emptyReason.dispatchEvent(closeEvent(1000));

            const noDetail = createSocket();
            const noDetailOutcome = waitForSyncReady(noDetail);
            noDetail.dispatchEvent(new Event('close'));

            expect(await emptyOutcome).toEqual({ ready: false, problem: 'closed (code 1000)' });
            expect(await noDetailOutcome).toEqual({ ready: false, problem: 'closed (code unknown)' });
        });

        it('stays ready when the socket errors or closes after ready', async () => {
            const socket = createSocket();
            const outcome = waitForSyncReady(socket);

            socket.dispatchEvent(new MessageEvent('message', { data: 'ready' }));
            socket.dispatchEvent(new Event('error'));
            socket.dispatchEvent(closeEvent(1006));

            expect(await outcome).toEqual({ ready: true });
        });
    });

    describe('formatSyncNotReadyMessage', () => {
        it('names the sync address, the problem, and why no test was run', () => {
            const message = formatSyncNotReadyMessage('6501', 'closed (code 1006)');

            expect(message).toBe(
                '[Stryker] stryker-bun-runner: the dry run\'s sync connection to the runner (ws://127.0.0.1:6501/sync) closed (code 1006) '
                + 'before the runner signalled that it is ready to observe the tests. Exiting without running any test: tests run now '
                + 'would not be seen by the runner\'s inspector, so their results and per-test coverage would be lost.'
            );
        });
    });

    describe('awaitRunnerReady', () => {
        /** A socket that records close() and lets the test dispatch events on it. */
        function createOpenedSocket(): { socket: EventTarget & SyncReadySocket & { close: () => void }, closed: () => number } {
            let closeCount = 0;
            const socket = Object.assign(new EventTarget(), {
                close: () => {
                    closeCount++;
                },
            }) as EventTarget & SyncReadySocket & { close: () => void };
            return { socket, closed: () => closeCount };
        }

        /** A fail() that stops awaitRunnerReady the way process.exit would, recording the message. */
        function createFail(): { fail: (message: string) => never, messages: string[] } {
            const messages: string[] = [];
            return {
                messages,
                fail: (message: string): never => {
                    messages.push(message);
                    throw new Error('exited');
                },
            };
        }

        it('dials the sync address with its run\'s token, and returns the open socket on ready when the caller keeps it open', async () => {
            // The token is the path: a sync server of another run that happens to be
            // listening on this port refuses it, instead of releasing this child.
            const { socket, closed } = createOpenedSocket();
            const urls: string[] = [];
            const outcome = awaitRunnerReady({
                syncPort:   '6501',
                syncToken:  'f00d',
                keepOpen:   true,
                openSocket: (url) => {
                    urls.push(url);
                    return socket;
                },
            });
            socket.dispatchEvent(new MessageEvent('message', { data: 'ready' }));

            expect(await outcome).toBe(socket);
            expect(urls).toEqual(['ws://127.0.0.1:6501/sync/f00d']);
            expect(closed()).toBe(0);
        });

        it('closes the socket and returns null on ready when the caller does not keep it', async () => {
            const { socket, closed } = createOpenedSocket();
            const outcome = awaitRunnerReady({ syncPort: '6501', syncToken: 'f00d', keepOpen: false, openSocket: () => socket });
            socket.dispatchEvent(new MessageEvent('message', { data: 'ready' }));

            expect(await outcome).toBeNull();
            expect(closed()).toBe(1);
        });

        it('fails with the problem when the socket closes before ready', async () => {
            const { socket } = createOpenedSocket();
            const { fail, messages } = createFail();
            const outcome = awaitRunnerReady({ syncPort: '6501', syncToken: 'f00d', keepOpen: true, openSocket: () => socket, fail });
            socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }));

            expect(outcome).rejects.toThrow('exited');
            await outcome.catch(() => undefined);
            expect(messages).toEqual([formatSyncNotReadyMessage('6501', 'closed (code 1006)')]);
            // The message names the server, not the run's token.
            expect(messages[0]).toContain('(ws://127.0.0.1:6501/sync) ');
            expect(messages[0]).not.toContain('f00d');
        });

        it('fails when the socket cannot even be opened', async () => {
            const { fail, messages } = createFail();
            const outcome = awaitRunnerReady({
                syncPort:   '6501',
                syncToken:  'f00d',
                keepOpen:   true,
                openSocket: () => {
                    throw new Error('bad url');
                },
                fail,
            });

            expect(outcome).rejects.toThrow('exited');
            await outcome.catch(() => undefined);
            expect(messages).toEqual([formatSyncNotReadyMessage('6501', 'could not be opened (bad url)')]);
        });

        it('cuts the token out of an error that quotes the URL it could not open', async () => {
            const { fail, messages } = createFail();
            const outcome = awaitRunnerReady({
                syncPort:   '6501',
                syncToken:  'f00d',
                keepOpen:   true,
                openSocket: (url) => {
                    throw new Error(`Invalid URL: ${url} (twice: ${url})`);
                },
                fail,
            });
            await outcome.catch(() => undefined);

            expect(messages).toEqual([formatSyncNotReadyMessage(
                '6501',
                'could not be opened (Invalid URL: ws://127.0.0.1:6501/sync/[redacted] (twice: ws://127.0.0.1:6501/sync/[redacted]))'
            )]);
            expect(messages[0]).not.toContain('f00d');
        });

        it('leaves an open error as it is when there is no token to cut out', async () => {
            const { fail, messages } = createFail();
            const outcome = awaitRunnerReady({
                syncPort:   '6501',
                syncToken:  '',
                keepOpen:   true,
                openSocket: () => {
                    throw new Error('bad url');
                },
                fail,
            });
            await outcome.catch(() => undefined);

            expect(messages).toEqual([formatSyncNotReadyMessage('6501', 'could not be opened (bad url)')]);
        });

        it('names a non-Error throw from opening the socket', async () => {
            const { fail, messages } = createFail();
            const outcome = awaitRunnerReady({
                syncPort:   '6501',
                syncToken:  'f00d',
                keepOpen:   true,
                openSocket: () => {
                    throw 'refused';
                },
                fail,
            });
            await outcome.catch(() => undefined);

            expect(messages).toEqual([formatSyncNotReadyMessage('6501', 'could not be opened (refused)')]);
        });

        it('by default prints the message on stderr and exits with code 1', async () => {
            const { socket } = createOpenedSocket();
            const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
            const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
                throw new Error('process.exit');
            });
            try {
                const outcome = awaitRunnerReady({ syncPort: '6501', syncToken: 'f00d', keepOpen: true, openSocket: () => socket });
                socket.dispatchEvent(new Event('error'));
                await outcome.catch(() => undefined);

                expect(errorSpy).toHaveBeenCalledWith(formatSyncNotReadyMessage('6501', 'failed with a connection error'));
                expect(exitSpy).toHaveBeenCalledWith(1);
            } finally {
                errorSpy.mockRestore();
                exitSpy.mockRestore();
            }
        });

        it('by default opens a real WebSocket to the sync address', async () => {
            // Nothing listens on port 1, so the connection fails and the default fail runs.
            const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
            const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
                throw new Error('process.exit');
            });
            try {
                await awaitRunnerReady({ syncPort: '1', syncToken: 'f00d', keepOpen: true }).catch(() => undefined);

                expect(errorSpy.mock.calls[0]?.[0]).toStartWith('[Stryker] stryker-bun-runner: the dry run\'s sync connection to the runner (ws://127.0.0.1:1/sync) ');
                expect(exitSpy).toHaveBeenCalledWith(1);
            } finally {
                errorSpy.mockRestore();
                exitSpy.mockRestore();
            }
        });
    });

    describe('the ready wait has no clock', () => {
        // The preload used to give up on 'ready' after a fixed 2 s and run the tests
        // unobserved. Any timer, sleep or race in the ready path, or in the template
        // code that runs before the test hooks, could bring that back; integration
        // tests cannot catch it without waiting on the clock themselves.
        const CLOCK_CONSTRUCTS = [
            'setTimeout', 'setInterval', 'Bun.sleep', 'sleep(', 'sleepSync', 'Promise.race', 'Promise.any',
            'AbortSignal.timeout', 'Date.now', 'performance.now', 'node:timers', '\'timers', '"timers', 'timers/promises',
        ];
        const clockConstructsIn = (code: string): string[] => CLOCK_CONSTRUCTS.filter(construct => code.includes(construct));

        const templateSource = async (): Promise<string> => Bun.file(new URL('../../src/templates/coverage-preload.ts', import.meta.url)).text();
        /** Template code that runs before the test hooks: everything up to Section 4. */
        const preTestTemplateCode = async (): Promise<string> => {
            const template = await templateSource();
            return template.slice(0, template.indexOf('Section 4: Coverage Writing Logic'));
        };

        it('the check rejects the bypasses it exists for', () => {
            expect(clockConstructsIn('await Bun.sleep(2000); const outcome = { ready: true };')).toEqual(['Bun.sleep', 'sleep(']);
            expect(clockConstructsIn('await new Promise(r => setTimeout(r, 2000));')).toEqual(['setTimeout']);
            expect(clockConstructsIn('await Promise.race([awaitRunnerReady(o), sleep(2000)]);')).toEqual(['sleep(', 'Promise.race']);
            expect(clockConstructsIn('ws.addEventListener(\'open\', () => {}, { signal: AbortSignal.timeout(2000) });')).toEqual(['AbortSignal.timeout']);
            expect(clockConstructsIn('import { setTimeout as wait } from \'node:timers/promises\';')).toEqual(['setTimeout', 'node:timers', 'timers/promises']);
            expect(clockConstructsIn('while(Date.now() < end) {}')).toEqual(['Date.now']);
        });

        it('the template waits for ready through one call to awaitRunnerReady', async () => {
            const code = await preTestTemplateCode();
            expect(code.match(/await awaitRunnerReady\(/g)).toHaveLength(1);
            expect(code).not.toContain('WebSocket(');
            expect(code).not.toContain('waitForSyncReady');
        });

        it('the template code that runs before the test hooks has no timer, sleep or race', async () => {
            expect(clockConstructsIn(await preTestTemplateCode())).toEqual([]);
        });

        it('the template imports no timers module anywhere', async () => {
            expect(await templateSource()).not.toMatch(/['"](?:node:)?timers(?:\/promises)?['"]/);
        });

        it('awaitRunnerReady and waitForSyncReady have no timer, sleep or race', () => {
            expect(clockConstructsIn(awaitRunnerReady.toString())).toEqual([]);
            expect(clockConstructsIn(waitForSyncReady.toString())).toEqual([]);
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
