/**
 * Testable logic extracted from coverage-preload.ts
 *
 * This file contains pure functions that can be tested independently
 * of the runtime environment. The actual preload script imports and
 * uses these functions.
 */

import { appendFileSync, closeSync, constants, openSync, writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { CoverageFileData, LateHitEntry } from './types.js';

// Re-exported so the coverage-preload template — which imports everything it
// needs from this module via the `__PRELOAD_LOGIC_PATH__` placeholder — can
// reference the type without a second relative import that wouldn't resolve
// correctly once the template is copied to its temp-dir location.
export type { LateHitEntry } from './types.js';

/**
 * The node:fs functions the preload calls, captured when this module loads,
 * which is before any test file runs.
 *
 * The preload runs inside the suite's own process, and test suites spy on
 * node:fs (`spyOn(fs, 'appendFileSync')`). Called through the live ESM import
 * binding, a spy a test leaves installed would swallow the coverage write in
 * the preload's final afterAll, with no error — the dry run would then find no
 * coverage file. Calls go through this object instead; this module's own
 * tests spy on it, not on node:fs.
 */
export const preloadFs = { appendFileSync, closeSync, openSync, writeSync };

/**
 * The `__stryker__` global shared with Stryker-instrumented code. Field names
 * are the instrumenter's (INSTRUMENTER_CONSTANTS in @stryker-mutator/api/core).
 */
export interface StrykerNamespace {
    mutantCoverage?: MutantCoverage
    currentTestId?:  string
    activeMutant?:   string
    /** Hits of the active mutant so far; the instrumenter only counts (and limits) while this is defined. */
    hitCount?:       number
    /** The instrumenter throws once {@link hitCount} exceeds this. */
    hitLimit?:       number
}

// ============================================================================
// Configuration
// ============================================================================

export interface PreloadConfig {
    syncPort?:      string
    /** The token the runner's sync server expects in the path, see {@link awaitRunnerReady}. */
    syncToken?:     string
    coverageFile?:  string
    activeMutant?:  string
    /** Stryker's hit limit for the active mutant (mutant runs only), see {@link installHitLimit}. */
    hitLimit?:      number
    /** This run's secret for signing the hit-limit sentinel, see {@link formatHitLimitSentinel}. */
    hitLimitToken?: string
}

/** Env var carrying the per-run token the hit-limit sentinel must include. */
export const HIT_LIMIT_TOKEN_ENV = '__STRYKER_HIT_LIMIT_TOKEN__';

/** Env var carrying the token the dry run's sync server expects in the path the child dials. */
export const SYNC_TOKEN_ENV = '__STRYKER_SYNC_TOKEN__';

export function getPreloadConfig(): PreloadConfig {
    return {
        syncPort:      process.env.__STRYKER_SYNC_PORT__,
        syncToken:     process.env[SYNC_TOKEN_ENV],
        coverageFile:  process.env.__STRYKER_COVERAGE_FILE__,
        activeMutant:  process.env.__STRYKER_ACTIVE_MUTANT__,
        hitLimit:      parseHitLimit(process.env.__STRYKER_HIT_LIMIT__),
        hitLimitToken: process.env[HIT_LIMIT_TOKEN_ENV],
    };
}

/**
 * Parse the `__STRYKER_HIT_LIMIT__` value. Stryker computes the limit as 100 ×
 * the mutant's dry-run hit count, so anything other than a positive integer
 * means no usable limit — and no limit is the safe reading: it can only cost
 * time, never misreport a mutant.
 */
export function parseHitLimit(raw: string | undefined): number | undefined {
    const limit = Number(raw);
    return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

export function shouldCollectCoverage(config: PreloadConfig): boolean {
    return !config.activeMutant && !!config.coverageFile;
}

// ============================================================================
// Dry-run sync: wait for the runner's 'ready'
// ============================================================================

/**
 * The part of the preload's sync WebSocket that {@link waitForSyncReady} uses
 * (bun's browser-style WebSocket).
 */
export interface SyncReadySocket {
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
    addEventListener(type: 'error', listener: () => void): void
    addEventListener(type: 'close', listener: (event: { code?: number, reason?: string }) => void): void
}

/** How {@link waitForSyncReady} ended: ready, or what went wrong before it. */
export type SyncReadyOutcome = { ready: true } | { ready: false, problem: string };

/**
 * Wait for the runner's 'ready' on the dry run's sync socket.
 *
 * The runner sends 'ready' only once its inspector is connected,
 * `TestReporter.enable` has been answered and its drain handler is
 * registered: from then on it observes every test event. A test that runs
 * before that is invisible to the runner, and its result and per-test coverage
 * are lost or paired with the wrong test. So this wait has no deadline of its
 * own: it ends with 'ready', or with the socket failing or closing first, which
 * the caller must treat as fatal. A runner that never gets ready is not left
 * waiting forever either: the runner bounds its inspector requests and kills
 * the child on failure, and its run timeout covers the child's whole life.
 *
 * Listeners are added synchronously, before the caller yields, so no message
 * can arrive unheard. They stay attached but change nothing once the promise
 * has settled.
 */
export function waitForSyncReady(socket: SyncReadySocket): Promise<SyncReadyOutcome> {
    return new Promise((resolve) => {
        socket.addEventListener('message', (event) => {
            if(event.data === 'ready') {
                resolve({ ready: true });
            }
        });
        socket.addEventListener('error', () => {
            resolve({ ready: false, problem: 'failed with a connection error' });
        });
        socket.addEventListener('close', (event) => {
            const reason = event.reason ? `, reason "${event.reason}"` : '';
            resolve({ ready: false, problem: `closed (code ${event.code ?? 'unknown'}${reason})` });
        });
    });
}

/**
 * The runner's sync server address. Dialled at the literal loopback address
 * the server binds (127.0.0.1), never "localhost", which may resolve to ::1.
 * The child dials it with its run's token appended (see {@link awaitRunnerReady});
 * messages name it without.
 */
function syncAddress(syncPort: string): string {
    return `ws://127.0.0.1:${syncPort}/sync`;
}

/** A sync socket {@link awaitRunnerReady} can wait on and close. */
export type RunnerReadySocket = SyncReadySocket & { close(): void };

/** Dependencies of {@link awaitRunnerReady}. */
export interface RunnerReadyDeps {
    /** The runner's sync port (`__STRYKER_SYNC_PORT__`). */
    syncPort:    string
    /** The runner's sync token (`__STRYKER_SYNC_TOKEN__`), the last segment of the path dialled. */
    syncToken:   string
    /** Keep the socket open after 'ready' (for the drain handshake) and return it; otherwise close it and return null. */
    keepOpen:    boolean
    /** Opens the socket. @default a WebSocket */
    openSocket?: (url: string) => RunnerReadySocket
    /** Ends this process with the message. @default print it on stderr and exit with code 1 */
    fail?:       (message: string) => never
}

/**
 * The whole of the dry-run preload's wait for 'ready': dial the runner's sync
 * server, wait with {@link waitForSyncReady} (no deadline), and end the process
 * through `fail` with {@link formatSyncNotReadyMessage} if the socket cannot be
 * opened, errors, or closes first. The template only calls this, so the
 * no-deadline rule lives in one tested place.
 */
export async function awaitRunnerReady(deps: RunnerReadyDeps): Promise<RunnerReadySocket | null> {
    const openSocket = deps.openSocket ?? ((url: string): RunnerReadySocket => new WebSocket(url));
    const fail = deps.fail ?? ((message: string): never => {
        // eslint-disable-next-line no-console -- the child's stderr is how this reaches the dry run's error
        console.error(message);
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- running the tests now would silently lose their results and coverage
        process.exit(1);
    });
    let socket: RunnerReadySocket;
    let outcome: SyncReadyOutcome;
    try {
        // The token keeps this child off another run's sync server: once this run's
        // server has closed, the OS can hand its port to a sync server of another
        // run, which would otherwise release this child with its own 'ready'.
        socket = openSocket(`${syncAddress(deps.syncPort)}/${deps.syncToken}`);
        // Listeners are added before this await yields, so no message can arrive unheard.
        outcome = await waitForSyncReady(socket);
    } catch (error) {
        // A WebSocket constructor's error quotes the URL it was given, token and all: the
        // message ends up on stderr and in the dry run's error, so the token is cut out.
        const reason = redactToken(error instanceof Error ? error.message : String(error), deps.syncToken);
        return fail(formatSyncNotReadyMessage(deps.syncPort, `could not be opened (${reason})`));
    }
    if(!outcome.ready) {
        return fail(formatSyncNotReadyMessage(deps.syncPort, outcome.problem));
    }
    if(deps.keepOpen) {
        return socket;
    }
    socket.close();
    return null;
}

/** `text` with every occurrence of the sync token replaced by `[redacted]`. */
function redactToken(text: string, token: string): string {
    return token === '' ? text : text.replaceAll(token, '[redacted]');
}

/**
 * The line the preload prints before exiting when {@link waitForSyncReady}
 * ends without 'ready'. It reaches the user inside the dry run's error, which
 * carries the child's stderr.
 */
export function formatSyncNotReadyMessage(syncPort: string, problem: string): string {
    return [
        `[Stryker] stryker-bun-runner: the dry run's sync connection to the runner (${syncAddress(syncPort)}) ${problem}`,
        'before the runner signalled that it is ready to observe the tests. Exiting without running any test: tests run now',
        'would not be seen by the runner\'s inspector, so their results and per-test coverage would be lost.',
    ].join(' ');
}

// ============================================================================
// Stryker Namespace Initialization
// ============================================================================

export function initializeStrykerNamespace(globalObj: Record<string, unknown>): StrykerNamespace {
    const g = globalObj as { __stryker__?: StrykerNamespace, __mutantCoverage__?: MutantCoverage };
    // Stryker disable next-line ObjectLiteral: structure verified by tests; line 61 fallback is only for existing __stryker__ without coverage
    g.__stryker__ ??= { mutantCoverage: { 'static': {}, perTest: {} } };
    const strykerGlobal = g.__stryker__;
    strykerGlobal.mutantCoverage ??= { 'static': {}, perTest: {} };
    g.__mutantCoverage__ = strykerGlobal.mutantCoverage;
    return strykerGlobal;
}

export function setActiveMutant(strykerNamespace: StrykerNamespace, activeMutant: string): void {
    strykerNamespace.activeMutant = activeMutant;
}

// ============================================================================
// Hit limit (Stryker's infinite-loop protection)
// ============================================================================

/**
 * Marker the preload writes on the child's stderr when the active mutant
 * exceeds its hit limit; the runner (bun-test-runner.ts) reads it back and
 * scores the mutant as a Timeout.
 */
export const HIT_LIMIT_SENTINEL = '__STRYKER_HIT_LIMIT_REACHED__';

/**
 * The stderr line reporting `hitCount`. It starts with a newline because bun
 * may have just written a partial line, and the runner only accepts the
 * sentinel at the start of a line.
 *
 * `token` is the random secret the runner generated for this run and passed in
 * {@link HIT_LIMIT_TOKEN_ENV}. The runner only accepts a sentinel carrying it, so
 * test output that happens to print a sentinel-shaped line cannot turn a
 * surviving mutant into a Timeout.
 */
export function formatHitLimitSentinel(token: string, hitCount: number): string {
    return `\n${HIT_LIMIT_SENTINEL} ${token} ${hitCount}\n`;
}

/**
 * Arm the instrumenter's hit limit for this (single-mutant) process.
 *
 * Instrumented code calls `stryMutAct_9fa48(id)` at every mutant switch; for
 * the active mutant it does `if (ns.hitCount !== void 0 && ++ns.hitCount >
 * ns.hitLimit) throw new Error('Stryker: Hit count limit reached (…)')`. So
 * setting `hitCount = 0` and `hitLimit` here is all it takes for a mutant that
 * loops forever to throw out of its loop within ~100 × its dry-run hits instead
 * of spinning until the runner's timeout.
 *
 * The thrown error alone is not enough for the runner: the test may catch it,
 * and a failing test would otherwise be scored Killed. So the runner also needs
 * the count, and it needs it even though, under `--bail`, bun exits on the
 * first failure without running afterAll hooks or process 'exit' handlers
 * (verified with bun 1.4.2). `hitCount` is therefore an accessor whose setter
 * reports the first hit past the limit synchronously, from inside the
 * instrumenter's own `++ns.hitCount`, before the error is even thrown.
 *
 * @param token - This run's sentinel token, see {@link formatHitLimitSentinel}.
 * @param report - Receives {@link formatHitLimitSentinel}'s line once; defaults
 *   to a synchronous write to fd 2, which nothing in bun buffers or drops.
 */
export function installHitLimit(
    strykerNamespace: StrykerNamespace,
    hitLimit: number,
    token: string,
    report: (line: string) => void = (line) => {
        // eslint-disable-next-line n/no-sync -- must reach stderr before bun's bail exit, which runs no async work
        preloadFs.writeSync(2, line);
    }
): void {
    let hitCount = 0;
    let reported = false;
    strykerNamespace.hitLimit = hitLimit;
    Object.defineProperty(strykerNamespace, 'hitCount', {
        configurable: true,
        enumerable:   true,
        get:          () => hitCount,
        set:          (value: number) => {
            hitCount = value;
            if(!reported && hitCount > hitLimit) {
                reported = true;
                report(formatHitLimitSentinel(token, hitCount));
            }
        },
    });
}

// ============================================================================
// Coverage Data Formatting
// ============================================================================

// Runtime coverage objects come from globalThis.__stryker__ and may have
// partially-initialised fields (perTest/static may be missing even though
// the MutantCoverage type declares them as required).  Widen the parameter
// type here so TypeScript treats the guards below as necessary.
interface PartialMutantCoverage {
    'static'?: MutantCoverage['static']
    perTest?:  MutantCoverage['perTest']
}

/**
 * Detect cross-test async coverage bleed within a single gap window (the span
 * between one test's afterEach and the next test's beforeEach).
 *
 * Compares the static bucket's per-key hit COUNTS at the start of the gap
 * (`staticCountsAtLastBoundary`, snapshotted in afterEach) against the counts
 * now (`staticCoverageNow`, read at the end of the gap). Any key whose count
 * increased — or that is newly present — proves code executed while no test
 * was active, i.e. after the previous test ended.
 *
 * Using count deltas rather than key presence is deliberate: a mutant that
 * already bled once (and so already exists in the snapshot) must still be
 * detected the next time it bleeds again.
 *
 * @param staticCountsAtLastBoundary - Static bucket counts snapshotted at the start of the gap window
 * @param staticCoverageNow - Current static bucket counts (`strykerGlobal.mutantCoverage.static`), or undefined
 * @returns Mutant ids whose static-bucket count increased during the gap window
 */
export function detectGapWindowBleed(
    staticCountsAtLastBoundary: Map<string, number>,
    staticCoverageNow: Record<string, number> | undefined
): string[] {
    if(!staticCoverageNow) {
        return [];
    }

    const bledIds: string[] = [];
    for(const [id, countNow] of Object.entries(staticCoverageNow)) {
        const countAtBoundary = staticCountsAtLastBoundary.get(id) ?? 0;
        if(countNow > countAtBoundary) {
            bledIds.push(id);
        }
    }
    return bledIds;
}

export function formatCoverageData(
    mutantCoverage: PartialMutantCoverage | undefined,
    counterToName: Map<string, string>,
    lateHits: LateHitEntry[] = []
): CoverageFileData {
    if(!mutantCoverage) {
        return { perTest: {}, 'static': {} };
    }

    // Hit counts are kept, not just the covered ids: Stryker sums them per mutant
    // to size each mutant run's hitLimit (100 × dry-run hits). Copied so later
    // hits cannot change what is written.
    const perTest: Record<string, Record<string, number>> = {};
    for(const [testId, coverage] of Object.entries(mutantCoverage.perTest ?? {})) {
        const actualName = counterToName.get(testId) ?? testId;
        perTest[actualName] = { ...coverage };
    }

    const staticCoverage = { ...mutantCoverage.static };

    return {
        perTest,
        'static': staticCoverage,
        // Copy so later mutation of the caller's accumulator array doesn't retroactively change already-written data.
        ...(lateHits.length > 0 ? { lateHits: [...lateHits] } : {}),
    };
}

// ============================================================================
// File Writing
// ============================================================================

/** Append (one line per test file of the run), creating if absent, and never through a symlink planted at the path (O_NOFOLLOW fails with ELOOP). */
// eslint-disable-next-line no-bitwise -- open(2) flags are a bitmask
const COVERAGE_APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/* eslint-disable n/no-sync -- sync required in afterAll hook to ensure write completes before process exit */
export function writeCoverageToFile(coverageFile: string, data: CoverageFileData): void {
    // mode applies only when the open creates the file: owner-only, like everything else in the runner's private temp dir.
    const fd = preloadFs.openSync(coverageFile, COVERAGE_APPEND_FLAGS, 0o600);
    try {
        preloadFs.appendFileSync(fd, `${JSON.stringify(data)}\n`, 'utf8');
    } finally {
        preloadFs.closeSync(fd);
    }
}
/* eslint-enable n/no-sync -- end of writeCoverageToFile */

// ============================================================================
// Orphan prevention: the parent lifeline
// ============================================================================

/**
 * Environment variable through which the runner tells a `bun test` child which
 * of its file descriptors is the parent lifeline: the read end of a pipe whose
 * other end only the spawning runner process holds.
 */
export const LIFELINE_FD_ENV = '__STRYKER_LIFELINE_FD__';

/** Dependencies of {@link watchParentLifeline}. */
export interface ParentLifelineDeps {
    /** The descriptor as the runner named it: `process.env[LIFELINE_FD_ENV]`. */
    fdValue:       string | undefined
    /** Called once the parent is gone. */
    onOrphaned:    () => void
    /**
     * Called, at most once, when the lifeline cannot tell this process anything
     * about its parent, with the reason.
     */
    onUnavailable: (reason: string) => void
    /** Opens the descriptor for reading. Defaults to an fs read stream on it. */
    open?:         (fd: number) => Readable
}

/** An error's code when it has one (EBADF, ENOTSUP), else its message. */
function describeError(error: unknown): string {
    const { code, message } = error as { code?: unknown, message?: unknown };
    return String(code ?? message);
}

/**
 * The lifeline descriptor named by `value`, or undefined when there is none.
 * Descriptors 0–2 are stdio, never a lifeline: stdin is /dev/null for a
 * runner child, and reading it would look like the parent dying at once.
 */
function parseLifelineFd(value: string | undefined): number | undefined {
    if(value === undefined || !/^\d+$/.test(value)) {
        return undefined;
    }
    const fd = Number(value);
    return Number.isSafeInteger(fd) && fd > 2 ? fd : undefined;
}

/**
 * SPIKE PROTOTYPE (from the warm-worker spike, spike-warm-worker.md): the
 * default lifeline reader. `fs.createReadStream` on the lifeline pipe costs
 * every `bun test` child about 18 ms before its first test (bun 1.4.2, a
 * trivial test file spawned like process-runner does: 29.3 ms with it, 11.6 ms
 * with this reader, 11.3 ms with no lifeline at all), more than a small mutant
 * run's own work; the benchmark fixture ran 28.7 s -> 22.8 s (median of 3).
 * `Bun.file(fd).stream()` still sees end-of-file the moment the parent's end
 * closes, with or without fake timers.
 * It is wrapped in the three members of a Readable that
 * {@link watchParentLifeline} uses. The reader is created here, so a descriptor
 * that cannot be opened throws inside `open` and is reported as unavailable.
 */
function openNativeLifeline(fd: number): Readable {
    // Through globalThis: the declaration bundle is compiled without bun's types.
    const { Bun: bun } = globalThis as unknown as { Bun: { file: (fd: number) => { stream: () => { getReader: () => { read: () => Promise<{ done: boolean }> } } } } };
    const reader = bun.file(fd).stream().getReader();
    const endListeners: (() => void)[] = [];
    const errorListeners: ((error: unknown) => void)[] = [];
    const pump = async (): Promise<void> => {
        for(;;) {
            // eslint-disable-next-line no-await-in-loop -- reads are sequential by nature
            const { done } = await reader.read();
            if(done) {
                for(const listener of endListeners) {
                    listener();
                }
                return;
            }
        }
    };
    const lifeline = {
        once(event: string, listener: () => void) {
            if(event === 'end') {
                endListeners.push(listener);
            }
            return lifeline;
        },
        on(event: string, listener: (error: unknown) => void) {
            if(event === 'error') {
                errorListeners.push(listener);
            }
            return lifeline;
        },
        resume() {
            pump().catch((error: unknown) => {
                for(const listener of errorListeners) {
                    listener(error);
                }
            });
            return lifeline;
        },
    };
    return lifeline as unknown as Readable;
}

/**
 * Calls `onOrphaned` when the process that spawned this one dies, so a
 * `bun test` child never outlives the Stryker worker that started it — even
 * when that worker is killed with SIGKILL, which gives it no chance to run any
 * cleanup of its own.
 *
 * The runner spawns each child with an extra pipe and holds the write end
 * without ever closing it. The kernel closes every descriptor of a process
 * that exits, however it exits, so end-of-file on the read end means the
 * parent is gone. This is an I/O event: no timer is involved. A timer-based
 * check (polling `process.ppid`) is lost to any suite that installs bun's fake
 * timers, because bun moves a real interval that ticks while fake timers are
 * installed into the fake-timer queue, where it never fires again on its own
 * (bun 1.4.2). Capturing the real timer functions does not avoid that: the
 * timer itself is moved. Reading also drains anything the parent writes.
 *
 * Only end-of-file counts. A descriptor that is not open (EBADF), or one this
 * platform cannot read this way, errors and closes without one, and says
 * nothing about the parent: that, an unusable `fdValue`, or an `open` that
 * throws is reported through `onUnavailable` instead, so the caller can watch
 * the parent some other way (see {@link guardAgainstOrphaning}).
 */
export function watchParentLifeline(deps: ParentLifelineDeps): void {
    let settled = false;
    const unavailable = (reason: string): void => {
        if(!settled) {
            settled = true;
            deps.onUnavailable(reason);
        }
    };
    const fd = parseLifelineFd(deps.fdValue);
    if(fd === undefined) {
        unavailable(`${LIFELINE_FD_ENV}=${deps.fdValue ?? '(unset)'} names no lifeline descriptor`);
        return;
    }
    const open = deps.open ?? openNativeLifeline;
    let lifeline: Readable;
    try {
        lifeline = open(fd);
    } catch (error) {
        unavailable(`opening fd ${fd} failed: ${describeError(error)}`);
        return;
    }
    lifeline.once('end', () => {
        settled = true;
        deps.onOrphaned();
    });
    lifeline.on('error', (error) => {
        unavailable(`reading fd ${fd} failed: ${describeError(error)}`);
    });
    lifeline.resume();
}

/**
 * Dependencies injected into {@link startOrphanWatchdog}, so the polling
 * logic is testable without real timers or a real process tree.
 */
export interface OrphanWatchdogDeps {
    /** Returns the current parent PID, e.g. `() => process.ppid`. */
    getPpid:       () => number
    /** Called (once) the first time a parent-PID change is observed. */
    onOrphaned:    () => void
    /** Poll interval in milliseconds. @default 1000 */
    intervalMs?:   number
    /**
     * The parent PID to compare against. @default the PID `getPpid` returns
     * when the watchdog starts, which is already wrong if the parent died first.
     */
    originalPpid?: number
}

/**
 * Detects that this process's original parent has died by polling
 * `process.ppid`: POSIX reparents an orphan to the nearest subreaper (commonly
 * PID 1) as soon as its parent exits. Only the fallback for a lifeline this
 * platform cannot provide (see {@link guardAgainstOrphaning}), because the
 * interval is lost to a suite that installs bun's fake timers (see
 * {@link watchParentLifeline}).
 *
 * @returns A function that stops the watchdog.
 */
export function startOrphanWatchdog(deps: OrphanWatchdogDeps): () => void {
    const originalPpid = deps.originalPpid ?? deps.getPpid();
    let fired = false;
    const intervalId = setInterval(() => {
        if(fired || deps.getPpid() === originalPpid) {
            return;
        }
        fired = true;
        deps.onOrphaned();
    }, deps.intervalMs ?? 1000);
    // Never let the watchdog itself keep the process alive once real work
    // (the test run) has otherwise finished.
    intervalId.unref();
    return () => {
        clearInterval(intervalId);
    };
}

/** Dependencies of {@link guardAgainstOrphaning}. */
export interface OrphanGuardDeps {
    /** The lifeline descriptor as the runner named it: `process.env[LIFELINE_FD_ENV]`. */
    fdValue:     string | undefined
    /** Returns the current parent PID, e.g. `() => process.ppid`. */
    getPpid:     () => number
    /** Called once the parent is gone. */
    onOrphaned:  () => void
    /** Receives the one line saying the lifeline was unavailable; see {@link orphanDebugLog}. */
    log?:        (message: string) => void
    /** Opens the lifeline descriptor; see {@link ParentLifelineDeps.open}. */
    open?:       (fd: number) => Readable
    /** Fallback watchdog poll interval in milliseconds. @default 1000 */
    intervalMs?: number
}

/**
 * Exits this process (through `onOrphaned`) when its parent dies: by the
 * timer-free lifeline when it works, and otherwise by the timer-based
 * {@link startOrphanWatchdog}, which still covers every suite that does not
 * use fake timers. The parent PID is read here, before the lifeline is even
 * opened, so a parent that dies before a late lifeline error is still noticed.
 */
export function guardAgainstOrphaning(deps: OrphanGuardDeps): void {
    const originalPpid = deps.getPpid();
    watchParentLifeline({
        fdValue:       deps.fdValue,
        onOrphaned:    deps.onOrphaned,
        open:          deps.open,
        onUnavailable: (reason) => {
            deps.log?.(`[Stryker] parent lifeline unavailable (${reason}); polling the parent PID on a timer instead`);
            startOrphanWatchdog({ getPpid: deps.getPpid, onOrphaned: deps.onOrphaned, intervalMs: deps.intervalMs, originalPpid });
        },
    });
}

/** Environment variable that turns on the child's orphan-prevention debug line. */
export const ORPHAN_DEBUG_ENV = 'STRYKER_BUN_RUNNER_DEBUG';

/**
 * A line logger for {@link guardAgainstOrphaning} when `value` (the
 * {@link ORPHAN_DEBUG_ENV} setting) turns debugging on, else undefined: a
 * fallback that still works is not worth a line in every child's output.
 */
export function orphanDebugLog(value: string | undefined, write: (text: string) => void): ((message: string) => void) | undefined {
    if(value === undefined || value === '' || value === '0' || value === 'false') {
        return undefined;
    }
    return (message) => {
        write(`${message}\n`);
    };
}
