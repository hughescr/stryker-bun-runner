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
        rules: {
            'n/no-missing-import':     'off',
            'n/no-unpublished-import': 'off'
        }
    }
];
