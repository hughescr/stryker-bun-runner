import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { trackTimers, type TrackedTimers } from '../helpers/fake-clock.js';

describe('trackTimers', () => {
    let timers: TrackedTimers | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        timers?.restore();
        timers = undefined;
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('counts a timeout as pending until it fires, and an interval until it is cleared', () => {
        timers = trackTimers();
        const fired: string[] = [];
        setTimeout(() => fired.push('timeout'), 100);
        const interval = setInterval(() => fired.push('interval'), 40);
        expect(timers.pending()).toBe(2);
        expect(timers.delays).toEqual([100, 40]);

        jest.advanceTimersByTime(100);
        expect(fired).toContain('timeout');
        expect(timers.pending()).toBe(1);

        clearInterval(interval);
        expect(timers.pending()).toBe(0);
    });

    it('counts a cleared timer as gone, whichever clear function cleared it', () => {
        timers = trackTimers();
        const callback = jest.fn();
        clearTimeout(setTimeout(callback, 10));
        clearInterval(setTimeout(callback, 20));
        clearTimeout(setInterval(callback, 30));
        expect(timers.pending()).toBe(0);

        jest.advanceTimersByTime(100);
        expect(callback).not.toHaveBeenCalled();
    });

    it('passes extra arguments through to the callback', () => {
        timers = trackTimers();
        const callback = jest.fn();
        setTimeout(callback, 5, 'a', 1);
        jest.advanceTimersByTime(5);
        expect(callback).toHaveBeenCalledWith('a', 1);
    });

    it('ignores timers armed before it started and after restore()', () => {
        setTimeout(() => undefined, 10);
        timers = trackTimers();
        timers.restore();
        setTimeout(() => undefined, 10);
        expect(timers.pending()).toBe(0);
        expect(timers.delays).toEqual([]);
    });
});
