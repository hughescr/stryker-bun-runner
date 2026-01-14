import config from '@hughescr/eslint-config-default';

export default [
    ...config,
    {
        ignores: [
            'dist/',
            'node_modules/',

            '.stryker-tmp/',
            'reports/',

            '.serena/',

            '.claude/'
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
        files: ['src/templates/**/*.ts'],
        rules: {
            'no-console': 'off'
        }
    },
    {
        files: ['tests/**/*.test.ts'],
        rules: {
            // Bun's test framework returns Thenables that should be awaited
            // ESLint doesn't understand this pattern - removing await would break tests
            '@typescript-eslint/await-thenable': 'off',

            // Allow warn/error but flag log/info to keep tests clean
            'no-console': ['warn', { allow: ['warn', 'error'] }]
        }
    }
];
