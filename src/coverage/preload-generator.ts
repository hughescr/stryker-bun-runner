/**
 * Preload script generator
 * Generates the preload script for coverage collection
 */

import { mkdir, unlink, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';

export interface PreloadOptions {
    /**
   * Directory to write the preload script to
   */
    tempDir: string

    /**
   * Path where coverage data will be written
   */
    coverageFile: string

    /**
   * Pre-resolved sorted list of absolute paths to source files that should be
   * eager-imported during coverage preload (the "static bucket" fix).
   *
   * Derive this from StrykerOptions.mutate using {@link resolveEagerModulesFromGlobs}
   * before calling {@link generatePreloadScript}.  When omitted or empty, no
   * eager imports are emitted and the generated preload behaves as before (module-level
   * mutants may still fall into perTest — only relevant when coverage collection is on).
   */
    eagerModules?: string[]
}

/**
 * Resolve Stryker's `mutate` glob patterns into a sorted list of absolute paths.
 *
 * This is the authoritative source for "which files to eager-import" because it
 * exactly matches what Stryker will instrument.  Patterns that start with `!` are
 * treated as exclusions (tinyglobby supports them natively).
 *
 * Results are:
 * - Filtered to `.ts` / `.tsx` / `.js` / `.mjs` files (excludes `.d.ts`, `.json`, etc.)
 * - Sorted ascending by absolute path for determinism
 *
 * @param mutateGlobs - The `StrykerOptions.mutate` array (may contain `!`-prefixed exclusions)
 * @param cwd - Root directory for resolving relative globs (defaults to process.cwd())
 */
export async function resolveEagerModulesFromGlobs(
    mutateGlobs: readonly string[],
    cwd: string = process.cwd()
): Promise<string[]> {
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — empty globs yield no positive patterns, caught by positivePatterns.length === 0 below
    if(mutateGlobs.length === 0) {
        return [];
    }

    // Separate positive patterns from negation patterns.
    // tinyglobby accepts negations inline when they start with '!', but we pass
    // them through the `ignore` option for clarity and to support both forms.
    // Stryker disable next-line ArrayDeclaration: equivalent mutant — extra "Stryker was here" initial element never matches real paths, so glob result is unchanged
    const positivePatterns: string[] = [];
    // Stryker disable next-line ArrayDeclaration: equivalent mutant — "Stryker was here" never matches real files so no legitimate path is excluded
    const negativePatterns: string[] = [];
    for(const p of mutateGlobs) {
        // Stryker disable next-line ConditionalExpression,MethodExpression: negation-pattern detection; tests verify excluded files do not appear in results
        if(p.startsWith('!')) {
            negativePatterns.push(p.slice(1));
        } else {
            // Strip any Stryker mutation-range suffix (e.g. "src/foo.ts:1:3-2:5")
            // before passing to the glob engine.
            // Stryker disable next-line Regex: mutation range suffix stripper is defensive
            positivePatterns.push(p.replace(/:\d.*$/, ''));
        }
    }

    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — glob([]) returns [] so skipping this check yields the same result
    if(positivePatterns.length === 0) {
        return [];
    }

    const paths = await glob(positivePatterns, {
        cwd,
        absolute:          true,
        ignore:            negativePatterns,
        // Do not expand plain directory patterns — the user's globs already name files.
        // Stryker disable next-line BooleanLiteral: existing tests only use file-glob patterns (not bare directories), so expandDirectories: true vs false is unobservable
        expandDirectories: false,
    });

    // Filter to source-code files only: .ts, .tsx, .js, .mjs.
    // Exclude TypeScript declaration files (.d.ts, .d.mts, .d.cts).
    // Stryker disable next-line Regex: extension filter is defensive, not behavioural
    const sourceFileRe = /\.(?:tsx?|[cm]?js)$/;
    // Stryker disable next-line Regex: declaration-file exclusion pattern
    const dtsRe = /\.d\.[cm]?ts$/;

    const filtered = paths.filter(p => sourceFileRe.test(p) && !dtsRe.test(p));

    // Resolve to absolute paths (glob returns absolute when absolute: true, but
    // be defensive in case cwd is relative).
    const resolved = filtered.map(p => path.resolve(p));

    resolved.sort((a, b) => a.localeCompare(b));
    return resolved;
}

/**
 * Generate the coverage preload script
 *
 * The preload script is copied from the templates directory to a temp location
 * so it can be used with Bun's --preload flag.
 *
 * @returns Path to the generated preload script
 */
export async function generatePreloadScript(options: PreloadOptions): Promise<string> {
    const preloadPath = path.join(options.tempDir, `stryker-coverage-preload-${process.pid}.ts`);

    // Ensure temp directory exists (mkdir with recursive is idempotent)
    await mkdir(options.tempDir, { recursive: true });

    // Get the path to the template file
    // Path differs between source and bundled builds:
    // - Bundled: __dirname is dist/, templates at dist/templates/, logic at dist/coverage/preload-logic.js
    // - Source: __dirname is src/coverage/, templates at src/templates/, logic at src/coverage/preload-logic.ts
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // Detect if running from bundled dist (has templates/ subdirectory) or source
    // Stryker disable next-line ConditionalExpression,LogicalOperator,MethodExpression: bundled path detection only testable with actual dist build
    const isBundled = __dirname.endsWith('dist') || __dirname.includes('dist/');

    // Stryker disable StringLiteral: bundled paths only used when running from dist/
    const templatePath = isBundled
        ? path.join(__dirname, 'templates/coverage-preload.ts')
        : path.join(__dirname, '../templates/coverage-preload.ts');
    // Stryker restore StringLiteral

    // Read the template
    const template = await readFile(templatePath, 'utf8');

    // Calculate the absolute path to preload-logic
    // Extension differs: .js for bundled, .ts for source (Bun handles both)
    // Stryker disable StringLiteral: bundled paths only used when running from dist/
    const preloadLogicPath = isBundled
        ? path.join(__dirname, 'coverage/preload-logic.js')
        : path.join(__dirname, 'preload-logic.ts');
    // Stryker restore StringLiteral

    // Use caller-provided eager module list (resolved from StrykerOptions.mutate).
    // Falls back to empty array when not provided — coverage still works, but
    // module-level mutants may record to perTest instead of static.
    const eagerModules = options.eagerModules ?? [];

    // Replace placeholders with runtime values.
    // JSON.stringify produces a valid TS/JS array literal and handles path escaping.
    const content = template
        .replace('__PRELOAD_LOGIC_PATH__', preloadLogicPath)
        .replace('__EAGER_MODULES__', JSON.stringify(eagerModules));

    // Write the template to the temp location
    await writeFile(preloadPath, content, 'utf8');

    return preloadPath;
}

/**
 * Clean up generated preload script
 */
export async function cleanupPreloadScript(preloadPath: string): Promise<void> {
    try {
        await unlink(preloadPath);
    } catch{
    // Ignore errors - file may not exist or may have already been deleted
    }
}
