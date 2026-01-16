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
    concurrency:      24,
    disableBail:      true,
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    tempDirName:      '.stryker-tmp',
    bun:              { bunPath: 'bun-25986' },
    ...(isCI && {
        dashboard: {
            project: 'hughescr/stryker-bun-runner',
            module:  'default',
            version: process.env.GITHUB_SHA,
        },
    }),
};
