/**
 * Helpers for driving code under bun:test's fake timers.
 *
 * Tests never wait on the real clock (see tests/real-clock-guard.ts): they
 * install fake timers and move time forward explicitly. These helpers cover
 * the common shape of "start an async operation, then let fake time pass until
 * it finishes" without hand-tuned advance/flush loops.
 */

import { jest } from 'bun:test';

/**
 * One macrotask turn: every queued microtask, and any I/O callback that is
 * already ready, runs before this resolves. A yield, not a clock wait.
 */
export function nextMacrotask(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

/** Upper bound on fake-clock jumps, so a promise that can never settle fails fast. */
const MAX_JUMPS = 10_000;

/**
 * Drive `promise` to completion on the fake clock: let it run until it is
 * blocked on a timer, jump the clock to that timer, and repeat. Requires
 * `jest.useFakeTimers()`. Resolves with the promise's value and how much fake
 * time passed before it settled; rejects with the promise's rejection, or if it
 * never settles.
 */
export async function runUntilSettled<T>(promise: Promise<T>): Promise<{ value: T, fakeMs: number }> {
    if(!jest.isFakeTimers()) {
        throw new Error('runUntilSettled needs jest.useFakeTimers()');
    }
    // A rejection is rethrown by the await at the end; until then it is not unhandled.
    promise.catch(() => undefined);
    const startedAt = Date.now();
    // Let it run as far as it can before the clock first moves.
    await nextMacrotask();
    let jumps = 0;
    while(Bun.peek.status(promise) === 'pending') {
        if(jumps === MAX_JUMPS) {
            throw new Error(`runUntilSettled: still pending after ${MAX_JUMPS} fake-clock jumps`);
        }
        jumps++;
        jest.advanceTimersToNextTimer();
        // eslint-disable-next-line no-await-in-loop -- each turn must finish before the clock moves again
        await nextMacrotask();
    }
    const fakeMs = Date.now() - startedAt;
    return { value: await promise, fakeMs };
}

/** What {@link trackTimers} has seen since it started. */
export interface TrackedTimers {
    /** The delay of every setTimeout/setInterval armed while tracking, in order. */
    delays:  number[]
    /** How many of those timers are still armed: not cleared, and (for a timeout) not yet fired. */
    pending: () => number
    /** Stop tracking and put the global timer functions back. */
    restore: () => void
}

type TimerCallback = (...args: unknown[]) => void;

/**
 * Track the timers armed through the global timer functions from now until
 * `restore()`, so a test can check that the code under test cleared every
 * timer it armed.
 *
 * Use this instead of `jest.getTimerCount()`, which counts every timer in the
 * fake queue, including ones this test never armed. bun moves a REAL interval
 * into the fake queue when it ticks while fake timers are installed (seen on
 * bun 1.4.2), and under Stryker the runner's coverage preload runs a real 1s
 * orphan-watchdog interval in every `bun test` child. Whenever a fake-timer
 * test hands control back to the event loop (runUntilSettled's macrotask
 * turns, or `expect(pendingPromise).rejects`, which runs the loop until the
 * promise settles) at the moment that watchdog is due, the count is one higher
 * than the code under test can explain. Plain `bun test` has no such interval,
 * so a getTimerCount() assertion passes there and fails at random in a
 * Stryker dry run.
 */
export function trackTimers(): TrackedTimers {
    const delays: number[] = [];
    const armed = new Set<unknown>();
    const { setTimeout: realSetTimeout, setInterval: realSetInterval, clearTimeout: realClearTimeout, clearInterval: realClearInterval } = globalThis;

    globalThis.setTimeout = ((callback: TimerCallback, delay?: number, ...args: unknown[]) => {
        delays.push(delay ?? 0);
        const handle = realSetTimeout((...callArgs: unknown[]) => {
            armed.delete(handle);
            callback(...callArgs);
        }, delay, ...args);
        armed.add(handle);
        return handle;
    }) as typeof setTimeout;
    globalThis.setInterval = ((callback: TimerCallback, delay?: number, ...args: unknown[]) => {
        delays.push(delay ?? 0);
        const handle = realSetInterval(callback, delay, ...args);
        armed.add(handle);
        return handle;
    }) as typeof setInterval;
    // Either clear function cancels either kind of timer.
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
        armed.delete(handle);
        realClearTimeout(handle);
    }) as typeof clearTimeout;
    globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
        armed.delete(handle);
        realClearInterval(handle);
    }) as typeof clearInterval;

    return {
        delays,
        pending: () => armed.size,
        restore: () => {
            Object.assign(globalThis, { setTimeout: realSetTimeout, setInterval: realSetInterval, clearTimeout: realClearTimeout, clearInterval: realClearInterval });
        },
    };
}
