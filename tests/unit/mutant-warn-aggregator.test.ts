/**
 * Unit tests for MutantWarnAggregator: the first occurrence of each kind of per-mutant
 * warning is logged at warn with full detail, later ones at debug, and flush() emits
 * one summary warn per kind that affected more than one mutant.
 */

import { format } from 'node:util';
import type { Logger } from '@stryker-mutator/api/logging';
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MutantWarnAggregator } from '../../src/utils/mutant-warn-aggregator.js';

function makeLogger(): Logger {
    return {
        debug:          mock(),
        info:           mock(),
        warn:           mock(),
        error:          mock(),
        trace:          mock(),
        fatal:          mock(),
        isTraceEnabled: mock().mockReturnValue(false),
        isDebugEnabled: mock().mockReturnValue(true),
        isInfoEnabled:  mock().mockReturnValue(true),
        isWarnEnabled:  mock().mockReturnValue(true),
        isErrorEnabled: mock().mockReturnValue(true),
        isFatalEnabled: mock().mockReturnValue(true),
    };
}

/** The lines a logger method received, rendered the way a real logger formats them. */
function lines(method: unknown): string[] {
    return (method as ReturnType<typeof mock>).mock.calls.map(args => format(...(args as [string, ...unknown[]])));
}

describe('MutantWarnAggregator', () => {
    let logger:     Logger;
    let aggregator: MutantWarnAggregator;

    beforeEach(() => {
        logger = makeLogger();
        aggregator = new MutantWarnAggregator(logger);
    });

    it('logs the first occurrence of a kind at warn with the given format and arguments, and nothing at debug', () => {
        aggregator.warn('kind A', '1', 'Mutant %s: %d things', '1', 3);

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('Mutant %s: %d things', '1', 3);
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it('logs later occurrences of the same kind at debug, with the same format and arguments', () => {
        aggregator.warn('kind A', '1', 'Mutant %s: %d things', '1', 3);
        aggregator.warn('kind A', '2', 'Mutant %s: %d things', '2', 4);

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith('Mutant %s: %d things', '2', 4);
    });

    it('treats every kind independently: the first occurrence of each kind is a warn', () => {
        aggregator.warn('kind A', '1', 'a %s', '1');
        aggregator.warn('kind B', '1', 'b %s', '1');
        aggregator.warn('kind B', '2', 'b %s', '2');

        expect(lines(logger.warn)).toEqual(['a 1', 'b 1']);
        expect(lines(logger.debug)).toEqual(['b 2']);
    });

    it('logs nothing on its own for a kind that occurred once', () => {
        aggregator.warn('kind A', '1', 'a %s', '1');
        logger.warn = mock();

        aggregator.flush();

        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not count the same mutant twice: a kind that repeats for one mutant is not summarized', () => {
        aggregator.warn('kind A', '7', 'a %s', '7');
        aggregator.warn('kind A', '7', 'a %s', '7');
        logger.warn = mock();

        aggregator.flush();

        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('still logs a repeat for the same mutant at debug', () => {
        aggregator.warn('kind A', '7', 'a %s', '7');
        aggregator.warn('kind A', '7', 'a %s again', '7');

        expect(lines(logger.debug)).toEqual(['a 7 again']);
    });

    it('flush() emits one summary warn per kind that affected more than one mutant, in first-seen order', () => {
        aggregator.warn('kind A', '1', 'a');
        aggregator.warn('kind B', '2', 'b');
        aggregator.warn('kind A', '3', 'a');
        aggregator.warn('kind B', '4', 'b');
        aggregator.warn('kind C', '5', 'c');
        logger.warn = mock();

        aggregator.flush();

        expect(lines(logger.warn)).toEqual([
            'kind A: 2 mutants affected (first: 1, 3); see debug log for details',
            'kind B: 2 mutants affected (first: 2, 4); see debug log for details',
        ]);
    });

    it('lists all ids, without an ellipsis, when exactly 5 mutants were affected', () => {
        for(const id of ['1', '2', '3', '4', '5']) {
            aggregator.warn('kind A', id, 'a');
        }
        logger.warn = mock();

        aggregator.flush();

        expect(lines(logger.warn)).toEqual(['kind A: 5 mutants affected (first: 1, 2, 3, 4, 5); see debug log for details']);
    });

    it('lists only the first 5 ids, followed by an ellipsis, when more mutants were affected', () => {
        for(const id of ['1', '2', '3', '4', '5', '6', '7']) {
            aggregator.warn('kind A', id, 'a');
        }
        logger.warn = mock();

        aggregator.flush();

        expect(lines(logger.warn)).toEqual(['kind A: 7 mutants affected (first: 1, 2, 3, 4, 5, …); see debug log for details']);
    });

    it('flush() is idempotent: a second flush emits nothing', () => {
        aggregator.warn('kind A', '1', 'a');
        aggregator.warn('kind A', '2', 'a');
        aggregator.flush();
        logger.warn = mock();

        aggregator.flush();

        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('starts counting afresh after a flush: the next occurrence of a flushed kind is a warn again', () => {
        aggregator.warn('kind A', '1', 'a');
        aggregator.flush();
        logger.warn = mock();

        aggregator.warn('kind A', '2', 'a');

        expect(lines(logger.warn)).toEqual(['a']);
    });
});
