/**
 * Unit tests for src/utils/bun-args — rejection of `bun.bunArgs` flags that
 * break per-test coverage attribution or the runner's own test selection.
 */

import { describe, it, expect } from 'bun:test';
import { assertSupportedBunArgs, findUnsupportedBunArgs, REJECTED_BUN_FLAGS } from '../../src/utils/bun-args.js';

describe('findUnsupportedBunArgs', () => {
    describe('rejected long flags', () => {
        // Every long flag the runner cannot support, with the three spellings a
        // user might write: bare, `--flag=value`, and `--flag value`.
        const longFlags = [
            '--concurrent',
            '--max-concurrency',
            '--parallel',
            '--test-worker',
            '--shard',
            '--changed',
            '--test-name-pattern',
            '--update-snapshots',
            '--pass-with-no-tests',
            '--watch',
            '--coverage',
            '--coverage-reporter',
            '--coverage-dir',
            '--config',
            '--cwd',
            '--inspect',
            '--inspect-wait',
            '--inspect-brk',
        ];

        it.each(longFlags)('rejects bare %s', (flag) => {
            expect(findUnsupportedBunArgs([flag]).map(f => f.arg)).toEqual([flag]);
        });

        it.each(longFlags)('rejects %s=value', (flag) => {
            const arg = `${flag}=1`;
            expect(findUnsupportedBunArgs([arg]).map(f => f.arg)).toEqual([arg]);
        });

        it.each(longFlags)('rejects %s followed by a separate value token', (flag) => {
            expect(findUnsupportedBunArgs([flag, 'x']).map(f => f.arg)).toEqual([flag]);
        });

        it('covers exactly the documented set (no flag in the table without a test above)', () => {
            const tableLong = REJECTED_BUN_FLAGS.flatMap(r => r.flags).filter(f => f.startsWith('--')).toSorted((a, b) => a.localeCompare(b));
            expect(tableLong).toEqual([...longFlags].toSorted((a, b) => a.localeCompare(b)));
        });
    });

    describe('rejected short flags', () => {
        it.each([
            ['-t', '-t'],
            ['-t', '-t=foo'],
            ['-t', '-tfoo'],
            ['-u', '-u'],
            ['-c', '-c'],
            ['-c', '-c=bunfig.toml'],
            ['-c', '-cbunfig.toml'],
        ])('rejects %s written as %s', (_flag, arg) => {
            expect(findUnsupportedBunArgs([arg]).map(f => f.arg)).toEqual([arg]);
        });

        it('rejects -t followed by a separate pattern token and does not flag the pattern', () => {
            expect(findUnsupportedBunArgs(['-t', 'concurrent']).map(f => f.arg)).toEqual(['-t']);
        });
    });

    describe('accepted flags', () => {
        it.each([
            '--only',
            '--verbose',
            '--smol',
            '--timeout=20000',
            '--retry=2',
            '--rerun-each=2',
            '--randomize',
            '--seed=7',
            '--isolate',
            '--todo',
            '--hot',
            '--only-failures',
            '--dots',
            '--reporter=junit',
            '--reporter-outfile=out.xml',
            '--max-old-space-size=4096',
            '--preload=./setup.ts',
            '--env-file=.env',
            '--tsconfig-override=tsconfig.json',
            '--no-orphans',
            '--bail',
            '--bail=3',
        ])('accepts %s', (arg) => {
            expect(findUnsupportedBunArgs([arg])).toEqual([]);
        });

        it('does not treat flags that merely share a prefix as rejected', () => {
            // --concurrent-foo / --parallelism are not --concurrent / --parallel;
            // --coverage-threshold-ish names must not be swept up by prefix matching.
            expect(findUnsupportedBunArgs(['--concurrent-foo', '--parallelism=2', '--configure', '--cwdx', '--watcher'])).toEqual([]);
        });

        it('does not treat a value token that looks like a flag name as a flag unless it is one', () => {
            expect(findUnsupportedBunArgs(['--timeout', '5000', 'some/test/path.test.ts'])).toEqual([]);
        });

        it('accepts an empty list', () => {
            expect(findUnsupportedBunArgs([])).toEqual([]);
        });
    });

    it('gives every table entry a real reason and at least one flag', () => {
        for(const entry of REJECTED_BUN_FLAGS) {
            expect(entry.flags.length).toBeGreaterThan(0);
            expect(entry.reason.length).toBeGreaterThan(20);
        }
    });

    it('reports every offending token once, in order, with its reason', () => {
        const found = findUnsupportedBunArgs(['--only', '--concurrent', '-t', 'x', '--concurrent', '--max-concurrency=5']);
        expect(found.map(f => f.arg)).toEqual(['--concurrent', '-t', '--max-concurrency=5']);
        for(const f of found) {
            expect(f.reason.length).toBeGreaterThan(10);
        }
    });
});

/** Wraps the assertion in a thunk so `expect(...).toThrow()` can call it. */
function assertFn(args: readonly string[] | undefined): () => void {
    return () => {
        assertSupportedBunArgs(args);
    };
}

describe('assertSupportedBunArgs', () => {
    it('does nothing for undefined, empty, or safe args', () => {
        expect(assertFn(undefined)).not.toThrow();
        expect(assertFn([])).not.toThrow();
        expect(assertFn(['--only', '--smol'])).not.toThrow();
    });

    it('throws naming the flag and why, for a single offender', () => {
        expect(assertFn(['--concurrent'])).toThrow(
            'stryker-bun-runner: bun.bunArgs contains "--concurrent", which breaks per-test coverage attribution. Remove it.'
        );
    });

    it('throws naming every offender, each with its own reason, when there are several', () => {
        let message = '';
        try {
            assertSupportedBunArgs(['--only', '--shard=1/2', '-t', 'foo']);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toStartWith('stryker-bun-runner: bun.bunArgs contains unsupported flags: ');
        expect(message).toContain('"--shard=1/2" (');
        expect(message).toContain('"-t" (');
        expect(message).toContain('); "-t" (');
        expect(message).not.toContain('--only');
        expect(message).toEndWith('Remove them.');
    });

    it('uses a reason that fits the flag: test selection for -t', () => {
        expect(assertFn(['-t', 'x'])).toThrow(/"-t", which .*test selection/);
    });
});
