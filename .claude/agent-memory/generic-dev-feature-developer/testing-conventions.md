---
name: Testing conventions
description: Mock setup, TestInfo shape, dryRun+mutantRun combined test patterns
type: project
---

## Mock infrastructure (beforeEach in BunTestRunner describe)

- `mockRunBunTests` — spy on `processRunner.runBunTests`
- `mockInspectorClient` — spy on `InspectorClient` constructor; has `getTests`, `getExecutionOrder` mocks
- `mockSyncServer` — spy on `SyncServer` constructor
- `mockGetAvailablePort` — from `tests/test-preload.ts`; increments from 6499
- `mockGeneratePreloadScript` — set to `.mockResolvedValue('/tmp/preload.ts')` in beforeEach of each describe

## dryRun mock pattern

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock implementation
mockRunBunTests.mockImplementation((options: any) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- checking for dryRun callback
    if(options.onInspectorReady) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- invoking callback
        options.onInspectorReady('ws://127.0.0.1:6499/inspector');
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    }
    // mutantRun path
    return Promise.resolve({ exitCode: 1, stdout: mutantRunStdout, stderr: '', timedOut: false });
});
mockInspectorClient.getTests.mockReturnValue(inspectorTests);
mockInspectorClient.getExecutionOrder.mockReturnValue(executionOrder);
mockCollectCoverage.mockResolvedValue(undefined);
```

## TestInfo shape (all required fields)

```ts
{ id: 1, name: 'test name', fullName: 'full > name', type: 'test' as const, url: 'file:///proj/.stryker-tmp/sandbox-ABC/tests/foo.test.ts', status: 'pass' }
```

`type` is required — either `'test'` or `'describe'`. `url` uses `sandbox-ABC` pattern for normalizeTestFilePath to strip.

## Combined dryRun+mutantRun tests

Pattern: populate inspector mocks, call `runner.init()` + `runner.dryRun()` to seed the registry, then `runner.mutantRun()` and assert on `result.killedBy`.

The `mockRunBunTests` mock distinguishes dryRun vs mutantRun by checking `options.onInspectorReady`.

## Fake timer tests and microtask pipeline depth

Bun's `jest.useFakeTimers()` fake-timer tests use a for loop of `advanceTimersByTime(N) + await Promise.resolve()` to drive async code. Each iteration advances the async pipeline by exactly ONE microtask step (FIFO queue). 

**Critical rule**: every `await` in dryRun/mutantRun before `runBunTests()` is called costs one test iteration. The fake-timer tests for inspector-URL waiting use 5 iterations. If `runBunTests` is called after more than 3 microtask steps (getAvailablePort×2, syncServer.start), the 60ms `onInspectorReady` callback shifts past the test's loop boundary and hangs.

**Fix applied**: `ensureSanitizedBunfig()` is pre-warmed in `init()`. In `dryRun()`/`mutantRun()`, a synchronous cache check avoids the `async` overhead entirely when cwd hasn't changed.

## discoverTestFiles spy requirement

`spyOn(bunTestRunner, 'discoverTestFiles')` — must target the module namespace import (`import * as bunTestRunner from '../../src/bun-test-runner.js'`). The global `beforeEach` in `BunTestRunner describe` sets this to `mockResolvedValue(['tests/alpha.test.ts', 'tests/beta.test.ts'])` so all dryRun/mutantRun tests get a synchronous stub. This prevents real I/O during fake-timer tests (which would hang because `await readdir(...)` needs real event-loop turns). Tests that need different behaviour override the spy locally.

Note: `bun-test-runner.ts` imports fsPromises as namespace (`import * as fsPromises`) so tests can spy on readFile/writeFile/mkdir individually, and so discoverTestFiles can be intercepted at the module-namespace level.

## generateSanitizedBunfig spy requirement

`spyOn(bunfigSanitizer, 'generateSanitizedBunfig')` must target the same module path that the runner imports from. Runner imports from `./utils/bunfig-sanitizer.js` directly (NOT through the `./utils/index.js` barrel) so the spy and the binding are on the same module instance.

## fs/promises spy pattern (for registry tests)

`import * as fsPromises from 'node:fs/promises'` then `spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined)`. Same for `readFile` and `mkdir`. Restore in `afterEach`. These tests live in nested describe blocks inside `mutantRun` describe:
- `describe('dryRun registry persistence')` — tests that registry JSON is written with correct shape; write-failure non-fatal
- `describe('mutantRun registry lazy-load')` — tests that registry is loaded only when cachedTestNames absent AND testFilter empty; caching after first load; ENOENT falls back to raw names + warn
