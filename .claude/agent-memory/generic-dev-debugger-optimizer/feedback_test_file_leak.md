---
name: dryRun registry file leaks to disk during unit tests
description: BunTestRunner.dryRun() writes .stryker-bun-runner-registry.json to process.cwd() — unit tests must mock fsPromises.writeFile/rename
type: feedback
---

`BunTestRunner.buildAndPersistTestRegistry()` calls `fsPromises.writeFile` and `fsPromises.rename` to persist a registry file at `process.cwd()/.stryker-bun-runner-registry.json`. Unit tests that call `dryRun()` without mocking these will write a real file to the project root.

**Fix applied:** Added `globalWriteFileSpy` and `globalRenameSpy` to the outer `beforeEach` in `tests/unit/bun-test-runner.test.ts` that mock both functions. Inner describe blocks (e.g., 'dryRun registry persistence') have their own named spies that override these for specific tests.

Also: `tests/00-integration/inspector-integration.test.ts` runs a real dryRun and must clean up the registry file in `afterAll` using `fsPromises.rm(registryPath, { force: true })`.

**Why:** Tests should not leave untracked files in the repo. The `.stryker-bun-runner-registry.json` was appearing after test runs and polluting git status.

**How to apply:** When adding new unit tests that exercise `dryRun()`, ensure `fsPromises.writeFile` and `fsPromises.rename` are mocked. Do NOT add `.stryker-bun-runner-registry.json` to `.gitignore` — fix the test.
