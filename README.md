# stryker-bun-runner

Stryker test runner plugin for Bun with perTest coverage support.

[![npm version](https://img.shields.io/npm/v/@hughescr/stryker-bun-runner)](https://www.npmjs.com/package/@hughescr/stryker-bun-runner) [![LICENSE](https://img.shields.io/badge/LICENSE-Apache--2.0-blue)](LICENSE.md) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.7-f9f1e1?logo=bun)](https://bun.sh) [![Stryker](https://img.shields.io/badge/Stryker-Plugin-e74c3c?logo=stryker)](https://stryker-mutator.io) [![Mutation testing badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fhughescr%2Fstryker-bun-runner%2Fmain)](https://dashboard.stryker-mutator.io/reports/github.com/hughescr/stryker-bun-runner/main) [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

## Features

- **Per-test coverage analysis** - Accurately tracks which tests cover which mutants
- **Inspector Protocol integration** - Uses Bun's WebSocket Inspector API for reliable test discovery and tracking
- **Multi-file support** - Works correctly with multiple test files
- **Incremental mode compatible** - Runs only the tests affected by each mutant

## Requirements

### Bun Version

This plugin requires **Bun 1.3.7 or later** for full functionality. Bun 1.3.7 includes the TestReporter WebSocket events (from [PR #25986](https://github.com/oven-sh/bun/pull/25986)) that enable proper test-to-mutant correlation.

**Important:** Bun versions prior to 1.3.7 will NOT work with this plugin due to missing TestReporter events.

**To install Bun 1.3.7 or later:**

```bash
bun upgrade
```

Or install a specific version:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.7"
```

### Other Requirements

- **@stryker-mutator/core** ^9.0.0

## Installation

```bash
bun add -D @hughescr/stryker-bun-runner @stryker-mutator/core
```

## Configuration

Create a `stryker.conf.mjs` file:

```javascript
export default {
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/**/*.ts'],
  bun: {
    // bunPath defaults to 'bun' - only set if using a custom Bun installation
    inspectorTimeout: 5000,          // Inspector connection timeout in ms (default: 5000)
  },
};
```

## How It Works

The plugin uses Bun's Inspector Protocol (WebSocket) to:

1. **Discover tests** - Connects to Bun's test process via WebSocket
2. **Track execution** - Listens for TestReporter events to correlate test runs with coverage
3. **Sequential execution** - Uses `--concurrency=1` to ensure reliable coverage correlation
4. **Build hierarchy** - Reconstructs test names from describe blocks for accurate reporting

This approach provides reliable test-to-mutant correlation, even with multiple test files.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bun.bunPath` | `string` | `'bun'` | Path to the Bun executable |
| `bun.timeout` | `number` | `10000` | Timeout per test in milliseconds |
| `bun.inspectorTimeout` | `number` | `5000` | Timeout for Inspector WebSocket connection in milliseconds |
| `bun.env` | `object` | `undefined` | Additional environment variables to pass to bun test |
| `bun.bunArgs` | `string[]` | `undefined` | Additional bun test flags (e.g., `['--bail']`) |
| `bun.testFiles` | `string[]` | `undefined` | Explicit list of test file paths (absolute or relative to cwd). When provided, skips auto-discovery and uses this list verbatim. Relative paths resolve against the bun subprocess's cwd. Useful for restricting mutation testing to a subset of test files. |

### Example with all options

```javascript
bun: {
  bunPath: '/path/to/bun',   // Custom bun executable (defaults to 'bun')
  timeout: 30000,            // 30 second test timeout
  inspectorTimeout: 10000,   // 10 second connection timeout
  env: { DEBUG: 'true' },    // Extra environment variables
  bunArgs: ['--bail'],       // Stop on first failure
}
```

## Running Stryker

```bash
bunx stryker run
```

## How the sandboxed config works

When the plugin initialises it reads your project's `bunfig.toml` (if present) and writes a sanitized copy that is passed to every `bun test` invocation via `--config`. The sanitizer forwards only an explicit allowlist of `[test]` keys; everything else is stripped. The forwarded keys are: `preload`, `root`, `pathIgnorePatterns`, `timeout`, `smol`, `rerunEach`, `retry`, `randomize`, `seed`. The `[install]` table is copied verbatim. Two keys are always forced: `coverage = false` and `onlyFailures = false`. This prevents `coverageThreshold` misses (which cause Bun to exit 1 even when no test actually fails) from being mistaken for mutant kills. If you need additional `[test]` settings forwarded, add their key names to the `SAFE_TEST_KEYS` set in `src/utils/bunfig-sanitizer.ts`.

## Known Limitations

- **Sequential execution required** - Tests run with `--concurrency=1` to ensure accurate coverage tracking. This is slower than parallel execution but necessary for correct test-to-mutant correlation.

**Eager-import and `mock.module()` compatibility**

During `dryRun`, the plugin eager-imports every mutated source module at preload time in order to produce deterministic per-test coverage. Each mutated module is imported once, before any test file executes.

Because of this, any `mock.module()` call that runs after a module has already been imported has no effect on the already-resolved module binding. In practice, this means that if a test file calls `mock.module('./some-source-file')` at the top level (or inside a `beforeAll`), and that file is among the mutated modules, the test will see the real module rather than the mock.

Suggested workarounds: use dependency injection so the real module reference is replaceable at test time; wrap the mocked surface in a test-local helper that the test can control without replacing the module; or use `mock.fn()` on method instances rather than replacing the entire module with `mock.module()`.

This limitation applies only to mutated source files — the ones listed under `mutate:` in your Stryker config. Pre-import `mock.module()` of non-mutated modules (for example `node:fs`, third-party libraries, or utility files outside the mutation scope) is unaffected.

## Concurrent Tests

This plugin automatically patches `describe.concurrent()`, `test.concurrent()`, and `it.concurrent()` to run sequentially during mutation testing. Your tests will work without modification.

**Why?** Coverage tracking requires knowing which test exercised which code. With concurrent execution, the `beforeEach` hook assigns test IDs in the order tests *start*, but coverage is recorded in the order tests *complete*. These orders differ with concurrency, causing coverage to be attributed to the wrong tests.

**What this means:**
- ✅ Your `.concurrent()` tests work automatically with Stryker
- ✅ Normal test runs (without Stryker) still use concurrent execution
- ⏱️ Mutation testing runs are slower due to sequential execution

## License

Apache-2.0

## Contributing

Issues and pull requests welcome at [github.com/hughescr/stryker-bun-runner](https://github.com/hughescr/stryker-bun-runner)
