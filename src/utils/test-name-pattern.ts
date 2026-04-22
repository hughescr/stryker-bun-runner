/**
 * Utilities for building Bun --test-name-pattern regex strings from Stryker test IDs.
 */

/**
 * Convert an array of Stryker test IDs (from options.testFilter) into a
 * Bun --test-name-pattern regex string.
 *
 * Each ID has the shape produced by buildUniqueTestName():
 *   "tests/path/file.test.ts > Suite > test name"       (most common)
 *   "tests/path/file.test.ts > Suite > test name [N]"  (dedup suffix)
 *   "Suite > bare test"                                  (no file URL)
 *
 * Bun's --test-name-pattern matches against the test's *internal* name form,
 * which joins each describe hierarchy level and the test name with a **single
 * space** — NOT " > ". Using " > " in the pattern matches zero tests and, with
 * --bail, causes every mutant run to exit 1 with no parsed output. So after
 * stripping the file-path prefix and the " [N]" dedup suffix we collapse the
 * remaining " > " separators to single spaces before escaping regex metachars.
 *
 * Duplicate-name tests carry a trailing " [N]" dedup suffix that Bun cannot
 * distinguish at runtime; we strip the suffix so both "foo [0]" and "foo [1]"
 * collapse to a single "foo" alternative that runs both (safe superset).
 *
 * @param testFilter - Array of test IDs from Stryker's dryRun
 * @returns A regex string suitable for --test-name-pattern, or undefined
 *          when the filter is empty or yields no usable alternatives
 */
export function buildTestNamePattern(testFilter: readonly string[]): string | undefined {
    if(testFilter.length === 0) {
        return undefined;
    }

    // File-extension suffixes that mark the first path segment as a file prefix.
    // Stryker disable next-line Regex: character class lists recognised test-file extensions
    const fileExtRe = /\.(?:test|spec)\.(?:[jt]sx?|m[jt]s)$/;

    // Stryker disable next-line Regex: suffix regex is anchored and defensive
    const dedupSuffixRe = / \[\d+\]$/;

    // Collapse hierarchy separators " > " to single space (Bun's internal format).
    // Global, non-anchored; runs before regex-metachar escaping so the ">" char
    // itself never needs escaping in the output.
    // Stryker disable next-line Regex: hierarchy separator collapse is deliberate
    const hierarchySepRe = / > /g;

    // Characters that carry special meaning inside a regex literal.
    // Stryker disable next-line Regex: character class enumerates metacharacters to escape
    const metaRe = /[.*+?^${}()|[\]\\\/]/g;

    const alternatives = new Set<string>();
    for(const id of testFilter) {
        // Strip the leading file-path prefix when the first component ends in a
        // recognised test-file extension.  The separator is " > ".
        const firstSepIdx = id.indexOf(' > ');
        let name: string;
        if(firstSepIdx !== -1 && fileExtRe.test(id.slice(0, firstSepIdx))) {
            name = id.slice(firstSepIdx + 3);
        } else {
            name = id;
        }

        // Strip trailing " [N]" dedup suffix so both "foo [0]" and "foo [1]"
        // collapse to a single "foo" alternative.
        name = name.replace(dedupSuffixRe, '');

        // Collapse " > " hierarchy separators to single spaces to match Bun's
        // internal test-name format.
        name = name.replace(hierarchySepRe, ' ');

        // Escape regex metacharacters so the string is matched literally.
        name = name.replace(metaRe, '\\$&');

        if(name.length > 0) {
            alternatives.add(name);
        }
    }

    if(alternatives.size === 0) {
        return undefined;
    }

    return `^(?:${Array.from(alternatives).join('|')})$`;
}
