/**
 * Utilities for discovering test files in a directory tree.
 */

import type { Dirent } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@stryker-mutator/api/logging';
import { readBunfigTestRoot } from './bunfig-sanitizer.js';
import { TEST_FILE_SUFFIX_RE } from './test-name-pattern.js';

// Directory names bun's own walker skips (measured on bun 1.4.2): `node_modules`
// (case-insensitively) and every dot-directory (.git, .stryker-tmp, ...).
// `dist` and `build` are NOT skipped by bun, so they are not skipped here.
// Entries below the walk root only — the root itself is never name-checked.
function isExcludedDirName(name: string): boolean {
    return name.startsWith('.') || name.toLowerCase() === 'node_modules';
}

// Path segments that disqualify a symlink's RESOLVED target. This is stricter
// than bun (which follows such links) on purpose: a "vendor" link into
// node_modules would otherwise pull third-party tests into the mutation run.
// Dot-directories are not all excluded here because the project itself may
// legitimately live under one (e.g. ~/.work/proj).
const excludedTargetSegments = new Set(['node_modules', '.stryker-tmp', '.git']);

/**
 * Returns true when any path segment of absolutePath is an excluded directory.
 * Used for symlink targets to catch e.g. a "vendor" link pointing into node_modules.
 */
function hasExcludedAncestor(absolutePath: string): boolean {
    return absolutePath.split('/').some(seg => excludedTargetSegments.has(seg));
}

/**
 * Resolve the real path of a directory, returning undefined on failure.
 */
async function tryRealpath(p: string): Promise<string | undefined> {
    try {
        return await fsPromises.realpath(p);
    } catch{
        return undefined;
    }
}

/**
 * Stat a path, returning undefined on failure.
 */
async function tryStat(p: string): Promise<Awaited<ReturnType<typeof fsPromises.stat>> | undefined> {
    try {
        return await fsPromises.stat(p);
    } catch{
        return undefined;
    }
}

// Directory names that conventionally hold compiled output. Bun walks them, so
// a project whose tsc emits `dist/**/*.test.js` has those copies discovered.
const BUILD_OUTPUT_DIR_NAMES = new Set(['dist', 'build']);

/**
 * The files among `relativeFiles` that live below a `dist` or `build`
 * directory (any depth, case-insensitive; a file merely NAMED dist/build does
 * not count). Used to warn that bun-parity discovery picked up compiled copies
 * of the tests.
 *
 * @param relativeFiles - Paths relative to the project directory, as returned by {@link discoverTestFiles}
 */
export function findBuildOutputTestFiles(relativeFiles: readonly string[]): string[] {
    return relativeFiles.filter(file => file.split('/').slice(0, -1).some(seg => BUILD_OUTPUT_DIR_NAMES.has(seg.toLowerCase())));
}

interface WalkContext {
    cwd:              string
    results:          string[]
    visitedRealPaths: Set<string>
    logger?:          Pick<Logger, 'warn' | 'debug'>
    walk:             (dir: string) => Promise<void>
}

/**
 * Handle a symlinked directory entry during the walk.
 */
async function handleSymlinkDir(
    fullPath: string,
    entryName: string,
    ctx: WalkContext
): Promise<void> {
    if(isExcludedDirName(entryName)) {
        return;
    }
    const resolvedTarget = await tryRealpath(fullPath);
    if(!resolvedTarget) {
        return;
    }
    if(hasExcludedAncestor(resolvedTarget)) {
        // Stryker disable next-line StringLiteral: diagnostic logging message
        ctx.logger?.debug('discoverTestFiles: symlink %s resolves to excluded path %s; skipping', fullPath, resolvedTarget);
    } else {
        await ctx.walk(fullPath);
    }
}

/**
 * Handle a symlinked file entry during the walk.
 * Pushes relative path to results if the file is a test file with no excluded ancestor.
 */
async function handleSymlinkFile(
    fullPath: string,
    entryName: string,
    ctx: WalkContext
): Promise<void> {
    if(!TEST_FILE_SUFFIX_RE.test(entryName)) {
        return;
    }
    const resolvedTarget = await tryRealpath(fullPath);
    if(resolvedTarget && !hasExcludedAncestor(resolvedTarget)) {
        ctx.results.push(path.relative(ctx.cwd, fullPath));
    }
}

/**
 * Handle a symlinked entry — dispatches to dir or file handler after stat.
 */
async function handleSymlink(
    fullPath: string,
    entryName: string,
    ctx: WalkContext
): Promise<void> {
    const stat = await tryStat(fullPath);
    if(!stat) {
        // Broken symlink — log at debug level and skip.
        // Stryker disable next-line StringLiteral: diagnostic logging message
        ctx.logger?.debug('discoverTestFiles: broken symlink at %s; skipping', fullPath);
        return;
    }
    if(stat.isDirectory()) {
        await handleSymlinkDir(fullPath, entryName, ctx);
    } else if(stat.isFile()) {
        await handleSymlinkFile(fullPath, entryName, ctx);
    }
}

