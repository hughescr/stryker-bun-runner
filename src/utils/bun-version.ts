/**
 * Startup check that the configured `bun` binary can be run and is new enough.
 *
 * Without it a missing binary only surfaces much later, as a dry-run
 * `Timeout waiting for inspector URL`, with the real cause (`spawn bun ENOENT`)
 * buried in a log line. Running `<bunPath> --version` once up front turns that
 * into an immediate, actionable error.
 */

import { spawn } from 'node:child_process';

/**
 * Oldest bun this package supports — mirrors `engines.bun` in package.json
 * (`>=1.3.7`). Keep the two in lockstep.
 */
export const MIN_BUN_VERSION = '1.3.7';

/** How long `bun --version` may take before it is treated as not runnable. */
const VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Extract `major.minor.patch` from `bun --version` output (e.g. `1.4.2`, or a
 * canary such as `1.4.3-canary.20260101.1`). Prerelease/build suffixes are
 * ignored, so a canary of 1.3.7 counts as 1.3.7.
 *
 * @returns the three numeric components, or `undefined` when no version is found.
 */
export function parseBunVersion(output: string): [number, number, number] | undefined {
    // Bounded digit runs (no unbounded backtracking on adversarial output).
    const match = /(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec(output);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Numeric (not lexicographic — 1.10.0 is newer than 1.9.0) comparison of two
 * `major.minor.patch` triples. Negative when `a` is older than `b`, zero when
 * equal, positive when newer.
 */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
    for(let i = 0; i < 3; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if(diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/** Outcome of a single `<bunPath> --version` attempt. */
type VersionProbe = { stdout: string } | { failure: string };

/**
 * Spawn `<bunPath> --version` the way the real runs spawn bun: same merged
 * environment (`process.env` overlaid with `bun.env`, so a `PATH` set there is
 * honoured for command lookup too). Never rejects — a failure to run is
 * reported as `{ failure }` with the node error code (e.g. `ENOENT`) or a short
 * description.
 */
function probeBunVersion(bunPath: string, env: Record<string, string> | undefined, timeoutMs: number): Promise<VersionProbe> {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (probe: VersionProbe): void => {
            if(!settled) {
                settled = true;
                resolve(probe);
            }
        };

        try {
            const child = spawn(bunPath, ['--version'], {
                env:   { ...process.env, ...env },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const chunks: Buffer[] = [];
            child.stdout.on('data', (data: Buffer) => {
                chunks.push(data);
            });

            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                settle({ failure: `timed out after ${timeoutMs}ms` });
            }, timeoutMs);

            child.on('error', (error: NodeJS.ErrnoException) => {
                clearTimeout(timer);
                settle({ failure: error.code ?? error.message });
            });

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if(code === 0) {
                    settle({ stdout: Buffer.concat(chunks).toString() });
                } else {
                    settle({ failure: signal ? `terminated by ${signal}` : `exit code ${String(code)}` });
                }
            });
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            settle({ failure: err.code ?? err.message });
        }
    });
}

/**
 * Verify that `bunPath` can be run and reports at least {@link MIN_BUN_VERSION}.
 *
 * @param bunPath    the configured `bun.bunPath` (default `bun`)
 * @param env        the configured `bun.env`, merged over `process.env` exactly as the real spawn does
 * @param timeoutMs  upper bound for the `--version` call
 * @returns the detected version string (`major.minor.patch`)
 * @throws Error with an actionable message when bun cannot be run or is too old
 */
export async function checkBunVersion(bunPath: string, env?: Record<string, string>, timeoutMs: number = VERSION_CHECK_TIMEOUT_MS): Promise<string> {
    const probe = await probeBunVersion(bunPath, env, timeoutMs);
    const couldNotRun = (reason: string): Error =>
        new Error(`stryker-bun-runner: could not run "${bunPath}" (${reason}). Install bun >= ${MIN_BUN_VERSION} or set bun.bunPath in your Stryker config.`);

    if('failure' in probe) {
        throw couldNotRun(probe.failure);
    }

    const parsed = parseBunVersion(probe.stdout);
    if(!parsed) {
        throw couldNotRun(`unrecognized --version output "${probe.stdout.trim().slice(0, 100)}"`);
    }

    const version = parsed.join('.');
    // MIN_BUN_VERSION is a compile-time constant of the form x.y.z, so this parse cannot fail.
    if(compareVersions(parsed, parseBunVersion(MIN_BUN_VERSION)!) < 0) {
        throw new Error(`stryker-bun-runner: bun ${version} at "${bunPath}" is too old; version ${MIN_BUN_VERSION} or newer is required.`);
    }
    return version;
}
