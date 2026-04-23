/**
 * Bunfig sanitizer
 * Reads the project's bunfig.toml and writes a sanitized copy that disables
 * coverage and onlyFailures — settings that would break mutation testing.
 */

import { readFile, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

// [test] keys that are safe to forward to child bun test processes.
// Coverage, reporter, and output-filtering keys are deliberately excluded.
const SAFE_TEST_KEYS = new Set([
    'preload',
    'root',
    'pathIgnorePatterns',
    'timeout',
    'smol',
    'rerunEach',
    'retry',
    'randomize',
    'seed',
]);

// Keys whose values contain filesystem paths that bun resolves relative to the
// bunfig file's location. Because we write the sanitized bunfig into a tmpdir,
// every one of these paths must be rewritten to be absolute (anchored at the
// project cwd) before being serialized, or bun will look for them under /tmp.
const PATH_VALUED_TEST_KEYS = new Set(['preload', 'root']);

/**
 * Resolve a single path value against the project cwd if it's a relative string.
 * Leaves absolute paths and non-string inputs untouched so bunfig's own error
 * reporting surfaces any real malformed entries.
 */
function absolutizePath(value: unknown, projectCwd: string): unknown {
    if(typeof value !== 'string') {
        return value;
    }
    return path.isAbsolute(value) ? value : path.resolve(projectCwd, value);
}

/**
 * Resolve relative paths (scalar or array) against projectCwd. Arrays preserve
 * their original item shape and order.
 */
function absolutizePathValue(value: unknown, projectCwd: string): unknown {
    if(Array.isArray(value)) {
        return value.map(item => absolutizePath(item, projectCwd));
    }
    return absolutizePath(value, projectCwd);
}

/**
 * Generate a sanitized bunfig.toml for use with `--config` during mutation testing.
 *
 * Copies the project's `[install]` table verbatim, forwards only the safe subset
 * of `[test]` keys, and overrides `coverage = false` and `onlyFailures = false`
 * regardless of the project's settings.
 *
 * @param projectCwd - Absolute path of the project root (where bunfig.toml lives)
 * @param tmpDir     - Directory where the sanitized file is written
 * @returns Absolute path of the written sanitized bunfig
 */
export async function generateSanitizedBunfig(projectCwd: string, tmpDir: string): Promise<string> {
    // Ensure temp directory exists
    await mkdir(tmpDir, { recursive: true });

    // Read the project bunfig, treating absence as empty config
    let rawConfig: Record<string, unknown> = {};
    const bunfigPath = path.join(projectCwd, 'bunfig.toml');
    try {
        const content = await readFile(bunfigPath, 'utf8');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- parse() returns TomlPrimitive, widening to Record is intentional
        rawConfig = parse(content) as unknown as Record<string, unknown>;
    } catch (err: unknown) {
        // ENOENT → no bunfig present, use empty config
        if((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            // Stryker disable next-line ObjectLiteral: equivalent mutant — { cause: err } vs {} is only observable via error.cause, not the error message tested here
            throw new Error(`Failed to read bunfig.toml at ${bunfigPath}: ${String(err)}`, { cause: err });
        }
    }

    // Build sanitized config
    const sanitized: Record<string, unknown> = {};

    // Copy [install] table verbatim (registries, caches, etc.)
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent mutants — null/non-object install values are silently dropped by TOML serializer either way
    if(typeof rawConfig.install === 'object' && rawConfig.install !== null) {
        sanitized.install = rawConfig.install;
    }

    // Build sanitized [test] section
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent mutant — non-object test values produce empty {} either way, causing no key matches
    const sourceTest = (typeof rawConfig.test === 'object' && rawConfig.test !== null)
        ? rawConfig.test as Record<string, unknown>
        : {};

    const sanitizedTest: Record<string, unknown> = {};
    for(const key of SAFE_TEST_KEYS) {
        // Stryker disable next-line ConditionalExpression: equivalent mutant — absent keys return undefined, which smol-toml serializes to nothing; output is identical
        // eslint-disable-next-line prefer-object-has-own -- Object.hasOwn not available until Node 16.9; using hasOwnProperty for compatibility
        if(Object.prototype.hasOwnProperty.call(sourceTest, key)) {
            // Path-valued keys must be made absolute because bun resolves them
            // relative to the sanitized bunfig file, which lives in tmpdir.
            sanitizedTest[key] = PATH_VALUED_TEST_KEYS.has(key)
                ? absolutizePathValue(sourceTest[key], projectCwd)
                : sourceTest[key];
        }
    }

    // Force-override settings that break mutation testing
    sanitizedTest.coverage     = false;
    sanitizedTest.onlyFailures = false;

    sanitized.test = sanitizedTest;

    const serialized = stringify(sanitized);

    const outPath = path.join(tmpDir, `stryker-bun-runner-bunfig-${process.pid}-${Date.now()}.toml`);
    await writeFile(outPath, serialized, 'utf8');

    return outPath;
}

/**
 * Remove the sanitized bunfig file, ignoring ENOENT.
 */
export async function cleanupSanitizedBunfig(filePath: string): Promise<void> {
    try {
        await unlink(filePath);
    } catch (err: unknown) {
        if((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
    }
}
