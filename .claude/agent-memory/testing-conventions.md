---
name: Testing conventions
description: Mock setup patterns, TestInfo shape, dryRun+mutantRun test combos, fs mock boundaries
type: project
---

## Test Infrastructure

- `tests/test-preload.ts` — Bun preload file. Mocks: `node:fs/promises` (readFile, writeFile, mkdir, unlink), `net` (createServer), `node:child_process` (spawn), `../src/utils/port.js` (getAvailablePort). Pass-through by default; tests call `.mockResolvedValue()` / `.mockRejectedValue()` to configure.
- `resetFsMocks()` / `resetAllMocks()` — restores pass-through behaviour. Call in `afterEach`.

## Standard Mock Pattern (bun-test-runner.test.ts)

```ts
let mockFoo: ReturnType<typeof mock>;
let fooSpy: ReturnType<typeof spyOn>;
// in beforeEach:
mockFoo = mock();
fooSpy = spyOn(module, 'foo').mockImplementation(mockFoo);
// in afterEach:
fooSpy.mockRestore();
```

## Key Spies in bun-test-runner.test.ts

- `runBunTests` — always mock for dryRun/mutantRun tests; must call `options.onInspectorReady(url)` for dryRun
- `generatePreloadScript` — mock in init tests; default `mockResolvedValue('/tmp/preload.ts')`
- `discoverTestFiles` — mock `mockResolvedValue(['tests/alpha.test.ts', 'tests/beta.test.ts'])`
- `resolveEagerModulesFromGlobs` — mock `mockResolvedValue([])` to avoid real filesystem I/O in init()
- `SyncServer` — mock constructor returning `{ start, signalReady, close, sendTestStart, clientCount }`
- `InspectorClient` — mock constructor returning `{ connect, send, getTests, getExecutionOrder, close }`

## resolveEagerModulesFromGlobs tests

Use **real temp directories** (not mocked) because tinyglobby does its own internal filesystem access that bypasses the `node:fs/promises` mock. Create files with `mkdir`+`writeFile` from `node:fs/promises` directly (imported with original bindings). Clean up with `rm(dir, {recursive:true})` in afterEach.

## dryRun test requirements

- Must call `runner.init()` first (sets preloadScriptPath, coverageFilePath)
- `mockRunBunTests` must call `options.onInspectorReady('ws://127.0.0.1:PORT/inspector')` synchronously or Promise-resolved quickly
- `mockInspectorClient.getTests.mockReturnValue([])` and `getExecutionOrder.mockReturnValue([])`
- `mockSyncServer.start.mockResolvedValue(undefined)`, `signalReady.mockReturnValue(undefined)`, `close.mockResolvedValue(undefined)`

## mutantRun test requirements

- Does NOT need inspector (no `onInspectorReady`)
- `mockRunBunTests` returns `{ exitCode, stdout, stderr, timedOut }`
- exit != 0 → killed, exit 0 → survived
- stderr with 'Cannot find module' etc. → RuntimeError when no parsed tests