/**
 * Process a single directory entry during the walk.
 * Handles regular directories, symlinks, and files.
 * Returns 'continue' to signal the calling loop should skip to next entry.
 */
async function processEntry(
    entry: Dirent,
    dir: string,
    ctx: WalkContext
): Promise<void> {
    const fullPath = path.join(dir, entry.name);
    if(entry.isDirectory()) {
        if(!isExcludedDirName(entry.name)) {
            await ctx.walk(fullPath);
        }
    } else if(entry.isSymbolicLink()) {
        await handleSymlink(fullPath, entry.name, ctx);
    } else if(entry.isFile() && TEST_FILE_SUFFIX_RE.test(entry.name)) {
        ctx.results.push(path.relative(ctx.cwd, fullPath));
    }
}

/**
 * Walk for test files exactly as `bun test` would and return them sorted
 * lexicographically.  Passing an explicit, sorted list to `bun test` as
 * positional arguments removes Bun's reliance on readdir ordering (which is
 * non-deterministic on macOS APFS) and ensures mutantCoverage.perTest is
 * identical across runs.
 *
 * Matches Bun's rules (measured on bun 1.4.2): file names ending in
 * `.test.`, `_test.`, `.spec.` or `_spec.` plus js/jsx/ts/tsx/mjs/cjs/mts/cts
 * (case-insensitive); `node_modules` (case-insensitive) and dot-directories
 * are skipped; `dist` and `build` are walked.
 *
 * The walk starts at `[test].root` from `<cwd>/bunfig.toml` (or the bunfig named
 * by `--config` in `bun.bunArgs`, see `sourceBunfig`) when set (resolved
 * against cwd, as bun does) and the whole of cwd otherwise. Bun ignores
 * `root` for positional file arguments, so honouring it has to happen here.
 * `pathIgnorePatterns` needs no handling: bun applies it to positional
 * arguments too.  Returned paths are always relative to cwd.
 *
 * Returns undefined (not an empty array) when no files are found so callers
 * can fall back to Bun's built-in discovery rather than invoking `bun test`
 * with no files (which would match nothing and exit 0 with 0 tests run).
 *
 * @param cwd - Project directory: holds bunfig.toml and anchors the returned
 *          relative paths (defaults to process.cwd())
 * @param logger - Optional logger for diagnostic messages
 * @param sourceBunfig - The user's bunfig named by `--config` in `bun.bunArgs`
 *          (relative to cwd); `<cwd>/bunfig.toml` when omitted
 */
export async function discoverTestFiles(
    cwd: string = process.cwd(),
    logger?: Pick<Logger, 'warn' | 'debug'>,
    sourceBunfig?: string
): Promise<string[] | undefined> {
    const results: string[] = [];
    // Track real (resolved) directory paths to prevent infinite loops via symlinks.
    const visitedRealPaths = new Set<string>();

    const ctx: WalkContext = { cwd, results, visitedRealPaths, logger, walk };

    async function walk(dir: string): Promise<void> {
        // Resolve the real path of this directory before recursing to detect loops.
        const realDir = await tryRealpath(dir);
        if(!realDir) {
            // Broken symlink or unresolvable path — skip silently.
            // Stryker disable next-line StringLiteral: diagnostic logging message
            logger?.debug('discoverTestFiles: could not resolve real path of %s; skipping', dir);
            return;
        }
        if(visitedRealPaths.has(realDir)) {
            // Already visited via a different path (symlink loop) — skip to terminate.
            return;
        }
        visitedRealPaths.add(realDir);

        let entries;
        try {
            entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch{
            // Unreadable directory — skip silently.
            return;
        }
        // Sort entries so the walk order is deterministic even inside each directory.
        // Stryker disable next-line MethodExpression: equivalent on macOS APFS/HFS+ — readdir already returns entries in alphabetical order; sort is a no-op here but ensures portability on Linux
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for(const entry of entries) {
            // eslint-disable-next-line no-await-in-loop -- sequential walk: entries must be processed one at a time to maintain ordered results
            await processEntry(entry, dir, ctx);
        }
    }

    const walkRoot = (await readBunfigTestRoot(cwd, sourceBunfig)) ?? cwd;
    await walk(walkRoot);

    if(results.length === 0) {
        // Stryker disable next-line StringLiteral: diagnostic logging message
        logger?.warn('discoverTestFiles: no test files found in %s; falling back to Bun discovery', walkRoot);
        return undefined;
    }

    // Already sorted because we sorted entries inside each directory and the
    // recursive walk visits directories in sorted order.  An explicit top-level
    // sort ensures stability even if the walk order ever changes.
    // Stryker disable next-line MethodExpression: equivalent on macOS APFS/HFS+ — walk order is already alphabetical; sort is a no-op here but ensures portability on Linux
    results.sort((a, b) => a.localeCompare(b));
    // Stryker disable next-line StringLiteral: diagnostic logging message
    logger?.debug('discoverTestFiles: found %d test files in %s', results.length, cwd);
    return results;
}
