/**
 * The dry-run completeness gate against real `bun test` children: a suite that
 * uses every legitimate source of a difference between bun's summary, the
 * inspector events and the coverage keys (retries, skipped and pending tests,
 * test.each/describe.each rows, duplicate titles, test.failing, test.concurrent,
 * tests defined in a helper module) completes with every test's coverage on that
 * test, and losing a single inspector event or a single coverage key fails the
 * dry run instead of completing it.
 */

import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, TestStatus, type DryRunResult } from '@stryker-mutator/api/test-runner';
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { InspectorClient } from '../../src/inspector/inspector-client.js';
import { resolveRunTempDir } from '../../src/utils/private-temp-dir.js';
import { allowRealTimersFromSource } from '../real-clock-guard.js';
import { resetAllMocks } from '../test-preload.js';

// Real bun children: the runner's own timers (inspector-URL timeout, drain-silence
// poll) have to run on real time here. The tests themselves wait on nothing but
// the runner's results.
allowRealTimersFromSource();

/** What Stryker's instrumenter does at a mutant switch: count a hit for the active test, or statically. */
const COVER_MODULE = `export function cover(id) {
    const ns = globalThis.__stryker__ ??= {};
    const coverage = ns.mutantCoverage ??= { static: {}, perTest: {} };
    const bucket = ns.currentTestId ? (coverage.perTest[ns.currentTestId] ??= {}) : coverage.static;
    bucket[id] = (bucket[id] ?? 0) + 1;
}
`;

const SUITE_FILE = [
    "import { describe, test } from 'bun:test';",
    "import { cover } from './cover.js';",
    "import { defineSharedTests } from './shared.js';",
    "test('plain', () => { cover('plain'); });",
    "test.skip('skipped', () => { cover('never'); });",
    "test.todo('later');",
    "test.if(false)('conditional', () => { cover('never'); });",
    "describe.skip('skipped block', () => { test('inner', () => { cover('never'); }); });",
    "test.each([1, 2])('row %d', (n) => { cover('row' + n); });",
    "describe.each(['x', 'y'])('block %s', (s) => { test('t', () => { cover('block' + s); }); });",
    "test.failing('expected to throw', () => { cover('failing'); throw new Error('expected'); });",
    'let attempts = 0;',
    "test('flaky', () => { attempts++; cover('attempt' + attempts); if(attempts < 3) { throw new Error('flaky'); } }, { retry: 2 });",
    "test('same title', () => { cover('dup0'); });",
    "test('same title', () => { cover('dup1'); });",
    "test.concurrent('concurrent', () => { cover('concurrent'); });",
    'defineSharedTests();',
].join('\n');

const SHARED_HELPER = [
    "import { test } from 'bun:test';",
    "import { cover } from './cover.js';",
    'export function defineSharedTests() {',
    "    test('shared one', () => { cover('shared1'); });",
    "    test('shared two', () => { cover('shared2'); });",
    '}',
].join('\n');

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

/** The params of the TestReporter.start/end events these tests drop (end events carry a status). */
interface TestEventParams {
    id:      number
    status?: string
}

/** The private InspectorClient event handlers these tests drop an event in front of. */
interface InspectorEventHandlers {
    handleTestStart(params: TestEventParams): void
    handleTestEnd(params: TestEventParams): void
}

