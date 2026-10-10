/**
 * Bunfig sanitizer
 * Reads the project's bunfig.toml and writes a sanitized copy for `--config`.
 * `--config` REPLACES the project's bunfig, so everything the tests depend on
 * must be carried over: every top-level key and section is preserved as-is
 * (`[loader]`, `define`, `jsx*`, `[macros]`, `[install]`, `[run]`, ...) except
 * `[test]`, which is rebuilt from an allowlist with coverage and onlyFailures
 * forced off — settings that would break mutation testing. A project that
 * randomizes the test order also gets a copy for mutant runs with randomize
 * turned off (see mutantRunBunfigPath).
 */

import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { RETRY_REASON, RERUN_EACH_REASON } from './bun-args.js';
import { ensurePrivateDir, writePrivateFile } from './private-temp-dir.js';

// [test] keys that are safe to forward to child bun test processes.
// Coverage, reporter, and output-filtering keys are deliberately excluded.
// `retry` and `rerunEach` are not here either: they are dropped on purpose
// (see IGNORED_TEST_KEY_REASONS).
const SAFE_TEST_KEYS = new Set([
    'preload',
    'root',
    'pathIgnorePatterns',
    'timeout',
    'smol',
    'randomize',
    'seed',
]);

// [test] settings that are dropped (so bun runs with no retry / no rerun) AND
// reported with a warning, because the user asked for behaviour that mutation
// testing cannot honour.
const IGNORED_TEST_KEY_REASONS: ReadonlyMap<string, string> = new Map([
    ['retry', RETRY_REASON],
    ['rerunEach', RERUN_EACH_REASON],
]);

// [test] settings the runner forces to false, with why.
const FORCED_FALSE_TEST_KEY_REASONS: ReadonlyMap<string, string> = new Map([
    ['coverage', 'forced to false for mutation runs: a coverageThreshold miss makes bun exit 1 even when no test fails, which would be mistaken for a mutant kill'],
    ['onlyFailures', 'forced to false for mutation runs: hiding passing tests would hide the results the runner needs'],
]);

const COVERAGE_DROP_REASON = 'dropped: coverage is disabled for mutation runs (the runner collects its own per-test coverage)';
const GENERIC_DROP_REASON  = 'dropped: not on the runner\'s allowlist of [test] settings that are safe for mutation runs';

// Keys whose values contain filesystem paths. Bun resolves relative `preload`
// and `root` paths against the process cwd (measured on bun 1.4.2, including
// with `--config` pointing at a file in another directory), NOT against the
// bunfig's own directory. The runner spawns bun with cwd = the project/sandbox
// cwd so relative paths would resolve correctly anyway, but they are rewritten
// to absolute paths anchored at that cwd so the sanitized file (which lives in
// tmpdir) does not depend on the spawn cwd.
const PATH_VALUED_TEST_KEYS = new Set(['preload', 'root']);

/** A bunfig setting the sanitizer did not forward as written. */
export interface DroppedBunfigKey {
    /** Dotted key path, e.g. `test.retry`. */
    key:             string
    /** Why it was dropped or overridden. */
    reason:          string
    /** True when the user asked for something mutation runs cannot honour (worth a warning); false for routine, expected drops. */
    warn:            boolean
    /**
     * True when the key is kept in the sanitized bunfig (which the dry run uses) and dropped
     * only from its mutant-run copy at {@link mutantRunBunfigPath}; mutant runs must then use that copy.
     */
    mutantRunsOnly?: boolean
}

/**
 * [test] keys that randomize the test order: `randomize`, and `seed`, which bun
 * accepts only together with `randomize = true`. Measured on bun 1.4.2, randomize
 * shuffles both the order of the test files and the order of the tests within
 * each file. The dry run keeps them; mutant runs must not (see
 * {@link mutantRunBunfigPath}).
 */
const RANDOM_ORDER_TEST_KEYS = ['randomize', 'seed'] as const;

const RANDOM_ORDER_REASON = 'kept for the dry run, but mutant runs use a copy of the sanitized bunfig with randomize = false and no seed, '
  + 'so they run test files in the runner\'s cheapest-first order and tests in source order';

/**
 * Where {@link generateSanitizedBunfig} writes the copy of the sanitized bunfig
 * that mutant runs use when the project's bunfig randomizes the test order: the
 * same file name with `.mutant-runs` before the `.toml` extension. The copy
 * differs only in `[test]`: `randomize = false` and no `seed`. bun has no flag
 * that turns randomize off, so a second file is the only way; an explicit
 * `randomize = false` there also wins over a `--randomize` or `--seed` flag
 * (measured on bun 1.4.2).
 *
 * @param sanitizedPath - A path generateSanitizedBunfig returned
 */
