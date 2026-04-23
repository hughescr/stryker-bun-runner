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
    mutate:           ['src/**/*.ts', '!src/templates/**/*.ts'],
    ignorePatterns:   ['**', '!src/**/*.ts', '!tests/**/*.ts', '!bunfig.toml', '!tsconfig.json', '!*.mjs'], // Only include source and test files in the mutation testing process
    thresholds:       { high: 100, low: 100, 'break': 100 },
    coverageAnalysis: 'perTest',
    concurrency:      isCI ? 4 : 12,
    disableBail:      true,
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    tempDirName:      '.stryker-tmp',
};

export default config;
