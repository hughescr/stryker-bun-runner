# stryker-bun-runner

Stryker test runner plugin for Bun with perTest coverage support.

[![npm version](https://img.shields.io/npm/v/@hughescr/stryker-bun-runner)](https://www.npmjs.com/package/@hughescr/stryker-bun-runner) [![LICENSE](https://img.shields.io/badge/LICENSE-Apache--2.0-blue)](LICENSE.md) [![Bun](https://img.shields.io/badge/Bun-%3E1.3.6-f9f1e1?logo=bun)](https://bun.sh) [![Stryker](https://img.shields.io/badge/Stryker-Plugin-e74c3c?logo=stryker)](https://stryker-mutator.io) [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

> **Beta Status**: This package is published as `1.0.0-beta1` because it requires
> a pre-release build of Bun with [PR #25986](https://github.com/oven-sh/bun/pull/25986)
> merged. Once this fix is available in mainline Bun, we will release version `1.0.0`.
> The plugin itself is feature-complete and stable.

## Features

- **Per-test coverage analysis** - Accurately tracks which tests cover which mutants
- **Inspector Protocol integration** - Uses Bun's WebSocket Inspector API for reliable test discovery and tracking
- **Multi-file support** - Works correctly with multiple test files
- **Incremental mode compatible** - Runs only the tests affected by each mutant

## Requirements

### Bun Version

This plugin currently requires **bun-25986** (a pre-release build with [oven-sh/bun#25986](https://github.com/oven-sh/bun/pull/25986)) for full functionality. This PR fixes the TestReporter WebSocket events that enable proper test-to-mutant correlation.

**To install bun-25986:**

```bash
bunx bun-pr 25986
```

**Important:** You must also configure Stryker to use `bun-25986` by setting `bunPath` in your config (see Configuration section below).

Once PR 25986 is merged into a stable Bun release, the default `bunPath` of `bun` will work and you can remove the `bunPath` setting entirely.

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
    bunPath: 'bun-25986',            // Use bun-25986 until PR #25986 is merged (then use 'bun')
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

### Example with all options

```javascript
bun: {
  bunPath: 'bun-25986',      // Custom bun executable
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

## Known Limitations

- **Sequential execution required** - Tests run with `--concurrency=1` to ensure accurate coverage tracking. This is slower than parallel execution but necessary for correct test-to-mutant correlation.

## License

Apache-2.0

## Contributing

Issues and pull requests welcome at [github.com/hughescr/stryker-bun-runner](https://github.com/hughescr/stryker-bun-runner)
