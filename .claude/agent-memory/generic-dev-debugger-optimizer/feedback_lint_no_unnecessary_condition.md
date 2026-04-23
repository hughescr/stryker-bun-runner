---
name: no-unnecessary-condition and defensive null checks
description: When lint removes defensive null guards as "unnecessary", the fix is widening the TypeScript type, not adding eslint-disable
type: feedback
---

The `@typescript-eslint/no-unnecessary-condition` rule (configured as warn in base config) will flag null checks when the TypeScript type says the value is never null. The lint-cleanup pass removed such checks from src/process-runner.ts (stdout/stderr), src/coverage/coverage-mapper.ts (rawCoverage?.perTest), src/coverage/preload-logic.ts (perTest ?? {}, static ?? {}), and src/bun-test-runner.ts (options.mutate ?? []).

These checks ARE necessary at runtime even though TypeScript says they aren't. The correct fix:

1. **For function parameters**: Widen the TypeScript parameter type to include `undefined | null` (use function overloads to keep callers with non-null input getting non-null output).
2. **For local type aliases**: Use `interface` not `type` (different lint rule: `@typescript-eslint/consistent-type-definitions`).
3. **For spawn() stdout/stderr**: Type `spawnOpts` as `SpawnOptions` (not inline tuple) so the return type is `ChildProcess` with `Readable | null` streams rather than `ChildProcessByStdio<null, Readable, Readable>`.
4. **For StrykerOptions.mutate**: Cast `(options as { mutate?: string[] }).mutate ?? []` since the field is required in the type but missing in unit test mocks.

**Why:** Lint-cleanup passes can accidentally remove runtime-defensive code when TypeScript types are "stricter" than the actual runtime behavior. Tests that pass null/undefined mocks expose this.

**How to apply:** When a lint cleanup removes a null check and tests break, don't revert — widen the type to make the check genuinely necessary per the type system.
