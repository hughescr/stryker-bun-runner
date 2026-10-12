// Benchmark fixture config: run with cwd bench/fixture via the root repo's Stryker,
// e.g. `../../node_modules/.bin/stryker run`. Build the plugin first (`bun run build` at the root),
// or point BENCH_PLUGIN at another build of it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    testRunner:       'bun',
    plugins:          [process.env.BENCH_PLUGIN ?? path.resolve(__dirname, '../../dist/index.js')],
    concurrency:      4,
    coverageAnalysis: 'perTest',
    checkers:         [],
    incremental:      false,
    reporters:        ['json'],
    // Library source only. Excluded: tests; src/index.ts (re-exports only); src/internal/types/**
    // (type-only, as upstream's coverage config); src/debounce.ts and src/funnel.ts (their tests use
    // real timers and are not vendored); src/randomBigInt.ts (its test is not vendored: too slow
    // when instrumented, and its mutants hit wall-clock timeouts); and six files with hit-limit
    // Timeout mutants covered by more than one test file (or static), whose status flapped
    // between Killed and Timeout across runs; and the four other sources that call Math.random,
    // whose mutants' statuses depend on the random draws. See UPSTREAM.md.
    mutate:           [
        'src/**/*.ts',
        '!src/**/*.test.ts',
        '!src/index.ts',
        '!src/internal/types/**',
        '!src/debounce.ts',
        '!src/funnel.ts',
        '!src/randomBigInt.ts',
        '!src/internal/binarySearchCutoffIndex.ts',
        '!src/internal/heap.ts',
        '!src/isDeepEqual.ts',
        '!src/pipe.ts',
        '!src/stringToPath.ts',
        '!src/times.ts',
        '!src/randomInteger.ts',
        '!src/randomString.ts',
        '!src/sample.ts',
        '!src/shuffle.ts',
    ],
};