export function mutantRunBunfigPath(sanitizedPath: string): string {
    return `${sanitizedPath.replace(/\.toml$/, '')}.mutant-runs.toml`;
}

/**
 * True for a TOML table: a plain object. Arrays, TOML dates (Date subclasses),
 * null and scalars are not tables.
 */
function isTable(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === '[object Object]';
}

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
 * Read and parse the source bunfig: `sourceBunfig` (from `bun.bunArgs`
 * `--config`, resolved against `projectCwd`) when given, else
 * `<projectCwd>/bunfig.toml`.
 *
 * The default bunfig is optional, so its absence is an empty config. A file the
 * user named explicitly must exist: silently running without the settings they
 * pointed at would be worse than failing.
 *
 * @throws Error when the file cannot be read or parsed, or when an explicitly
 *         named file does not exist
 */
async function readSourceBunfig(projectCwd: string, sourceBunfig: string | undefined): Promise<Record<string, unknown>> {
    const bunfigPath = sourceBunfig === undefined ? path.join(projectCwd, 'bunfig.toml') : path.resolve(projectCwd, sourceBunfig);
    try {
        const content = await readFile(bunfigPath, 'utf8');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- parse() returns TomlPrimitive, widening to Record is intentional
        return parse(content) as unknown as Record<string, unknown>;
    } catch (err: unknown) {
        // ENOENT → no default bunfig present, use empty config
        if(sourceBunfig === undefined && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        const what = sourceBunfig === undefined ? 'bunfig.toml' : 'bunfig (named by --config in bun.bunArgs)';
        // Stryker disable next-line ObjectLiteral: equivalent mutant — { cause: err } vs {} is only observable via error.cause, not the error message tested here
        throw new Error(`Failed to read ${what} at ${bunfigPath}: ${String(err)}`, { cause: err });
    }
}

/**
 * Return the project's `[test].root` from the source bunfig (see
 * {@link readSourceBunfig}), resolved to an absolute path.
 *
 * Bun resolves a relative `root` against the process cwd (verified on bun
 * 1.4.2, including with `--config` pointing elsewhere), which for the runner is
 * the project/sandbox cwd — the same anchor the sanitized bunfig uses.
 *
 * @param projectCwd - Directory holding bunfig.toml (and the bun subprocess cwd)
 * @param sourceBunfig - Path of the user's bunfig from `bun.bunArgs` (relative
 *          to projectCwd); `<projectCwd>/bunfig.toml` when omitted
 * @returns The absolute root, or undefined when there is no bunfig, no
 *          `[test].root`, or the value is not a string
 */
export async function readBunfigTestRoot(projectCwd: string, sourceBunfig?: string): Promise<string | undefined> {
    const rawConfig = await readSourceBunfig(projectCwd, sourceBunfig);
    // `test` may be absent or a non-table TOML value; optional chaining reads
    // `.root` off anything object-like and yields undefined for the rest.
    const root = (rawConfig.test as Record<string, unknown> | undefined)?.root;
    return typeof root === 'string' ? path.resolve(projectCwd, root) : undefined;
}

/**
 * Build the sanitized `[test]` table from the project's, and report what was
 * not forwarded as written.
 */
function sanitizeTestSection(sourceTest: Record<string, unknown>, projectCwd: string, dropped: DroppedBunfigKey[]): Record<string, unknown> {
    const sanitizedTest: Record<string, unknown> = {};
    for(const [key, value] of Object.entries(sourceTest)) {
        if(SAFE_TEST_KEYS.has(key)) {
            sanitizedTest[key] = PATH_VALUED_TEST_KEYS.has(key) ? absolutizePathValue(value, projectCwd) : value;
        } else if(IGNORED_TEST_KEY_REASONS.has(key)) {
            dropped.push({ key: `test.${key}`, reason: IGNORED_TEST_KEY_REASONS.get(key)!, warn: true });
        } else if(FORCED_FALSE_TEST_KEY_REASONS.has(key)) {
            // Forced below; only worth reporting when the project asked for something else.
            if(value !== false) {
                dropped.push({ key: `test.${key}`, reason: FORCED_FALSE_TEST_KEY_REASONS.get(key)!, warn: false });
            }
        } else {
            dropped.push({ key: `test.${key}`, reason: key.startsWith('coverage') ? COVERAGE_DROP_REASON : GENERIC_DROP_REASON, warn: false });
        }
    }

    // Force-override settings that break mutation testing
    sanitizedTest.coverage     = false;
    sanitizedTest.onlyFailures = false;
    return sanitizedTest;
}

/**
 * Generate a sanitized bunfig.toml for use with `--config` during mutation testing.
 *
 * `--config` replaces the project's bunfig, so every top-level key and section
 * is copied as-is (a top-level `preload` is anchored at projectCwd like
 * `[test].preload`). Only `[test]` is rebuilt: the safe allowlist of its keys is
 * forwarded, `retry` and `rerunEach` are dropped, and `coverage = false` and
 * `onlyFailures = false` are forced regardless of the project's settings.
 *
 * When `[test]` randomizes the test order (`randomize = true`, or a `seed`), a
 * second file is written for mutant runs at {@link mutantRunBunfigPath}, the
 * same except `randomize = false` and no `seed`, and both keys are reported
 * with `mutantRunsOnly: true`.
 *
 * The runner's own coverage preload is passed on the command line (`--preload`),
 * which bun runs AFTER `[test].preload` — user preloads therefore still run
 * first. Bun 1.4.2 does not run a top-level `preload` for `bun test` at all.
 *
 * @param projectCwd - Absolute path of the project root (where bunfig.toml lives)
 * @param tmpDir     - Directory where the sanitized file is written: a resolved
 *          path; it is created (0700) if absent and must be private to the
 *          current user (see ensurePrivateDir), or UnsafeTempDirError is thrown
 * @param sourceBunfig - Path of the user's bunfig from `bun.bunArgs` `--config`
 *          (relative to projectCwd); `<projectCwd>/bunfig.toml` when omitted
 * @param onDropped  - Called once with every setting that was dropped or
 *          overridden, and why (empty when nothing was)
 * @returns Absolute path of the written sanitized bunfig
 */
export async function generateSanitizedBunfig(
    projectCwd: string,
    tmpDir: string,
    sourceBunfig?: string,
    onDropped?: (dropped: DroppedBunfigKey[]) => void
): Promise<string> {
    // bun reads its config from here: like the preload, only ever written into a verified private directory
    await ensurePrivateDir(tmpDir);

    const rawConfig = await readSourceBunfig(projectCwd, sourceBunfig);
    const dropped: DroppedBunfigKey[] = [];

    // Everything is carried over untouched except [test], which is replaced below
    // (so it needs no filtering here); a top-level preload is anchored at
    // projectCwd (see PATH_VALUED_TEST_KEYS).
    const sanitized: Record<string, unknown> = Object.fromEntries(
        Object.entries(rawConfig).map(([key, value]) => [key, key === 'preload' ? absolutizePathValue(value, projectCwd) : value])
    );

    if(rawConfig.test !== undefined && !isTable(rawConfig.test)) {
        dropped.push({ key: 'test', reason: 'dropped: [test] is not a table', warn: false });
    }
    const sanitizedTest = sanitizeTestSection(isTable(rawConfig.test) ? rawConfig.test : {}, projectCwd, dropped);
    sanitized.test = sanitizedTest;

    // A randomized order is dropped for mutant runs only: `randomize = false` needs no copy.
    const randomOrderKeys = RANDOM_ORDER_TEST_KEYS.filter(key => sanitizedTest[key] !== undefined && sanitizedTest[key] !== false);
    for(const key of randomOrderKeys) {
        dropped.push({ key: `test.${key}`, reason: RANDOM_ORDER_REASON, warn: false, mutantRunsOnly: true });
    }

    onDropped?.(dropped);

    const outPath = path.join(tmpDir, `stryker-bun-runner-bunfig-${process.pid}-${Date.now()}.toml`);
    await writePrivateFile(outPath, stringify(sanitized));

    if(randomOrderKeys.length > 0) {
        const mutantRunTest = Object.fromEntries(Object.entries(sanitizedTest).filter(([key]) => key !== 'seed'));
        mutantRunTest.randomize = false;
        await writePrivateFile(mutantRunBunfigPath(outPath), stringify({ ...sanitized, test: mutantRunTest }));
    }

    return outPath;
}

/** Unlink `filePath`, ignoring ENOENT. */
async function unlinkIfPresent(filePath: string): Promise<void> {
    try {
        await unlink(filePath);
    } catch (err: unknown) {
        if((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
    }
}

/**
 * Remove the sanitized bunfig file and its mutant-run copy (see
 * {@link mutantRunBunfigPath}), ignoring either one being absent.
 */
export async function cleanupSanitizedBunfig(filePath: string): Promise<void> {
    await unlinkIfPresent(filePath);
    await unlinkIfPresent(mutantRunBunfigPath(filePath));
}
