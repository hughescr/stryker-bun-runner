/**
 * Shared test-name utilities used by both the runner and coverage mapper.
 *
 * Extracted here to avoid a circular import between coverage-mapper.ts and
 * bun-test-runner.ts.
 */

/**
 * Normalize a sandbox file path to a relative path.
 * Stryker runs tests in a sandbox directory, but the incremental file
 * uses relative paths. We need to strip the sandbox prefix to enable caching.
 *
 * Input:  /path/to/project/.stryker-tmp/sandbox-ABC123/tests/unit/foo.test.ts
 * Output: tests/unit/foo.test.ts
 */
export function normalizeTestFilePath(url: string | undefined): string | undefined {
    if(!url) {
        return undefined;
    }

    // Look for .stryker-tmp/sandbox-XXXXX/ pattern and extract path after it
    // Stryker disable next-line Regex: character classes are defensive for path extraction
    const sandboxMatch = /\.stryker-tmp\/sandbox-[^/]+\/(.+)$/.exec(url);
    if(sandboxMatch) {
        return sandboxMatch[1];
    }

    // If no sandbox pattern, return as-is (might already be relative or a different format)
    return url;
}

/**
 * Normalize test names by replacing ASCII control characters with underscores.
 * Printable characters — including unicode (em-dash `—`, arrows, etc. that users
 * put in describe/test names) — are preserved verbatim so the normalized form
 * still matches Bun's internal test-name representation exactly.
 *
 * Safe characters: everything except C0 control chars (U+0000–U+001F) and DEL (U+007F).
 * Unsafe characters: only control chars → replaced with underscore 1:1.
 *
 * Note: The ' > ' sequence is used as a hierarchy delimiter by this plugin when
 * assembling `tests[].id`. If a test name literally contains ' > ', it will
 * cause parsing ambiguity — that is a known limitation.
 *
 * @param testName - The test name to normalize
 * @returns Normalized test name with control characters replaced by underscores
 */
export function normalizeTestName(testName: string): string {
    // Replace only C0 control chars and DEL. Preserves unicode so that a
    // describe name like "createWebViewAdapter — lazy init" keeps its em-dash
    // and matches what Bun reports internally and via --test-name-pattern.
    // Also trim whitespace to handle cases like "should %s" where %s is empty string.
    // Stryker disable next-line Regex: character class is C0 control chars + DEL
    return testName.replace(/[\x00-\x1F\x7F]/g, '_').trim();
}

/**
 * Builds a unique test identifier by combining file path and test hierarchy.
 * This prevents test name collisions when multiple files have identical describe blocks.
 *
 * Format: "path/to/file.test.ts > describe > test name"
 *
 * If no URL is provided, returns just the normalized test name without path prefix.
 *
 * @param fullName - The full hierarchical test name from inspector (e.g., "Suite > test")
 * @param url - The file URL from inspector (e.g., "file:///path/.stryker-tmp/sandbox-ABC/tests/foo.test.ts")
 * @returns Unique test identifier with file path prefix, or just normalized name if no URL
 *
 * @example
 * ```typescript
 * buildUniqueTestName("Suite > test", "file:///path/.stryker-tmp/sandbox-ABC/tests/foo.test.ts")
 * // Returns: "tests/foo.test.ts > Suite > test"
 *
 * buildUniqueTestName("Suite > test", undefined)
 * // Returns: "Suite > test"
 * ```
 */
export function buildUniqueTestName(fullName: string, url: string | undefined): string {
    const normalizedPath = normalizeTestFilePath(url);
    if(normalizedPath) {
        return normalizeTestName(`${normalizedPath} > ${fullName}`);
    }
    return normalizeTestName(fullName);
}
