# Contributing to stryker-bun-runner

Issues and pull requests are welcome at
[github.com/hughescr/stryker-bun-runner](https://github.com/hughescr/stryker-bun-runner). How the
runner works is described in [docs/internals.md](docs/internals.md).

## Tests, lint and types

```bash
bun install
bun test
bun run lint
bun run typecheck
```

## Mutation testing

This project's own mutation score is held at 100%. Run it with:

```bash
bun run build && bun run mutate
```

The local config is incremental: it reuses `reports/stryker-incremental.json` and only re-tests
what changed. Use `bun run mutate --force` (or delete that file) only when the cached results look
wrong, that is, when they do not reflect a change you made.

## Tests never wait on the real clock

Stryker re-runs a mutant's covering tests for every mutant, so any real wait in a test is paid
thousands of times. Use bun:test's fake timers (`jest.useFakeTimers()`, with helpers in
`tests/helpers/fake-clock.ts`) or wait on events (exit, close, a line of output).
`tests/real-clock-guard.ts`, loaded by `tests/test-preload.ts`, fails any test whose real timer
with a delay above zero fires, and ESLint rejects timer imports in tests.

## Checking orphan prevention on a machine

```bash
bun scripts/verify-orphan-lifeline.ts
```

The script spawns a real host process that runs a one-test suite, holding Bun's fake timers,
through the runner's spawn path and coverage preload. It then kills the host with SIGKILL and waits
up to 5 s for the child to exit. It prints `PASS` or `FAIL` with timings and exits 0 or 1. `FAIL`
with a timer in the child's fake-timer queue means the lifeline pipe is unavailable on that machine
and the child fell back to the timer watchdog. The orphan integration test in the suite also passes
through that fallback (more slowly), so this script is the check that the lifeline itself works on
a given machine. See [Orphan prevention](docs/internals.md#orphan-prevention).

## `// Stryker disable` comments

A `// Stryker disable` comment in `src/` is only for a genuinely equivalent mutant, with an
independently confirmed reason. Prefer writing the test that kills the mutant.

Mind the scope. Stryker only honours a `// Stryker disable` or `// Stryker restore` comment that
comes directly before a statement or expression it visits. A comment that is the last line before a
closing brace (the end of an `if` block, a `catch` clause or a function body) is ignored without any
warning. When that comment is a `// Stryker restore`, the range disable it was meant to end stays
active to the end of the file and silently marks every later mutant of those mutators as Ignored.
Put the restore before the next statement after the block, or prefer
`// Stryker disable next-line` on the exact line.

`tests/unit/stryker-disable-scopes.test.ts` fails on any directive Stryker would ignore and on any
range disable without a matching restore.
