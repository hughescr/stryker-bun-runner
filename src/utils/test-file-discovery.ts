/**
 * Utilities for discovering test files in a directory tree.
 */

import { Logger } from '@stryker-mutator/api/logging';
import { join, relative } from 'node:path';
import * as fsPromises from 'node:fs/promises';

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
    // Stryker disable next-line Regex: pattern enumerates known test-file extensions
    const testFileRe = /\.(?:test|spec)\.(?:[jt]sx?|m[jt]s)$/;
    // Directories that should never contain test files for the purpose of this run.
    const excludedDirs = new Set(['node_modules', '.stryker-tmp', 'dist', 'build', '.git']);

    /**
     * Returns true when any path segment of absolutePath is an excluded directory.
     * Used for symlink targets to catch e.g. a "vendor" link pointing into node_modules.
     */
    const hasExcludedAncestor = (absolutePath: string): boolean => {
        return absolutePath.split('/').some(seg => excludedDirs.has(seg));
    };

    const results: string[] = [];
    // Track real (resolved) directory paths to prevent infinite loops via symlinks.
    const visitedRealPaths = new Set<string>();

    const walk = async (dir: string): Promise<void> => {
        // Resolve the real path of this directory before recursing to detect loops.
        let realDir: string;
        try {
            realDir = await fsPromises.realpath(dir);
        } catch {
            // Broken symlink or unresolvable path — skip silently.
            if(logger) {
                // Stryker disable next-line StringLiteral: diagnostic logging message
                logger.debug('discoverTestFiles: could not resolve real path of %s; skipping', dir);
            }
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
        } catch {
            // Unreadable directory — skip silently.
            return;
        }
        // Sort entries so the walk order is deterministic even inside each directory.
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for(const entry of entries) {
            const fullPath = join(dir, entry.name);
            if(entry.isDirectory()) {
                if(!excludedDirs.has(entry.name)) {
                    await walk(fullPath);
                }
            } else if(entry.isSymbolicLink()) {
                // Resolve the symlink target to determine whether it is a directory or file.
                let stat;
                try {
                    stat = await fsPromises.stat(fullPath);
                } catch {
                    // Broken symlink — log at debug level and skip.
                    if(logger) {
                        // Stryker disable next-line StringLiteral: diagnostic logging message
                        logger.debug('discoverTestFiles: broken symlink at %s; skipping', fullPath);
                    }
                    continue;
                }
                if(stat.isDirectory()) {
                    // Treat symlinked directory as a regular directory (with loop detection).
                    // Also check whether any ancestor segment of the resolved target path is
                    // excluded — e.g. a "vendor" symlink pointing into node_modules should not
                    // be descended.
                    if(!excludedDirs.has(entry.name)) {
                        let resolvedTarget: string;
                        try {
                            resolvedTarget = await fsPromises.realpath(fullPath);
                        } catch {
                            // Unresolvable after stat succeeded — skip.
                            continue;
                        }
                        if(hasExcludedAncestor(resolvedTarget)) {
                            if(logger) {
                                // Stryker disable next-line StringLiteral: diagnostic logging message
                                logger.debug('discoverTestFiles: symlink %s resolves to excluded path %s; skipping', fullPath, resolvedTarget);
                            }
                        } else {
                            await walk(fullPath);
                        }
                    }
                } else if(stat.isFile() && testFileRe.test(entry.name)) {
                    // For symlinked files, check whether the resolved target path has an excluded
                    // ancestor segment (e.g. a test file symlinked from inside node_modules).
                    let resolvedTarget: string;
                    try {
                        resolvedTarget = await fsPromises.realpath(fullPath);
                    } catch {
                        continue;
                    }
                    if(!hasExcludedAncestor(resolvedTarget)) {
                        results.push(relative(cwd, fullPath));
                    }
                }
            } else if(entry.isFile() && testFileRe.test(entry.name)) {
                results.push(relative(cwd, fullPath));
            }
        }
    };

    await walk(cwd);

    if(results.length === 0) {
        if(logger) {
            // Stryker disable next-line StringLiteral: diagnostic logging message
            logger.warn('discoverTestFiles: no test files found in %s; falling back to Bun discovery', cwd);
        }
        return undefined;
    }

    // Already sorted because we sorted entries inside each directory and the
    // recursive walk visits directories in sorted order.  An explicit top-level
    // sort ensures stability even if the walk order ever changes.
    results.sort();
    if(logger) {
        // Stryker disable next-line StringLiteral: diagnostic logging message
        logger.debug('discoverTestFiles: found %d test files in %s', results.length, cwd);
    }
    return results;
}
