/**
 * Type definitions for plugin options
 */

import type { StrykerOptions } from '@stryker-mutator/api/core';

/**
 * Configuration options specific to the Bun test runner
 */
export interface BunTestRunnerOptions {
    /**
   * Custom path to the bun binary
   * @default 'bun'
   */
    bunPath?: string

    /**
   * Child-process timeout in milliseconds — the maximum wall-clock time that the
   * entire `bun test` subprocess is allowed to run before it is killed.
   * @default 10000
   *
   * Note: this is distinct from Bun's per-test timeout configured via
   * `[test].timeout` in `bunfig.toml`.  The two are independent: `bunfig.toml`
   * controls when Bun itself declares a single test timed out; this option
   * controls when the Stryker runner forcibly kills the whole child process.
   */
    timeout?: number

    /**
   * Timeout for inspector connection in ms
   * @default 5000
   */
    inspectorTimeout?: number

    /**
   * Additional environment variables to pass to bun test
   */
    env?: Record<string, string>

    /**
   * Additional bun test flags to pass
   * @example ['--bail', '--only']
   */
    bunArgs?: string[]

    /**
   * Explicit list of test file paths (must be non-empty when provided).
   * When provided, BunTestRunner skips auto-discovery (which globs
   * `**\/*.test.ts` from the current working directory) and uses exactly this
   * list. Useful for restricting mutation testing to a subset, or for callers
   * that run outside Stryker's sandboxed cwd and need to point at a specific
   * file set. Relative paths resolve against the bun subprocess's cwd.
   *
   * IMPORTANT: In a Stryker mutation-testing run, each worker's cwd is set to
   * a sandbox directory (`.stryker-tmp/sandbox-XYZ/`) containing sandbox copies
   * of the project files. Relative paths are resolved against that sandbox cwd
   * and therefore point at the mutated copies. Absolute paths bypass the sandbox
   * and always point at the ORIGINAL (unmutated) files — mutations will be
   * silently ignored. Always prefer relative paths in Stryker context.
   *
   * An empty array (`[]`) is invalid — use `undefined` or omit the option to
   * fall back to auto-discovery.
   */
    testFiles?: string[]
}

/**
 * Extended Stryker options with Bun-specific configuration
 */
export interface StrykerBunOptions extends StrykerOptions {
    /**
   * Bun test runner specific configuration
   */
    bun?: BunTestRunnerOptions
}
