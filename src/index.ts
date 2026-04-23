/**
 * Stryker Bun Test Runner Plugin
 * Entry point for plugin registration and schema export
 */

import { PluginKind, declareClassPlugin } from '@stryker-mutator/api/plugin';
import { BunTestRunner } from './bun-test-runner.js';

/**
 * Stryker plugin declarations
 */
// Stryker disable all: plugin exports array and identifier string required by Stryker
export const strykerPlugins = [
    declareClassPlugin(PluginKind.TestRunner, 'bun', BunTestRunner)
];
// Stryker restore all

/**
 * JSON Schema validation for plugin options
 */
// Stryker disable all: Schema definition - validated by Stryker's internal machinery
export const strykerValidationSchema = {
    $schema:    'http://json-schema.org/draft-07/schema#',
    properties: {
        bun: {
            title:       'BunTestRunnerOptions',
            description: 'Configuration options for the Bun test runner',
            type:        'object',
            properties:  {
                bunPath: {
                    type:        'string',
                    description: 'Path to the bun executable (default: "bun")',
                    'default':   'bun',
                },
                timeout: {
                    type:        'number',
                    minimum:     0,
                    description: 'Child-process timeout in milliseconds (default: 10000). Controls how long the entire bun test subprocess may run before being killed. Independent from the per-test timeout in bunfig.toml [test].timeout, which Bun uses to declare individual tests timed out.',
                    'default':   10_000,
                },
                inspectorTimeout: {
                    type:        'number',
                    minimum:     0,
                    description: 'Timeout for inspector connection in milliseconds (default: 5000)',
                    'default':   5000,
                },
                env: {
                    type:                 'object',
                    description:          'Additional environment variables to pass to bun test',
                    additionalProperties: {
                        type: 'string',
                    },
                },
                bunArgs: {
                    type:        'array',
                    description: 'Additional bun test flags',
                    items:       {
                        type: 'string',
                    },
                },
                testFiles: {
                    type:        'array',
                    description: 'Explicit list of test file paths (relative paths preferred in Stryker context — absolute paths bypass the sandbox copy and will NOT be mutated). When provided, skips auto-discovery and uses this list verbatim. Relative paths resolve against the bun subprocess\'s cwd. An empty array is invalid (use undefined/omit to enable auto-discovery).',
                    minItems:    1,
                    items:       {
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
