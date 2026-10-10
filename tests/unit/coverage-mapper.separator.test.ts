/**
 * A coverage key is `relativeFile@@test-N`. A test file's directory may itself
 * contain `@@` (a scoped-package style name such as `tests/x@@y/`), so the key
 * is split at its LAST `@@`: the counter after it never contains one.
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import { describe, it, expect, mock } from 'bun:test';
import { mapCoverageToInspectorIds, buildInspectorIdToProjectFile, splitCounterKey } from '../../src/coverage/coverage-mapper.js';
import type { TestInfo } from '../../src/inspector/types.js';

const makeLogger = () => ({ warn: mock(() => {}), debug: mock(() => {}) });

function testEntry(id: number, fullName: string, file: string): [number, TestInfo] {
    return [id, { id, name: fullName, fullName, type: 'test', url: `file:///.stryker-tmp/sandbox-ABC/${file}` }];
}

describe('splitCounterKey', () => {
    it('splits an ordinary key into its file and counter position', () => {
        expect(splitCounterKey('tests/foo.test.ts@@test-3')).toEqual({ filePrefix: 'tests/foo.test.ts', position: 3 });
    });

    it('splits at the LAST "@@", so a directory containing one stays in the file prefix', () => {
        expect(splitCounterKey('tests/x@@y/a.test.ts@@test-12')).toEqual({ filePrefix: 'tests/x@@y/a.test.ts', position: 12 });
    });

    it('reads the position after the last "@@" even when the directory looks like a counter', () => {
        expect(splitCounterKey('tests/a@@test-9/b.test.ts@@test-2')).toEqual({ filePrefix: 'tests/a@@test-9/b.test.ts', position: 2 });
    });

    it('keeps everything before the last "@@" and accepts an empty file prefix', () => {
        expect(splitCounterKey('tests/a@@test-1@@test-4')).toEqual({ filePrefix: 'tests/a@@test-1', position: 4 });
        expect(splitCounterKey('@@test-5')).toEqual({ filePrefix: '', position: 5 });
    });

    it('treats a key without any "@@" as a file prefix with position 0', () => {
        expect(splitCounterKey('tests/foo.test.ts')).toEqual({ filePrefix: 'tests/foo.test.ts', position: 0 });
    });

    it('gives position 0 to a counter that is not a number', () => {
        expect(splitCounterKey('tests/foo.test.ts@@oops')).toEqual({ filePrefix: 'tests/foo.test.ts', position: 0 });
    });
});

describe('coverage keys whose test directory contains "@@"', () => {
    it('buildInspectorIdToProjectFile maps each start to the file it ran in', () => {
        const result = buildInspectorIdToProjectFile(
            ['tests/x@@y/a.test.ts@@test-1', 'tests/b.test.ts@@test-1', 'tests/x@@y/a.test.ts@@test-2'],
            [10, 20, 11]
        );

        expect([...result]).toEqual([[10, 'tests/x@@y/a.test.ts'], [20, 'tests/b.test.ts'], [11, 'tests/x@@y/a.test.ts']]);
    });

    it('mapCoverageToInspectorIds credits each test, with no orphaned key and no warning', () => {
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  {
                'tests/x@@y/a.test.ts@@test-1': { '1': 1 },
                'tests/x@@y/a.test.ts@@test-2': { '2': 1 },
                'tests/b.test.ts@@test-1':      { '3': 1 },
            },
        };
        const testHierarchy = new Map<number, TestInfo>([testEntry(42, 'Suite > one', 'tests/x@@y/a.test.ts'), testEntry(43, 'Suite > two', 'tests/x@@y/a.test.ts'), testEntry(44, 'Suite > three', 'tests/b.test.ts')]);
        const logger = makeLogger();

        const { coverage, orphanedKeyCount, inspectorIdToProjectFile } = mapCoverageToInspectorIds(rawCoverage, [42, 43, 44], testHierarchy, logger);

        expect(coverage).toEqual({
            'static': {},
            perTest:  {
                'tests/x@@y/a.test.ts > Suite > one': { '1': 1 },
                'tests/x@@y/a.test.ts > Suite > two': { '2': 1 },
                'tests/b.test.ts > Suite > three':    { '3': 1 },
            },
        });
        expect(orphanedKeyCount).toBe(0);
        expect(inspectorIdToProjectFile.get(42)).toBe('tests/x@@y/a.test.ts');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('counts the orphaned keys of two different "@@" directories as two files', () => {
        // One start, three keys: the keys of files 2 and 3 have no start. They are in two
        // different directories that share everything before the first "@@".
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  {
                'tests/x@@1/a.test.ts@@test-1': { '1': 1 },
                'tests/x@@2/a.test.ts@@test-1': { '2': 1 },
                'tests/x@@3/a.test.ts@@test-1': { '3': 1 },
            },
        };
        const testHierarchy = new Map<number, TestInfo>([testEntry(42, 'Suite > one', 'tests/x@@1/a.test.ts')]);
        const logger = makeLogger();

        const { orphanedKeyCount } = mapCoverageToInspectorIds(rawCoverage, [42], testHierarchy, logger);

        expect(orphanedKeyCount).toBe(2);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        const [format, orphaned, total, files] = logger.warn.mock.calls[0] as unknown as [string, number, number, number];
        expect(format).toContain('could not be paired with any inspector test');
        expect([orphaned, total, files]).toEqual([2, 3, 2]);
    });

    it('resolves keys by position within the file even when a directory is named like a counter', () => {
        const rawCoverage: MutantCoverage = {
            'static': {},
            perTest:  {
                'tests/a@@test-9/b.test.ts@@test-1': { '1': 1 },
                'tests/a@@test-9/b.test.ts@@test-2': { '2': 1 },
            },
        };
        const testHierarchy = new Map<number, TestInfo>([testEntry(1, 'first', 'tests/a@@test-9/b.test.ts'), testEntry(2, 'second', 'tests/a@@test-9/b.test.ts')]);

        const { coverage, orphanedKeyCount } = mapCoverageToInspectorIds(rawCoverage, [1, 2], testHierarchy, makeLogger());

        expect(coverage?.perTest).toEqual({
            'tests/a@@test-9/b.test.ts > first':  { '1': 1 },
            'tests/a@@test-9/b.test.ts > second': { '2': 1 },
        });
        expect(orphanedKeyCount).toBe(0);
    });
});
