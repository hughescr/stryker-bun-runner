/**
 * Utilities for building Bun --test-name-pattern regex strings from Stryker test IDs.
 */

/**
 * Upper bound in UTF-8 BYTES for the generated --test-name-pattern string.
 *
 * The pattern is passed to `bun test` as a single argv entry, and the kernel
 * enforces argv limits in BYTES, not characters: Linux caps a single argv
 * string at MAX_ARG_STRLEN (131,072 bytes) and macOS caps total argv+env at
 * ARG_MAX (1 MiB). Exceeding these makes spawn fail with E2BIG, which
 * process-runner surfaces as exitCode null — and mutantRun would then
 * misreport the mutant as Killed. Non-ASCII test names make byte length
 * exceed JS string length (CJK ≈ 3 bytes/char, emoji 4), so the comparison
 * below uses Buffer.byteLength, never pattern.length.
 *
 * When the pattern would exceed this bound, buildTestNamePattern returns
 * undefined and the caller falls back to running the full suite — a safe
 * superset of the covering tests. Note the fallback runs under the
 * per-mutant timeout Stryker budgeted from the covering set's dry-run
 * durations, so an ultra-hot mutant may report TimedOut rather than
 * Survived; that is strictly safer than the E2BIG-to-Killed misreport.
 */
export const MAX_TEST_NAME_PATTERN_LENGTH = 100_000;

/**
 * Recognised test-file extension grammar — matches `test.ts`, `spec.tsx`,
 * `test.mjs`, `spec.cts`, etc. ([jt]sx? = ts/tsx/js/jsx; [mc][jt]s =
 * mts/mjs/cts/cjs).
 *
 * Single source of truth shared with the console parser's file-header regex
 * (src/parsers/console-parser.ts), so the id prefix-stripping here and the
 * header recognition there can never drift apart: a file the parser prefixes
 * onto console test names is always a file whose prefix this module strips
 * when rebuilding --test-name-pattern alternatives.
 */
export const TEST_FILE_EXT_PATTERN = String.raw`(?:test|spec)\.(?:[jt]sx?|[mc][jt]s)`;

// File-extension suffixes that mark the first path segment as a file prefix.
const fileExtRe = new RegExp(String.raw`\.${TEST_FILE_EXT_PATTERN}$`);

// Stryker disable next-line Regex: suffix regex is anchored and defensive
const dedupSuffixRe = / \[\d+\]$/;

// Characters that carry special meaning inside a regex literal.
// Stryker disable next-line Regex: character class enumerates metacharacters to escape
const metaRe = /[.*+?^${}()|[\]\\/]/g;

/**
 * Escape regex metacharacters in `str` so it is matched literally when
 * embedded as an alternative inside a --test-name-pattern regex.
 *
 * @param str - Raw literal text to embed in the generated regex
 * @returns `str` with every regex metacharacter backslash-escaped
 */
function escapeRegex(str: string): string {
    return str.replaceAll(metaRe, String.raw`\$&`);
}

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
 * When `testNameIndex` is supplied and has an entry for an id, that entry —
 * Bun's exact internal matching name, raw and byte-for-byte (see
 * InspectorClient.buildFullName) — is used verbatim (regex-escaped) instead
 * of the lossy reconstruction above, so titles that legitimately contain
 * " > " are matched correctly. The index must be keyed by the FULL id,
 * dedup suffix included; an id absent from the index (or mapped to an empty
 * or NUL-containing value) falls through to the lossy path unchanged.
 *
 * @param testFilter - Array of test IDs from Stryker's dryRun
 * @param testNameIndex - Optional map from the full Stryker test id (dedup
 *          suffix included) to Bun's exact internal matching name
 * @returns A regex string suitable for --test-name-pattern, or undefined when
 *          the filter is empty, yields no usable alternatives, or would produce
 *          a pattern whose UTF-8 byte length exceeds MAX_TEST_NAME_PATTERN_LENGTH
 *          (caller falls back to the full suite)
 */
export function buildTestNamePattern(testFilter: readonly string[], testNameIndex?: ReadonlyMap<string, string>): string | undefined {
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — empty filter also returns undefined via the alternatives.size === 0 check below
    if(testFilter.length === 0) {
        return undefined;
    }

    const alternatives = new Set<string>();
    for(const id of testFilter) {
        // Exact-name fast path: when the registry has Bun's raw matching name
        // for this FULL id, use it verbatim (escaped) and skip the lossy
        // reconstruction below entirely — it never mangles a legitimate " > "
        // inside a title because it never round-trips through that delimiter.
        const exact = testNameIndex?.get(id);
        if(exact !== undefined && exact.length > 0 && !exact.includes('\0')) {
            alternatives.add(escapeRegex(exact));
            continue;
        }

        // Strip the leading file-path prefix when the first component ends in a
        // recognised test-file extension.  The separator is " > ".
        const firstSepIdx = id.indexOf(' > ');
        // Stryker disable next-line ConditionalExpression,UnaryOperator: equivalent mutants — when firstSepIdx===-1 or ===1, id.slice(0,N) won't match fileExtRe for realistic test IDs (path prefix is >1 char), so behavior is unchanged
        let name: string = (firstSepIdx !== -1 && fileExtRe.test(id.slice(0, firstSepIdx)))
            ? id.slice(firstSepIdx + 3)
            : id;

        // Strip trailing " [N]" dedup suffix so both "foo [0]" and "foo [1]"
        // collapse to a single "foo" alternative.
        name = name.replace(dedupSuffixRe, '');

        // Collapse " > " hierarchy separators to single spaces to match Bun's
        // internal test-name format.
        name = name.replaceAll(' > ', ' ');

        // Escape regex metacharacters so the string is matched literally.
        name = escapeRegex(name);

        if(name.length > 0) {
            alternatives.add(name);
        }
    }

    if(alternatives.size === 0) {
        return undefined;
    }

    const pattern = `^(?:${[...alternatives].join('|')})$`;
    // Kernel argv limits are in BYTES — compare UTF-8 byte length, not UTF-16
    // char count (see MAX_TEST_NAME_PATTERN_LENGTH). The encoding argument is
    // deliberately omitted: Buffer.byteLength defaults to utf8, and an explicit
    // 'utf8' literal would only feed Stryker's StringLiteral mutator an
    // equivalent mutant (invalid/empty encodings also fall back to utf8).
    if(Buffer.byteLength(pattern) > MAX_TEST_NAME_PATTERN_LENGTH) {
        return undefined;
    }
    return pattern;
}
