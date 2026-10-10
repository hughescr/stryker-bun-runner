/**
 * The dry run's 'ready' handshake through real `bun test` children: the
 * coverage preload must not start a single test before the runner can observe
 * it (inspector connected, TestReporter enabled, drain handler registered), and
 * must fail the dry run loudly when that can never happen.
 */

import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus } from '@stryker-mutator/api/test-runner';
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { InspectorClient } from '../../src/inspector/inspector-client.js';
import { resolveRunTempDir } from '../../src/utils/private-temp-dir.js';
import { SyncServer } from '../../src/utils/sync-server.js';
import { allowRealTimersFromSource } from '../real-clock-guard.js';
import { resetAllMocks } from '../test-preload.js';

// Real bun children: the runner's own timers (inspector-URL timeout, drain-silence
// poll) have to run on real time here. The tests themselves wait on nothing but
// events: the runner's results and a helper process's exit.
allowRealTimersFromSource();

/**
 * How long the first TestReporter.enable is held back. The preload used to give
 * up waiting for 'ready' after a fixed 2000 ms and run the tests anyway, unseen by
 * the runner; this hold outlasts that window. The wait happens in a separate bun
 * process, not in this one: the test only waits for that process to exit.
 */
const ENABLE_HOLD_MS = 2500;

/** Stands in for a loaded machine on which the runner's enable round trip is late. */
async function slowMachineDelay(): Promise<void> {
    const helper = Bun.spawn([process.execPath, '--eval', `setTimeout(() => {}, ${ENABLE_HOLD_MS})`], { stdout: 'ignore', stderr: 'ignore' });
    await helper.exited;
}

/** What Stryker's instrumenter does at a mutant switch: count a hit for the active test, or statically. */
const COVER_MODULE = `export function cover(id) {
    const ns = globalThis.__stryker__ ??= {};
    const coverage = ns.mutantCoverage ??= { static: {}, perTest: {} };
    const bucket = ns.currentTestId ? (coverage.perTest[ns.currentTestId] ??= {}) : coverage.static;
    bucket[id] = (bucket[id] ?? 0) + 1;
}
`;

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

/** Spies installed by the current test; restored after each test. */
const spies: { mockRestore: () => void }[] = [];

/** Hold back the runner's first TestReporter.enable until `before` settles. */
function interceptFirstEnable(before: () => Promise<void>): void {
    const originalSend = InspectorClient.prototype.send;
    let intercepted = false;
    spies.push(spyOn(InspectorClient.prototype, 'send').mockImplementation(async function(this: InspectorClient, ...args: Parameters<InspectorClient['send']>) {
        if(!intercepted && args[0] === 'TestReporter.enable') {
            intercepted = true;
            await before();
        }
        return originalSend.apply(this, args);
    }));
}

describe('dry-run ready handshake (real bun children)', () => {
    let tempDir: string;
    let firstFile: string;
    let secondFile: string;
    let originalForceColor: string | undefined;

    function createRunner(): BunTestRunner {
        return new BunTestRunner(silentLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                maxSpawnDepth:    2, // under Stryker this suite is itself a depth-1 run
                testFiles:        [firstFile, secondFile],
            },
            coverageAnalysis: 'perTest',
            testRunner:       { name: 'bun' },
        } as unknown as StrykerOptions);
    }

    beforeAll(async () => {
        resetAllMocks();
        // See inspector-integration.test.ts: a set FORCE_COLOR breaks the inspector-URL scrape.
        originalForceColor = process.env.FORCE_COLOR;
        delete process.env.FORCE_COLOR;

        tempDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'dry-run-ready-integration-'));
        await fsPromises.writeFile(path.join(tempDir, 'cover.js'), COVER_MODULE);
        firstFile = path.join(tempDir, 'first.test.ts');
        await fsPromises.writeFile(firstFile, [
            "import { test } from 'bun:test';",
            "import { cover } from './cover.js';",
            "test('one', () => { cover('1'); });",
            "test('two', () => { cover('2'); });",
            "test('three', () => { cover('3'); });",
        ].join('\n'));
        secondFile = path.join(tempDir, 'second.test.ts');
        await fsPromises.writeFile(secondFile, [
            "import { test } from 'bun:test';",
            "import { cover } from './cover.js';",
            "test('four', () => { cover('4'); });",
            "test('five', () => { cover('5'); });",
        ].join('\n'));
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

    test('collects every test with its own coverage when TestReporter.enable answers late', async () => {
        // Before the fix the preload ran the tests after 2 s without 'ready': the runner's
        // inspector saw none of them, and the dry run still completed, with tests missing
        // and coverage dropped or paired with the wrong test.
        interceptFirstEnable(slowMachineDelay);
        const runner = createRunner();
        try {
            await runner.init();
            const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);

            expect(dryRun.status).toBe(DryRunStatus.Complete);
            if(dryRun.status !== DryRunStatus.Complete) {
                return;
            }
            const coverageByTest = Object.fromEntries(dryRun.tests.map(t => [t.id, dryRun.mutantCoverage?.perTest[t.id]]));
            expect(coverageByTest).toEqual({
                'first.test.ts > one':   { '1': 1 },
                'first.test.ts > two':   { '2': 1 },
                'first.test.ts > three': { '3': 1 },
                'second.test.ts > four': { '4': 1 },
                'second.test.ts > five': { '5': 1 },
            });
        } finally {
            await runner.dispose();
        }
    }, 60_000);

    test('fails the dry run loudly, without running a test, when the sync channel goes away before ready', async () => {
        // Before the fix the preload shrugged off a dead sync channel and ran the
        // tests anyway, after its 2 s timer, whether or not the runner could see them.
        const syncServers: SyncServer[] = [];
        const originalStart = SyncServer.prototype.start;
        spies.push(spyOn(SyncServer.prototype, 'start').mockImplementation(function(this: SyncServer) {
            syncServers.push(this);
            return originalStart.call(this);
        }));
        interceptFirstEnable(async () => {
            await Promise.all(syncServers.map(server => server.close()));
        });
        const runner = createRunner();
        try {
            await runner.init();
            const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);

            expect(dryRun.status).toBe(DryRunStatus.Error);
            expect(dryRun.status === DryRunStatus.Error ? dryRun.errorMessage : '').toContain(
                'before the runner signalled that it is ready to observe the tests. Exiting without running any test'
            );
        } finally {
            await runner.dispose();
        }
    }, 60_000);
});
