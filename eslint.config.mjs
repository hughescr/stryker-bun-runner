import config from '@hughescr/eslint-config-default';
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import pluginN from 'eslint-plugin-n';

export default defineConfig([
    ...config,
    {
        ignores: [
            'dist/',
            'node_modules/',

            '.stryker-tmp/',
            'reports/',

            '.serena/',

            '.claude/',

            // JSON config files — not JavaScript, ESLint cannot parse them
            '*.json',

            // Template files use placeholder imports that are replaced at runtime
            'src/templates/'
        ]
    },
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
            }
        }
    },
    {
        plugins: { n: pluginN },
        rules:   {
            'n/no-missing-import':                     'off',
            'n/no-unpublished-import':                 'off',
            'lodash/prefer-lodash-method':             'off',
            'lodash/prefer-lodash-typecheck':          'off',
            'lodash/prefer-noop':                      'off',
            'lodash/prefer-constant':                  'off',
            'n/no-unsupported-features/node-builtins': ['error', { ignores: ['WebSocket', 'fetch'] }]
        }
    },
    {
        // Config files legitimately import devDependencies
        files:   ['*.mjs', '*.cjs', '*.config.*'],
        plugins: { 'import-x': importX },
        rules:   {
            'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }]
        }
    },
    {
        files: ['tests/**/*.test.ts', 'tests/**/*.ts'],
        rules: {
            // Tests run in Bun (>=16.9 compatible) so Object.hasOwn is safe;
            // only production source needs the >=16.0.0 compatibility restriction
            'n/no-unsupported-features/es-builtins':           ['error', { ignores: ['Object.hasOwn'] }],
            // Bun's test framework returns Thenables that should be awaited
            // ESLint doesn't understand this pattern - removing await would break tests
            '@typescript-eslint/await-thenable':               'off',
            // expect().rejects.toThrow() returns void but must be awaited — idiomatic in Bun/Jest
            '@typescript-eslint/no-confusing-void-expression': 'off',

            // Allow warn/error but flag log/info to keep tests clean
            'no-console': ['warn', { allow: ['warn', 'error'] }],

        }
    },
]);
