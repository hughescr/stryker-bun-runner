import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isCI = Boolean(process.env.GITHUB_SHA);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
    testRunner:  'bun',
    bun:         { timeout: 60_000 },
    checkers:    ['typescript'],
    incremental: !isCI,
    plugins:     [
        path.resolve(__dirname, 'dist/index.js'),
        '@stryker-mutator/typescript-checker',
    ],
    // src/templates/**/*.ts and src/coverage/preload-logic.ts are excluded because both
    // execute LIVE inside every spawned `bun test` child (as the coverage-preload script
    // and the pure-logic module it imports via __PRELOAD_LOGIC_PATH__ — see
    // src/templates/coverage-preload.ts). Instrumenting preload-logic.ts causes a
    // self-referential false positive: detectGapWindowBleed's own instrumented body
    // increments globalThis.__stryker__.mutantCoverage.static for ITS OWN mutant IDs as a
    // side effect of merely being called, and since it reads that same `static` object
    // (by reference, not a clone) as `staticCoverageNow`, every invocation observes its
    // own just-incremented counters as a "count increase" — deterministically flagging a
    // false coverage-bleed on every multi-test file, even a clean one with no real leak
    // (reproduced via `bun run mutate`; see tests/00-integration/inspector-integration.test.ts's
    // "reports no coverage-bleed lateHits for a clean two-test file" test history). Excluding
    // the file from instrumentation removes the self-reference entirely; it is still fully
    // covered by ordinary (non-mutation) unit tests in tests/unit/preload-logic.test.ts.
    mutate:           ['src/**/*.ts', '!src/templates/**/*.ts', '!src/coverage/preload-logic.ts'],
    ignorePatterns:   ['**', '!src/**/*.ts', '!tests/**/*.ts', '!bunfig.toml', '!tsconfig.json', '!*.mjs'], // Only include source and test files in the mutation testing process
    thresholds:       { high: 100, low: 100, 'break': 100 },
    coverageAnalysis: 'perTest',
    concurrency:      isCI ? 4 : 12,
    disableBail:      true,
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    tempDirName:      '.stryker-tmp',
};

export default config;
