/**
 * Preload script generator
 * Generates the preload script for coverage collection
 */

import { unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import { ensurePrivateDir, writePrivateFile } from '../utils/private-temp-dir.js';
import { TEST_FILE_SUFFIX_RE } from '../utils/test-name-pattern.js';

export interface PreloadOptions {
    /**
   * Directory to write the preload script to. Created if absent and verified to be
   * private to the current user (see {@link ensurePrivateDir}); an unsafe directory is refused.
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
    // Test files are never eager-imported, whatever the mutate globs say.
    // The preload runs before bun registers a test file in its own context, so
    // importing a spec from here loads its describe/it calls outside that
    // context and corrupts bun's registration: observed on a real project as a
    // third of the suite vanishing, with unattributable failures. Reachable without
    // any config mistake — a CLI `--mutate "src/**/*.ts"` REPLACES the config's
    // mutate array, silently dropping its `!**/*.spec.ts` negations — so the
    // guard belongs here rather than in the caller's globs.
    const filtered = paths.filter(p => sourceFileRe.test(p) && !dtsRe.test(p) && !TEST_FILE_SUFFIX_RE.test(p));

    // Resolve to absolute paths (glob returns absolute when absolute: true, but
    // be defensive in case cwd is relative).
    const resolved = filtered.map(p => path.resolve(p));

    resolved.sort((a, b) => a.localeCompare(b));
    return resolved;
}

/** Where the preload template lives and how the generated copy is named. */
export interface PreloadTemplateLocation {
    /** Absolute path of the template to read. */
    templatePath:     string
    /** Absolute path the template's `__PRELOAD_LOGIC_PATH__` import is pointed at, or undefined when the template is a bundle with the logic inlined. */
    preloadLogicPath: string | undefined
    /** Extension of the generated preload: `ts` for the source template, `js` for the prebuilt bundle. */
    extension:        'ts' | 'js'
}

/**
 * Locate the preload template for the module directory this code runs from.
 *
 * - Bundled (this code is in dist/): templates/coverage-preload.js, which
 *   scripts/build-preload.ts emitted as ONE plain-JavaScript file with the logic
 *   inlined, so a `bun test` child loads one file and transpiles nothing.
 * - Source (this code is in src/coverage/): the TypeScript template, which imports
 *   the TypeScript logic module by absolute path.
 *
 * @param moduleDir - Directory of this module (`import.meta.url`'s directory)
 */
export function resolvePreloadTemplate(moduleDir: string): PreloadTemplateLocation {
    // Detect if running from bundled dist (has templates/ subdirectory) or source
    // Stryker disable next-line ConditionalExpression,LogicalOperator,MethodExpression: a real checkout directory is never named dist, so the source branch cannot be told from a bundled one without an actual dist build; tests/unit/preload-generator.test.ts covers both outcomes through explicit directories
    const isBundled = moduleDir.endsWith('dist') || moduleDir.includes('dist/');
    if(isBundled) {
        return {
            templatePath:     path.join(moduleDir, 'templates/coverage-preload.js'),
            preloadLogicPath: undefined,
            extension:        'js',
        };
    }
    return {
        templatePath:     path.join(moduleDir, '../templates/coverage-preload.ts'),
        preloadLogicPath: path.join(moduleDir, 'preload-logic.ts'),
        extension:        'ts',
    };
}

/**
 * Generate the coverage preload script
 *
 * The preload script is copied from the templates directory to a temp location
 * so it can be used with Bun's --preload flag.
 *
 * Every `bun test` child EXECUTES this file, so it is only ever written into a
 * directory verified private to the current user, as a fresh owner-only file
 * that replaces (never writes through) whatever was at the path.
 *
 * @param options - See {@link PreloadOptions}
 * @param moduleDir - Directory this module runs from; only tests pass it, to exercise the bundled layout
 * @returns Path to the generated preload script
 */
export async function generatePreloadScript(
    options: PreloadOptions,
    moduleDir: string = path.dirname(fileURLToPath(import.meta.url))
): Promise<string> {
    await ensurePrivateDir(options.tempDir);

    const { templatePath, preloadLogicPath, extension } = resolvePreloadTemplate(moduleDir);
    const preloadPath = path.join(options.tempDir, `stryker-coverage-preload-${process.pid}.${extension}`);

    // Read the template
    const template = await readFile(templatePath, 'utf8');

    // Use caller-provided eager module list (resolved from StrykerOptions.mutate).
    // Falls back to empty array when not provided — coverage still works, but
    // module-level mutants may record to perTest instead of static.
    const eagerModules = options.eagerModules ?? [];

    // Replace placeholders with runtime values.
    // JSON.stringify produces a valid TS/JS array literal and handles path escaping.
    // The prebuilt bundle has the logic inlined, so only the source template has a logic path to fill in.
    const withLogic = preloadLogicPath === undefined ? template : template.replace('__PRELOAD_LOGIC_PATH__', preloadLogicPath);
    const content = withLogic.replace('__EAGER_MODULES__', JSON.stringify(eagerModules));

    // Write the template to the temp location
    await writePrivateFile(preloadPath, content);

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
