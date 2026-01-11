import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'bun',
  checkers: ['typescript'],
  plugins: [
    resolve(__dirname, 'dist/index.js'),
    '@stryker-mutator/typescript-checker',
  ],
  mutate: ['src/**/*.ts'],
  coverageAnalysis: 'perTest',
  concurrency: 24,
  reporters: ['progress', 'html', 'clear-text'],
  tempDirName: '.stryker-tmp',
  bun: {
    bunPath: 'bun',
  },
};
