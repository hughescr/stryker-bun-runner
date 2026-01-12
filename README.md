# stryker-bun-runner
Stryker test runner plugin for Bun with perTest coverage support

## ⚠️ Critical Limitation

**Test-to-mutant correlation is currently broken** when running multiple test files concurrently (which is Bun's default behavior).

This affects:
- **All modes**: Wrong tests are reported as covering mutants
- **Incremental mode**: Completely non-functional - wrong tests run, correct tests are skipped, mutants go untested

**Root cause**: Bun's test runner lacks the reporter APIs needed to correlate test execution with test metadata. We're tracking the fix at [oven-sh/bun#25972](https://github.com/oven-sh/bun/issues/25972).

**Workaround**: None currently available. The plugin will work correctly only when all tests are in a single file.

We'll update this plugin once Bun ships the required APIs.