describe('dry-run completeness gate (real bun children)', () => {
    let tempDir: string;
    let suiteFile: string;
    let originalForceColor: string | undefined;
    const spies: { mockRestore: () => void }[] = [];

    async function dryRun(testFiles: string[]): Promise<DryRunResult> {
        const runner = new BunTestRunner(silentLogger, {
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
        try {
            await runner.init();
            return await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);
        } finally {
            await runner.dispose();
        }
    }

    /** Make the inspector client swallow the first `method` event that `matches`. */
    function dropFirstEvent(method: keyof InspectorEventHandlers, matches: (params: TestEventParams, name: string | undefined) => boolean): void {
        const prototype = InspectorClient.prototype as unknown as InspectorEventHandlers;
        const original = prototype[method];
        let dropped = false;
        spies.push(spyOn(prototype, method).mockImplementation(function(this: InspectorEventHandlers, params: TestEventParams) {
            if(!dropped && matches(params, (this as unknown as InspectorClient).getTest(params.id)?.name)) {
                dropped = true;
                return;
            }
            original.call(this, params);
        }));
    }

    beforeAll(async () => {
        resetAllMocks();
        // See inspector-integration.test.ts: a set FORCE_COLOR breaks the inspector-URL scrape.
        originalForceColor = process.env.FORCE_COLOR;
        delete process.env.FORCE_COLOR;

        tempDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'dry-run-completeness-integration-'));
        await fsPromises.writeFile(path.join(tempDir, 'cover.js'), COVER_MODULE);
        await fsPromises.writeFile(path.join(tempDir, 'shared.js'), SHARED_HELPER);
        suiteFile = path.join(tempDir, 'suite.test.ts');
        await fsPromises.writeFile(suiteFile, SUITE_FILE);
    });

    afterEach(() => {
        for(const spy of spies.splice(0)) {
            spy.mockRestore();
        }
    });

    afterAll(async () => {
        if(originalForceColor !== undefined) {
            process.env.FORCE_COLOR = originalForceColor;
        }
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        await fsPromises.rm(await resolveRunTempDir(), { recursive: true, force: true });
    });

    test('completes a suite using every legitimate source of a count difference, with each test\'s coverage on that test', async () => {
        const result = await dryRun([suiteFile]);

        expect(result.status).toBe(DryRunStatus.Complete);
        if(result.status !== DryRunStatus.Complete) {
            return;
        }
        expect(result.tests.map(t => [t.id, t.status])).toEqual([
            ['suite.test.ts > block x > t', TestStatus.Success],
            ['suite.test.ts > block y > t', TestStatus.Success],
            ['suite.test.ts > concurrent', TestStatus.Success],
            ['suite.test.ts > expected to throw', TestStatus.Success],
            ['suite.test.ts > flaky', TestStatus.Success],
            ['suite.test.ts > plain', TestStatus.Success],
            ['suite.test.ts > row 1', TestStatus.Success],
            ['suite.test.ts > row 2', TestStatus.Success],
            ['suite.test.ts > same title [0]', TestStatus.Success],
            ['suite.test.ts > same title [1]', TestStatus.Success],
            ['suite.test.ts > shared one', TestStatus.Success],
            ['suite.test.ts > shared two', TestStatus.Success],
        ]);
        expect(result.mutantCoverage?.perTest).toEqual({
            'suite.test.ts > plain':             { plain: 1 },
            'suite.test.ts > row 1':             { row1: 1 },
            'suite.test.ts > row 2':             { row2: 1 },
            'suite.test.ts > block x > t':       { blockx: 1 },
            'suite.test.ts > block y > t':       { blocky: 1 },
            'suite.test.ts > expected to throw': { failing: 1 },
            'suite.test.ts > flaky':             { attempt1: 1, attempt2: 1, attempt3: 1 },
            'suite.test.ts > same title [0]':    { dup0: 1 },
            'suite.test.ts > same title [1]':    { dup1: 1 },
            'suite.test.ts > concurrent':        { concurrent: 1 },
            'suite.test.ts > shared one':        { shared1: 1 },
            'suite.test.ts > shared two':        { shared2: 1 },
        });
    }, 60_000);

    test('fails the dry run when a single TestReporter.start event is lost', async () => {
        // A test that runs once: bun's --randomize (from this repo's bunfig) may start any test first.
        dropFirstEvent('handleTestStart', (_params, name) => name === 'plain');

        const result = await dryRun([suiteFile]);

        expect(result.status).toBe(DryRunStatus.Error);
        const message = result.status === DryRunStatus.Error ? result.errorMessage : '';
        expect(message).toContain('1 test(s) reported a pass or fail result without a TestReporter.start event');
        expect(message).toContain('the coverage preload recorded 14 per-test coverage key(s), one per test run (retries included), but the Bun inspector reported 13 test start(s)');
    }, 60_000);

    test('fails the dry run when a single TestReporter.end event is lost', async () => {
        dropFirstEvent('handleTestEnd', params => params.status === 'skip');

        const result = await dryRun([suiteFile]);

        expect(result.status).toBe(DryRunStatus.Error);
        expect(result.status === DryRunStatus.Error ? result.errorMessage : '').toContain(
            'bun\'s summary counts 3 skipped test(s), but the Bun inspector reported 2'
        );
    }, 60_000);

    test('fails the dry run when a single coverage key belongs to no test the inspector saw', async () => {
        // Recorded the way the preload records a test's key, but for a test bun never started.
        const orphanFile = path.join(tempDir, 'orphan.test.ts');
        await fsPromises.writeFile(orphanFile, [
            "import { test } from 'bun:test';",
            "test('records a stray key', () => { globalThis.__stryker__.mutantCoverage.perTest['orphan.test.ts@@test-99'] = { stray: 1 }; });",
        ].join('\n'));

        const result = await dryRun([orphanFile]);

        expect(result).toEqual({
            status:       DryRunStatus.Error,
            errorMessage: expect.stringContaining(
                'stryker-bun-runner: dry run data-completeness check failed — the coverage preload recorded 2 per-test coverage key(s), '
                + 'one per test run (retries included), but the Bun inspector reported 1 test start(s): per-test coverage would be '
                + 'credited to the wrong tests; 1 of 2 per-test coverage key(s) matched no test the inspector reported, so their '
                + 'coverage would be dropped'
            ) as unknown as string,
        });
    }, 60_000);
});
