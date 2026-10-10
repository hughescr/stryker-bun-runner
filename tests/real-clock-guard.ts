/**
 * Fail any test that waits on the real clock.
 *
 * Policy: no test may wait on wall-clock time. Stryker reruns the covering
 * tests of every mutant, so even a few milliseconds of real waiting in one test
 * is paid thousands of times over a mutation run. Unit tests drive every timer
 * with bun:test's fake timers (`jest.useFakeTimers()` and
 * `jest.advanceTimersByTime()`); tests that work with real OS processes wait on
 * events (exit, close, a line of output), never on a timer.
 *
 * Installed by tests/test-preload.ts, so it is active in every `bun test` run,
 * mutant runs included. It wraps the global timer APIs and records every REAL
 * timer with a delay above zero that actually fires (or a real `Bun.sleep` that
 * resolves, or any `Bun.sleepSync`), then fails the test from a global
 * `afterEach`.
 *
 * - "Real" means scheduled while fake timers were NOT installed. bun's fake
 *   timers work natively underneath these same globals, so a timer scheduled
 *   under `jest.useFakeTimers()` only fires when the test advances the fake
 *   clock, costs no wall time, and is not recorded.
 * - "Fires" rather than "is scheduled": source code legitimately arms timeouts
 *   that a passing test never reaches (a kill timer cleared on exit, a request
 *   timeout cleared on reply). Only a timer that ran out means some test spent
 *   that long waiting for it.
 * - A zero delay (`setTimeout(fn)`, `setTimeout(fn, 0)`) is a macrotask yield,
 *   not a clock wait, and is allowed.
 * - Timers armed before the first test file starts (by preloads) are
 *   background machinery, not something a test waits on, and are ignored.
 *
 * In an ordinary test file every real timer counts, wherever it was scheduled:
 * a unit test that lets the code under test sleep for real (an inspector poll,
 * a retry backoff) is waiting just as much as one that calls setTimeout itself.
 * A file whose tests drive genuine OS processes, where the code under test has
 * to run on real time, opts out of that with {@link allowRealTimersFromSource}.
 * Timers scheduled directly from test code (anything under tests/) still fail
 * there: such a test must wait on an event, not a delay.
 *
 * The node:timers modules hand out the unwrapped natives; tests may not import
 * them (enforced by ESLint in eslint.config.mjs), so these globals are the only
 * way a test can reach a timer.
 */

import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, jest } from 'bun:test';

interface RealWait {
    api:     string
    delayMs: number
    site:    string
}

const realWaits: RealWait[] = [];
let sourceTimersAllowed = false;

/**
 * Off until the first test file starts. Timers armed while preloads load are
 * background machinery no test waits on: under Stryker, the runner's coverage
 * preload starts a 1s orphan watchdog interval in every `bun test` child.
 */
let armed = false;
const arm = (): void => {
    armed = true;
};
beforeAll(arm);
beforeEach(arm);

const THIS_FILE = import.meta.path;

/**
 * The first stack frame outside this file, i.e. the code that asked for the
 * timer: '' when it could not be determined.
 */
function schedulingSite(): string {
    // eslint-disable-next-line unicorn/error-message -- never thrown; only its stack is read
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    return frames.find(frame => !frame.includes(THIS_FILE))?.trim() ?? '';
}

/** This file lives at the root of tests/. */
const TESTS_DIR = `${import.meta.dir}${path.sep}`;

/** Whether a site lies in test code (tests/**). */
function isTestCode(site: string): boolean {
    return site.includes(TESTS_DIR);
}

/**
 * The site to blame if this real wait completes, or undefined when it is
 * allowed to complete.
 */
function blameFor(delayMs: number): string | undefined {
    // NaN (a non-numeric delay) counts as 0, as it does for the timer itself.
    if(!armed || Number.isNaN(delayMs) || delayMs <= 0 || jest.isFakeTimers()) {
        return undefined;
    }
    const site = schedulingSite();
    return sourceTimersAllowed && !isTestCode(site) ? undefined : site;
}

function delayOf(value: unknown): number {
    if(value instanceof Date) {
        return value.getTime() - Date.now();
    }
    return Number(value ?? 0);
}

function record(api: string, delayMs: number, site: string): void {
    realWaits.push({ api, delayMs, site });
}

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeSleep = Bun.sleep;
// eslint-disable-next-line no-restricted-properties -- the guard itself: captures the native to wrap it
const nativeSleepSync = Bun.sleepSync;

type TimerHandler = (...args: unknown[]) => void;

function wrapTimer(api: 'setTimeout' | 'setInterval', native: typeof setTimeout | typeof setInterval): typeof setTimeout {
    const guarded = (handler: unknown, timeout?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
        const delayMs = delayOf(timeout);
        const site = typeof handler === 'function' ? blameFor(delayMs) : undefined;
        if(site === undefined) {
            return (native as (...a: unknown[]) => ReturnType<typeof setTimeout>)(handler, timeout, ...args);
        }
        const fn = handler as TimerHandler;
        return (native as (...a: unknown[]) => ReturnType<typeof setTimeout>)(function(this: unknown, ...callArgs: unknown[]) {
            record(api, delayMs, site);
            fn.apply(this, callArgs);
        }, timeout, ...args);
    };
    return guarded as unknown as typeof setTimeout;
}

globalThis.setTimeout = wrapTimer('setTimeout', nativeSetTimeout);
globalThis.setInterval = wrapTimer('setInterval', nativeSetInterval);

Bun.sleep = async (ms: number | Date): Promise<void> => {
    const delayMs = delayOf(ms);
    const site = blameFor(delayMs);
    await nativeSleep(ms);
    if(site !== undefined) {
        record('Bun.sleep', delayMs, site);
    }
};

// eslint-disable-next-line no-restricted-properties -- the guard itself: replaces the native with the recording wrapper
Bun.sleepSync = (ms: number): void => {
    // Blocks the thread whatever the timer mode: always a real wait.
    if(delayOf(ms) > 0) {
        record('Bun.sleepSync', delayOf(ms), schedulingSite());
    }
    // eslint-disable-next-line n/no-sync -- the guard itself: performs the wait it just recorded
    nativeSleepSync(ms);
};

function failOnRealWaits(): void {
    if(realWaits.length === 0) {
        return;
    }
    const found = realWaits.splice(0);
    const lines = found.map(({ api, delayMs, site }) => `  - real ${api} of ${delayMs}ms, scheduled ${site || '(unknown site)'}`);
    throw new Error([
        `This test waited on the real clock (${found.length} real timer${found.length === 1 ? '' : 's'} ran out):`,
        ...lines,
        'Drive time with jest.useFakeTimers() and jest.advanceTimersByTime(), or wait on an event (exit, close, output) instead.',
        'See tests/real-clock-guard.ts.',
    ].join('\n'));
}

afterEach(failOnRealWaits);
afterAll(failOnRealWaits);

/**
 * For the guard's own tests only: hand over, and forget, the real waits
 * recorded so far, so the afterEach does not fail a test that provoked one on
 * purpose.
 */
export function takeRealWaits(): RealWait[] {
    return realWaits.splice(0);
}

/**
 * For a test file whose tests drive genuine OS processes (tests/00-integration
 * and the like): let timers scheduled by the code under test run on real time,
 * since a real child process cannot be driven by a fake clock. Timers scheduled
 * from test code still fail the test. Call once, at the top level of the file;
 * it applies to that file only.
 */
export function allowRealTimersFromSource(): void {
    beforeAll(() => {
        sourceTimersAllowed = true;
    });
    afterAll(() => {
        sourceTimersAllowed = false;
    });
}
