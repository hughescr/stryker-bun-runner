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
   * Additional bun test flags to pass.
   *
   * Bail flags (`--bail`, `--bail=<N>`, or a space-separated `--bail <N>`) are
   * stripped if present — bail is fully managed by the runner based on
   * Stryker's `disableBail` option, so a bail flag configured here would
   * otherwise silently override that decision.
   *
   * @example ['--only', '--verbose']
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

    /**
   * Pass Bun's `--smol` flag to every `bun test` child, trading some speed for
   * a significantly smaller JavaScriptCore heap footprint. Recommended on
   * memory-constrained machines, especially at higher Stryker `concurrency`,
   * since peak memory during a campaign is roughly
   * `concurrency × per-run suite footprint` (each run is an isolated process
   * that exits when it completes — see README "Memory model").
   * @default false
   */
    smol?: boolean

    /**
   * Soft memory ceiling, in bytes, for each `bun test` child's resident set
   * size (RSS). When set, the child's RSS is polled periodically; a run that
   * exceeds this ceiling is killed and reported as a clean timeout/error for
   * that one mutant, rather than being left to grow toward system-wide swap
   * exhaustion. This is a polled userspace check, not a kernel-enforced
   * limit — see README "Memory containment" for why a true hard ceiling
   * (rlimit/cgroup) isn't used. Omit to disable.
   */
    maxChildRss?: number

    /**
   * Poll interval in milliseconds for the {@link maxChildRss} check.
   * @default 1000
   */
    rssCheckIntervalMs?: number

    /**
   * Maximum `bun test` spawn nesting depth before the runner refuses to spawn.
   *
   * The runner can spawn `bun test` from inside a `bun test` it already
   * spawned. If a nested run falls back to auto-discovery while its cwd is the
   * project root, it picks up the project's entire suite — including the test
   * that spawned it — and the nesting never terminates. This ceiling makes that
   * finite: a run at or beyond the limit fails with a non-zero exit code
   * instead of spawning. See the README's "Recursion containment" section.
   *
   * The default of 1 allows the runner's own `bun test` children and nothing
   * deeper, which is right for every project whose tests do not themselves
   * drive this runner. Raise it to 2 only if yours do — note that the value
   * must be set on the runner instance making the *nested* call, since that is
   * where the ceiling is enforced.
   *
   * @default 1
   */
    maxSpawnDepth?: number
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
