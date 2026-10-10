/**
 * Tests for tests/real-clock-guard.ts, the preload guard that fails any test
 * waiting on the real clock.
 *
 * To see the guard record a real wait, a test has to provoke one: those below
 * wait 1ms of real time each, the least a timer can, and then take the record
 * back with takeRealWaits() so the guard's afterEach does not fail them. They
 * cover no src code, so Stryker never reruns them for a mutant.
 */

import { describe, it, expect, jest, afterEach } from 'bun:test';
import { takeRealWaits } from '../real-clock-guard.js';

function realTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

describe('real-clock guard', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('records a real setTimeout with a delay that runs out, naming where it was scheduled', async () => {
        await realTimeout(1);

        const waits = takeRealWaits();
        expect(waits).toHaveLength(1);
        expect(waits[0].api).toBe('setTimeout');
        expect(waits[0].delayMs).toBe(1);
        expect(waits[0].site).toContain('real-clock-guard.test.ts');
    });

    it('records each run of a real setInterval', async () => {
        let ticks = 0;
        await new Promise<void>((resolve) => {
            const handle = setInterval(() => {
                ticks++;
                if(ticks === 2) {
                    clearInterval(handle);
                    resolve();
                }
            }, 1);
        });

        expect(takeRealWaits().map(wait => wait.api)).toEqual(['setInterval', 'setInterval']);
    });

    it('records a real Bun.sleep', async () => {
        await Bun.sleep(1);

        expect(takeRealWaits().map(wait => wait.api)).toEqual(['Bun.sleep']);
    });

    it('does not record a timer that is cleared before it runs out', () => {
        clearTimeout(setTimeout(() => undefined, 60_000));

        expect(takeRealWaits()).toEqual([]);
    });

    it('does not record a zero-delay timer, which is a yield, not a wait', async () => {
        await realTimeout(0);

        expect(takeRealWaits()).toEqual([]);
    });

    it('does not record timers run on the fake clock', async () => {
        jest.useFakeTimers();
        let slept = false;
        const sleep = Bun.sleep(5000).then(() => {
            slept = true;
            return undefined;
        });
        const timeout = realTimeout(5000);
        jest.advanceTimersByTime(5000);
        await Promise.all([sleep, timeout]);

        expect(slept).toBe(true);
        expect(takeRealWaits()).toEqual([]);
    });
});
