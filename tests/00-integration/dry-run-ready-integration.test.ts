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
// events: the runner's results and the child's sync connection.
allowRealTimersFromSource();

/** The part of the 'ws' server and socket this file listens on. */
interface ObservableWss {
    on(event: 'connection', listener: (socket: { on(event: 'message', listener: (data: Buffer) => void): void }) => void): void
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

/**
 * Hold back the runner's first TestReporter.enable until `before` settles, and
 * hand each InspectorClient that sends anything to `onClient`.
 */
function interceptFirstEnable(before: () => Promise<void>, onClient: (client: InspectorClient) => void = () => {}): void {
    const originalSend = InspectorClient.prototype.send;
    let intercepted = false;
    spies.push(spyOn(InspectorClient.prototype, 'send').mockImplementation(async function(this: InspectorClient, ...args: Parameters<InspectorClient['send']>) {
        onClient(this);
        if(!intercepted && args[0] === 'TestReporter.enable') {
            intercepted = true;
            await before();
        }
        return originalSend.apply(this, args);
    }));
}

/** Hand every SyncServer the runner starts to `onStarted`, once it is listening. */
function observeSyncServers(onStarted: (server: SyncServer) => void): void {
    const originalStart = SyncServer.prototype.start;
    spies.push(spyOn(SyncServer.prototype, 'start').mockImplementation(async function(this: SyncServer) {
        await originalStart.call(this);
        onStarted(this);
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
            // The preload hides the sync token from the suite once it has dialled with it.
            "test('one', () => { if(process.env.__STRYKER_SYNC_TOKEN__ !== undefined) { throw new Error('the sync token is visible to tests'); } cover('1'); });",
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
        // The runner's real children go through the preload's shared mocks (spawn,
        // process-group kill), which record every call: leave them clean for the
        // files that run after this one.
        resetAllMocks();
        if(originalForceColor !== undefined) {
            process.env.FORCE_COLOR = originalForceColor;
        }
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        await fsPromises.rm(await resolveRunTempDir(), { recursive: true, force: true });
    });

    test('runs no test before ready, and collects every test with its own coverage, when TestReporter.enable is held until the child is waiting', async () => {
        // The child's preload connects to the sync server and then waits for 'ready'.
        // The runner's TestReporter.enable is held until that connection exists, so the
        // child is provably blocked on 'ready' while enable is outstanding. Nothing may
        // run before 'ready': no drain-request on the sync socket and no TestReporter
        // found/start event on the inspector. (That the preload's wait has no deadline
        // at all is pinned by waitForSyncReady's unit tests.)
        const order: string[] = [];
        let inspector: InspectorClient | undefined;
        let eventsAtReady: { found: number, start: number, end: number } | undefined;
        let markChildConnected: () => void = () => {};
        const childConnected = new Promise<void>((resolve) => {
            markChildConnected = resolve;
        });
        observeSyncServers((server) => {
            // 'wss' is private; listening on it adds a listener and changes nothing.
            (server as unknown as { wss: ObservableWss }).wss.on('connection', (socket) => {
                order.push('child connected');
                markChildConnected();
                socket.on('message', (data) => {
                    order.push(`child sent ${data.toString()}`);
                });
            });
        });
        const originalSignalReady = SyncServer.prototype.signalReady;
        spies.push(spyOn(SyncServer.prototype, 'signalReady').mockImplementation(function(this: SyncServer) {
            order.push('ready sent');
            eventsAtReady = inspector?.getEventCounts();
            originalSignalReady.call(this);
        }));
        interceptFirstEnable(async () => {
            order.push('enable held');
            await childConnected;
            order.push('enable released');
        }, (client) => {
            inspector = client;
        });
        const runner = createRunner();
        try {
            await runner.init();
            const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);

            expect(order.filter(entry => entry !== 'enable held')).toEqual(['child connected', 'enable released', 'ready sent', 'child sent drain-request']);
            expect(order.indexOf('enable held')).toBeLessThan(order.indexOf('enable released'));
            expect(eventsAtReady).toEqual({ found: 0, start: 0, end: 0 });
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
        observeSyncServers((server) => {
            syncServers.push(server);
        });
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

    test('names the preload\'s reason when the child is already gone by the time the runner enables TestReporter', async () => {
        // The ordering the test above leaves to chance: the child sees its sync channel
        // close and exits before the runner's TestReporter.enable reaches it, so the
        // enable fails for want of a connection. The dry run's error must still carry
        // the child's own account of why it exited, not just the connection failure.
        const syncServers: SyncServer[] = [];
        observeSyncServers((server) => {
            syncServers.push(server);
        });
        let inspector: InspectorClient | undefined;
        interceptFirstEnable(async () => {
            await Promise.all(syncServers.map(server => server.close()));
            // The child's exit closes the inspector socket; 30 s is only a backstop.
            await inspector?.waitForClose(30_000);
        }, (client) => {
            inspector = client;
        });
        const runner = createRunner();
        try {
            await runner.init();
            const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);

            expect(dryRun.status).toBe(DryRunStatus.Error);
            const errorMessage = dryRun.status === DryRunStatus.Error ? dryRun.errorMessage : '';
            expect(errorMessage).toStartWith('Failed to connect to Bun inspector: WebSocket not connected');
            expect(errorMessage).toContain(
                'before the runner signalled that it is ready to observe the tests. Exiting without running any test'
            );
        } finally {
            await runner.dispose();
        }
    }, 60_000);
});
