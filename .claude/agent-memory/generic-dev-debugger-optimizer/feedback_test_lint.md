---
name: Test-specific lint rule overrides and patterns
description: Rules turned off for tests and common patterns in this project's test files
type: feedback
---

The `eslint.config.mjs` now has a test-file override block that turns off several rules for `tests/**/*.test.ts` and `tests/**/*.ts`:

- `@typescript-eslint/no-confusing-void-expression: off` — `expect().rejects.toThrow()` returns void but must be awaited; this is idiomatic in Bun/Jest
- `n/no-sync: off` — sync fs methods acceptable in test setup/teardown
- `n/no-unsupported-features/es-builtins: ['error', { ignores: ['Object.hasOwn'] }]` — tests run in Bun (>=16.9) so Object.hasOwn is safe; only production source needs >=16.0.0 compat
- `@typescript-eslint/await-thenable: off` — Bun test framework Thenables
- `no-console: ['warn', { allow: ['warn', 'error'] }]`

**Why:** These are all false positives or legitimate test patterns that don't apply to production code.

**How to apply:** When lint fires on test files for these patterns, check if the test-file override block already handles it rather than adding per-line disable comments.

For `no-await-in-loop` in timer-advance loops (fake timer tests), add `// eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask flush for fake-timer test` before the `await Promise.resolve()` line.

For `require-atomic-updates` on mock object property assignments after await, add `// eslint-disable-next-line require-atomic-updates -- mockX is a test mock; no concurrent access`.
