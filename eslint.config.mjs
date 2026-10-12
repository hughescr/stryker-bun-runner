import config from '@hughescr/eslint-config-default';
import { defineConfig } from 'eslint/config';

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
            'src/templates/',

            // Vendored third-party library used as the benchmark fixture (see bench/fixture/UPSTREAM.md)
            'bench/fixture/',

            // Git worktrees created by Claude Code agents (each is a full repo copy)
            '.claude/worktrees/'
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
        rules: {
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
        files: ['*.mjs', '*.cjs', '*.config.*'],
        rules: {
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

            // This project's bunfig-registered preload/setup file is tests/test-preload.ts,
            // not the rule's default tests/setup.ts
            '@hughescr/test-hygiene/no-mock-module-in-test-body': ['error', { setupFiles: ['tests/test-preload.ts'] }],

            // Tests never wait on the real clock. tests/real-clock-guard.ts fails any test
            // whose real timers run out, but it can only see the global timer functions:
            // these are the ways around it, so they are banned outright.
            'no-restricted-imports': ['error', {
                paths: [
                    { name: 'lodash', message: 'Use lodash-es instead for proper ESM tree-shaking.' },
                    ...['node:timers', 'node:timers/promises', 'timers', 'timers/promises'].map(name => ({
                        name,
                        message: 'Its timers bypass tests/real-clock-guard.ts. Use the global timers under jest.useFakeTimers(), or wait on an event.',
                    })),
                ],
            }],
            'no-restricted-properties': ['error',
                { object: 'Atomics', property: 'wait', message: 'Blocks on the real clock. Use jest.useFakeTimers(), or wait on an event.' },
                { object: 'Bun', property: 'sleepSync', message: 'Blocks on the real clock. Use jest.useFakeTimers(), or wait on an event.' },
            ],
        }
    },
    {
        // Integration tests drive real processes, so a fake clock cannot help them and
        // they have no business with timers at all: they wait on events (exit, close,
        // output). tests/real-clock-guard.ts enforces the same at run time.
        files: ['tests/00-integration/**/*.ts'],
        rules: {
            'no-restricted-globals': ['error',
                ...['setTimeout', 'setInterval'].map(name => ({
                    name,
                    message: 'Integration tests wait on events (exit, close, output), never on a timer.',
                })),
            ],
        }
    },
]);
