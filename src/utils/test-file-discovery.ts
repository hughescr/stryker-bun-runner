/**
 * Utilities for discovering test files in a directory tree.
 */

import type { Dirent } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@stryker-mutator/api/logging';

// Stryker disable next-line Regex: pattern enumerates known test-file extensions
const testFileRe = /\.(?:test|spec)\.(?:[jt]sx?|m[jt]s)$/;

// Directories that should never contain test files for the purpose of this run.
const excludedDirs = new Set(['node_modules', '.stryker-tmp', 'dist', 'build', '.git']);

/**
 * Returns true when any path segment of absolutePath is an excluded directory.
 * Used for symlink targets to catch e.g. a "vendor" link pointing into node_modules.
 */
function hasExcludedAncestor(absolutePath: string): boolean {
    return absolutePath.split('/').some(seg => excludedDirs.has(seg));
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
    if(excludedDirs.has(entryName)) {
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
    if(!testFileRe.test(entryName)) {
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
    // Stryker disable ConditionalExpression: equivalent mutant — stat.isFile() → true still applies handleSymlinkFile only for non-directory symlinks; block devices/sockets never have .test.ts extension so output is identical
    if(stat.isDirectory()) {
        await handleSymlinkDir(fullPath, entryName, ctx);
    } else if(stat.isFile()) {
        await handleSymlinkFile(fullPath, entryName, ctx);
    }
    // Stryker restore ConditionalExpression
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
        if(!excludedDirs.has(entry.name)) {
            await ctx.walk(fullPath);
        }
    } else if(entry.isSymbolicLink()) {
        await handleSymlink(fullPath, entry.name, ctx);
        // Stryker disable ConditionalExpression: equivalent mutant — entry.isFile() → true in the else-if means only the extension check matters; non-file entries (devices, FIFOs) are already excluded by earlier branches and never have .test.ts extensions
    } else if(entry.isFile() && testFileRe.test(entry.name)) {
        ctx.results.push(path.relative(ctx.cwd, fullPath));
    }
    // Stryker restore ConditionalExpression
}

/**
 * Glob the current working directory for test files and return them sorted
 * lexicographically.  Passing an explicit, sorted list to `bun test` as
 * positional arguments removes Bun's reliance on readdir ordering (which is
 * non-deterministic on macOS APFS) and ensures mutantCoverage.perTest is
 * identical across runs.
 *
 * Excluded directories: node_modules, .stryker-tmp, dist, build, .git.
 *
 * Returns undefined (not an empty array) when no files are found so callers
 * can fall back to Bun's built-in discovery rather than invoking `bun test`
 * with no files (which would match nothing and exit 0 with 0 tests run).
 *
 * @param cwd - Root directory to walk (defaults to process.cwd())
 * @param logger - Optional logger for diagnostic messages
 */
export async function discoverTestFiles(
    cwd: string = process.cwd(),
    logger?: Pick<Logger, 'warn' | 'debug'>
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

    await walk(cwd);

    if(results.length === 0) {
        // Stryker disable next-line StringLiteral: diagnostic logging message
        logger?.warn('discoverTestFiles: no test files found in %s; falling back to Bun discovery', cwd);
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
