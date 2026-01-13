/**
 * Stryker Bun Test Runner Plugin
 * Entry point for plugin registration and schema export
 */

import { PluginKind, declareClassPlugin } from '@stryker-mutator/api/plugin';
import { BunTestRunner } from './bun-test-runner.js';

/**
 * Stryker plugin declarations
 */
export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, 'bun', BunTestRunner)
];

/**
 * JSON Schema validation for plugin options
 */
// Stryker disable all: Schema definition - validated by Stryker's internal machinery
export const strykerValidationSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  properties: {
    bun: {
      title: 'BunTestRunnerOptions',
      description: 'Configuration options for the Bun test runner',
      type: 'object',
      properties: {
        bunPath: {
          type: 'string',
          description: 'Path to the bun executable (default: "bun")',
          default: 'bun',
        },
        timeout: {
          type: 'number',
          minimum: 0,
          description: 'Timeout per test in milliseconds (default: 10000)',
          default: 10000,
        },
        inspectorTimeout: {
          type: 'number',
          minimum: 0,
          description: 'Timeout for inspector connection in milliseconds (default: 5000)',
          default: 5000,
        },
        env: {
          type: 'object',
          description: 'Additional environment variables to pass to bun test',
          additionalProperties: {
            type: 'string',
          },
        },
        bunArgs: {
          type: 'array',
          description: 'Additional bun test flags',
          items: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
    },
  },
};
// Stryker restore all

/**
 * Re-export public API
 */
export { BunTestRunner } from './bun-test-runner.js';
export * from './options.js';
