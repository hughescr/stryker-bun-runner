/**
 * stripRandomizeArgs: mutant runs keep bun's test order fixed, so the
 * `--randomize`/`--seed` flags a user put in bun.bunArgs (which still apply to
 * the dry run) are taken out of a mutant run's argv.
 */

import { describe, it, expect } from 'bun:test';
import { findUnsupportedBunArgs, stripRandomizeArgs } from '../../src/utils/bun-args.js';

describe('stripRandomizeArgs', () => {
    it('removes --randomize', () => {
        expect(stripRandomizeArgs(['--only', '--randomize', '--smol'])).toEqual(['--only', '--smol']);
    });

    it('removes --seed=<value>', () => {
        expect(stripRandomizeArgs(['--seed=42', '--only'])).toEqual(['--only']);
    });

    it('removes a bare --seed together with the token after it, which bun always reads as its value', () => {
        // bun 1.4.2: `--seed ./a.test.ts` fails with "Invalid seed value: ./a.test.ts".
        expect(stripRandomizeArgs(['--seed', '42', '--only'])).toEqual(['--only']);
        expect(stripRandomizeArgs(['--seed', '--only'])).toEqual([]);
    });

    it('removes a trailing bare --seed', () => {
        expect(stripRandomizeArgs(['--only', '--seed'])).toEqual(['--only']);
    });

    it('removes every occurrence', () => {
        expect(stripRandomizeArgs(['--randomize', '--seed=1', '--randomize', '--seed', '2', '-x'])).toEqual(['-x']);
    });

    it('leaves look-alikes and every other arg alone, in order', () => {
        const args = ['--randomize=yes', '--seedling', '-s', '--only', 'seed', '--seed-file'];

        expect(stripRandomizeArgs(args)).toEqual(args);
    });

    it('does not modify its input', () => {
        const args = ['--randomize', '--only'];

        stripRandomizeArgs(args);

        expect(args).toEqual(['--randomize', '--only']);
    });

    it('is not needed for an accepted flag: --randomize and --seed are still allowed in bunArgs', () => {
        expect(findUnsupportedBunArgs(['--randomize', '--seed=1', '--seed', '2'])).toEqual([]);
    });
});
