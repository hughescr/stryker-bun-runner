# Debugger-Optimizer Memory

- [Catch Block Lint Patterns](feedback_catch_patterns.md) — bare `catch {}` breaks multiple lint rules; always log with `catch (error) { logger.debug(...) }`

- [ESLint Config Quirks](feedback_eslint_config.md) — Flat ESLint config plugin registration, devDependency, and JSON ignore patterns
- [Test Lint Patterns](feedback_test_lint.md) — Test-specific lint rules: void-expression, no-await-in-loop, no-sync, Object.hasOwn
- [Unicorn/Numeric Rule](feedback_numeric_separators.md) — minimumDigits: 5 means <5 digits must NOT have separators
- [no-unnecessary-condition Fix Pattern](feedback_lint_no_unnecessary_condition.md) — Widen TypeScript types instead of removing defensive null checks when lint flags them
- [dryRun Registry File Leak](feedback_test_file_leak.md) — dryRun() writes real files; unit tests must mock fsPromises.writeFile/rename
- [ESLint void-expression in tests](feedback_eslint_void_expression.md) — Add no-confusing-void-expression: off to test override for await expect().rejects pattern
- [Async microtask yields on hot path](feedback_async_hot_path.md) — Don't await async fns in dryRun fake-timer path; use sync cache helper + conditional await
