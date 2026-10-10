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
