const isCI = Boolean(process.env.GITHUB_SHA);

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    testRunner:  'bun',
    checkers:    ['typescript'],
    incremental: !isCI,
    plugins:     [
        resolve(__dirname, 'dist/index.js'),
        '@stryker-mutator/typescript-checker',
    ],
    mutate:           ['src/**/*.ts', '!src/templates/**/*.ts'],
    thresholds:       { high: 100, low: 100, 'break': 100 },
    coverageAnalysis: 'perTest',
    concurrency:      isCI ? 4 : 24,
    disableBail:      true,
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    tempDirName:      '.stryker-tmp',
};
