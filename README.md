# stryker-bun-runner

Stryker test runner plugin for Bun with perTest coverage support.

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
