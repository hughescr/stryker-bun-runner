---
name: ESLint void expression rule for test files
description: '@typescript-eslint/no-confusing-void-expression must be off in test files for await expect().rejects.toThrow() pattern'
type: feedback
---

The `@typescript-eslint/no-confusing-void-expression` rule fires on `await expect(fn()).rejects.toThrow('msg')` in tests because `rejects.toThrow()` returns `void`.

This is idiomatic Bun/Jest test code — `await` is required to catch assertion failures, even though the return type is void.

**Why:** The rule flags legitimate test patterns; removing `await` would miss async assertion failures.

**How to apply:** The `eslint.config.mjs` test-file override block (files: `tests/**/*.test.ts`) should have `'@typescript-eslint/no-confusing-void-expression': 'off'`. If lint fires on this in a test file, add it to the override block rather than using a per-line disable.
