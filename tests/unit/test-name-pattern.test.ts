/**
 * Unit tests for buildTestNamePattern
 */

import { describe, it, expect } from 'bun:test';
import { buildTestNamePattern, MAX_TEST_NAME_PATTERN_LENGTH, TEST_FILE_EXT_PATTERN } from '../../src/utils/test-name-pattern.js';

// ── buildTestNamePattern unit tests ────────────────────────────────────────

describe('buildTestNamePattern', () => {
    it('returns undefined for an empty array', () => {
        expect(buildTestNamePattern([])).toBeUndefined();
    });

    // Bun's --test-name-pattern matches against the test's internal name form,
    // which joins hierarchy levels with a single SPACE (not " > "). Our IDs use
    // " > " as a separator; the builder must collapse " > " to " " in alternatives
    // or every pattern would match zero tests and force a full-suite scan.
    it('strips .test.ts file prefix and collapses " > " to spaces', () => {
        const result = buildTestNamePattern(['tests/foo.test.ts > Suite > adds 1']);
        expect(result).toBe('^(?:Suite adds 1)$');
    });

    it('strips .spec.ts file prefix', () => {
        const result = buildTestNamePattern(['tests/bar.spec.ts > Suite > works']);
        expect(result).toBe('^(?:Suite works)$');
    });

    it('strips .test.tsx file prefix', () => {
        const result = buildTestNamePattern(['tests/comp.test.tsx > Comp > renders']);
        expect(result).toBe('^(?:Comp renders)$');
    });

    it('strips .test.mjs file prefix', () => {
        const result = buildTestNamePattern(['tests/util.test.mjs > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .test.mts file prefix', () => {
        const result = buildTestNamePattern(['tests/util.test.mts > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .spec.mjs file prefix', () => {
        const result = buildTestNamePattern(['tests/util.spec.mjs > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .spec.mts file prefix', () => {
        const result = buildTestNamePattern(['tests/util.spec.mts > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .spec.jsx file prefix', () => {
        const result = buildTestNamePattern(['tests/comp.spec.jsx > Comp > renders']);
        expect(result).toBe('^(?:Comp renders)$');
    });

    it('strips .test.js file prefix', () => {
        const result = buildTestNamePattern(['tests/legacy.test.js > Suite > it works']);
        expect(result).toBe('^(?:Suite it works)$');
    });

    it('strips .spec.js file prefix', () => {
        const result = buildTestNamePattern(['tests/legacy.spec.js > Suite > it works']);
        expect(result).toBe('^(?:Suite it works)$');
    });

    it('strips .test.jsx file prefix', () => {
        const result = buildTestNamePattern(['tests/comp.test.jsx > Comp > renders']);
        expect(result).toBe('^(?:Comp renders)$');
    });

    it('strips .test.cts file prefix', () => {
        const result = buildTestNamePattern(['tests/util.test.cts > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .test.cjs file prefix', () => {
        const result = buildTestNamePattern(['tests/util.test.cjs > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .spec.cts file prefix', () => {
        const result = buildTestNamePattern(['tests/util.spec.cts > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('strips .spec.cjs file prefix', () => {
        const result = buildTestNamePattern(['tests/util.spec.cjs > Util > parses']);
        expect(result).toBe('^(?:Util parses)$');
    });

    it('collapses " > " to spaces even when no file-prefix is present', () => {
        const result = buildTestNamePattern(['Suite > bare']);
        expect(result).toBe('^(?:Suite bare)$');
    });

    it('strips trailing [N] dedup suffix', () => {
        const result = buildTestNamePattern(['tests/foo.test.ts > Suite > my test [3]']);
        expect(result).toBe('^(?:Suite my test)$');
    });

    it('collapses two IDs whose post-strip names are identical to one alternative', () => {
        const result = buildTestNamePattern([
            'tests/foo.test.ts > Suite > duplicate [0]',
            'tests/foo.test.ts > Suite > duplicate [1]',
        ]);
        // Both collapse to "Suite duplicate" — only one alternative
        expect(result).toBe('^(?:Suite duplicate)$');
    });

    it('preserves input order in the output alternatives', () => {
        const result = buildTestNamePattern([
            'tests/a.test.ts > A > first',
            'tests/b.test.ts > B > second',
            'tests/c.test.ts > C > third',
        ]);
        expect(result).toBe('^(?:A first|B second|C third)$');
    });

    it('collapses deep hierarchies of arbitrary depth', () => {
        const result = buildTestNamePattern(['tests/x.test.ts > A > B > C > D > leaf']);
        expect(result).toBe('^(?:A B C D leaf)$');
    });

    it('escapes regex metacharacters so new RegExp(result) matches the literal name', () => {
        // Build an ID containing every metacharacter that must be escaped.
        // The post-prefix name is: a . * + ? ^ $ { } ( ) | [ ] \ / b
        const specialCharsName = String.raw`a . * + ? ^ $ { } ( ) | [ ] \ / b`;
        const id = `tests/meta.test.ts > ${specialCharsName}`;
        const pattern = buildTestNamePattern([id]);

        expect(pattern).toBeDefined();

        // The regex constructed from the pattern must match the original unescaped name
        // when applied via new RegExp — proving the escaping is correct.

        const re = new RegExp(pattern!);
        expect(re.test(specialCharsName)).toBe(true);

        // And must NOT match a different string
        expect(re.test('a X b')).toBe(false);
    });

    it('strips exactly the " > " separator (3 chars) — not 1 or 2 chars', () => {
        // Kills UnaryOperator mutant that changes +3 to +1 in id.slice(firstSepIdx + 3).
        // With +1, the result would start with "> Suite" (includes the " > " chars).
        // With +3, it correctly starts with "Suite".
        const result = buildTestNamePattern(['tests/foo.test.ts > Suite > leaf']);
        // Correct: "Suite leaf" (prefix stripped, " > " collapsed to " ")
        expect(result).toBe('^(?:Suite leaf)$');
        // Sanity: must NOT contain the separator chars from the prefix boundary
        expect(result).not.toContain('> Suite');
    });

    it('returns undefined when all alternatives are empty after stripping', () => {
        // An ID that is only a file prefix with no name after it would be stripped to ''.
        // In practice this cannot be produced by buildUniqueTestName, but guard anyway.
        // We simulate by passing an empty string directly (no separator at all).
        expect(buildTestNamePattern([''])).toBeUndefined();
    });

    // Linux caps a single argv string at MAX_ARG_STRLEN (131,072 BYTES). The kernel
    // counts UTF-8 bytes, not JS chars, so these tests pin the byte-length cap and its
    // full-suite fallback (buildTestNamePattern returns undefined when over cap).
    it('returns the pattern when its byte length is exactly MAX_TEST_NAME_PATTERN_LENGTH', () => {
        const name = 'a'.repeat(MAX_TEST_NAME_PATTERN_LENGTH - '^(?:)$'.length);
        expect(buildTestNamePattern([name])).toBe(`^(?:${name})$`);
    });

    it('returns undefined when the pattern byte length would exceed MAX_TEST_NAME_PATTERN_LENGTH', () => {
        const name = 'a'.repeat(MAX_TEST_NAME_PATTERN_LENGTH - '^(?:)$'.length + 1);
        expect(buildTestNamePattern([name])).toBeUndefined();
    });

    it('compares UTF-8 bytes, not chars: multibyte names under the char cap but over the byte cap fall back', () => {
        // '★' (U+2605) is 1 UTF-16 code unit but 3 UTF-8 bytes; kernel argv limits are in bytes.
        const starCount = Math.ceil((MAX_TEST_NAME_PATTERN_LENGTH - '^(?:)$'.length + 1) / 3);
        const name = '★'.repeat(starCount);
        // Sanity: char length alone would slip under the cap — the byte comparison must catch it.
        expect(name.length + '^(?:)$'.length).toBeLessThanOrEqual(MAX_TEST_NAME_PATTERN_LENGTH);
        expect(buildTestNamePattern([name])).toBeUndefined();
    });
});

// ── buildTestNamePattern testNameIndex exact-lookup fast path ─────────────
//
// The single-arg call above is the never-worse-than-today contract: every
// case in that describe block must stay byte-identical whether or not this
// second, optional argument exists. These tests cover the fast path added
// on top: an exact-name registry keyed by the FULL Stryker test id (dedup
// suffix included) that, on a hit, bypasses the lossy " > "-collapsing
// reconstruction entirely.

describe('buildTestNamePattern — testNameIndex fast path', () => {
    it('index hit takes precedence over lossy reconstruction and is regex-escaped verbatim', () => {
        const testFilter = ['tests/foo.test.ts > Suite > weird test'];
        const index = new Map([
            ['tests/foo.test.ts > Suite > weird test', 'Suite > wei.rd $1 test'],
        ]);
        const result = buildTestNamePattern(testFilter, index);
        // Lossy reconstruction of this id would collapse " > " to " " and yield
        // "Suite weird test" — the literal " > " and the escaped "$1"/"." below
        // prove the exact bunName from the index was used verbatim, not the
        // lossy path.
        expect(result).toBe(String.raw`^(?:Suite > wei\.rd \$1 test)$`);
    });

    it('falls through to lossy reconstruction on an index miss, byte-identical to omitting the index entirely', () => {
        const testFilter = ['tests/foo.test.ts > Suite > adds 1'];
        const withoutIndex = buildTestNamePattern(testFilter);
        const withIndexMiss = buildTestNamePattern(testFilter, new Map([['some other id', 'irrelevant']]));
        expect(withIndexMiss).toBe(withoutIndex);
        expect(withIndexMiss).toBe('^(?:Suite adds 1)$');
    });

    it('mixes an index hit and a lossy-fallback miss in a single call, preserving order', () => {
        const testFilter = [
            'tests/a.test.ts > A > hit',
            'tests/b.test.ts > B > miss',
        ];
        const index = new Map([
            ['tests/a.test.ts > A > hit', 'A > raw hit'],
        ]);
        const result = buildTestNamePattern(testFilter, index);
        expect(result).toBe('^(?:A > raw hit|B miss)$');
    });

    it('keys the index by the FULL suffixed id so two structures collapsing to the same id each get their own alternative', () => {
        const testFilter = [
            'f.test.ts > A > B > t [0]',
            'f.test.ts > A > B > t [1]',
        ];
        const index = new Map([
            ['f.test.ts > A > B > t [0]', 'A B t'],   // nested describe A > describe B > test t
            ['f.test.ts > A > B > t [1]', 'A > B t'], // describe literally named "A > B" > test t
        ]);
        const result = buildTestNamePattern(testFilter, index);
        expect(result).toBe('^(?:A B t|A > B t)$');
    });

    it('Set-dedups two genuinely-duplicate titles that share one bunName to a single alternative', () => {
        // Two real it('same title') tests under the same describe: distinct
        // dedup-suffixed ids, but identical structure means identical bunName.
        // (Not built from it.each %s — bun 1.3.14 interpolates those names, so
        // template-literal duplicates no longer occur there.)
        const testFilter = [
            'tests/foo.test.ts > Suite > same title [0]',
            'tests/foo.test.ts > Suite > same title [1]',
        ];
        const index = new Map([
            ['tests/foo.test.ts > Suite > same title [0]', 'Suite same title'],
            ['tests/foo.test.ts > Suite > same title [1]', 'Suite same title'],
        ]);
        const result = buildTestNamePattern(testFilter, index);
        expect(result).toBe('^(?:Suite same title)$');
    });

    it('falls through to lossy reconstruction when the indexed bunName is an empty string', () => {
        const testFilter = ['tests/foo.test.ts > Suite > adds 1'];
        const index = new Map([['tests/foo.test.ts > Suite > adds 1', '']]);
        const result = buildTestNamePattern(testFilter, index);
        expect(result).toBe('^(?:Suite adds 1)$');
    });

    it('falls through to lossy reconstruction when the indexed bunName contains a NUL byte', () => {
        const testFilter = ['tests/foo.test.ts > Suite > adds 1'];
        const index = new Map([['tests/foo.test.ts > Suite > adds 1', 'Suite\u0000 adds 1']]);
        const result = buildTestNamePattern(testFilter, index);
        expect(result).toBe('^(?:Suite adds 1)$');
    });

    it('still returns undefined when an exact-hit bunName from the index pushes the pattern over the byte cap', () => {
        const bigName = 'a'.repeat(MAX_TEST_NAME_PATTERN_LENGTH);
        const testFilter = ['tests/foo.test.ts > Suite > huge'];
        const index = new Map([['tests/foo.test.ts > Suite > huge', bigName]]);
        expect(buildTestNamePattern(testFilter, index)).toBeUndefined();
    });

    it('an index keyed without the " [N]" suffix must MISS a suffixed filter id (pins the full-id keying contract)', () => {
        const testFilter = ['tests/foo.test.ts > Suite > dup [0]'];
        // Index keyed by the UNSUFFIXED id — must not match the suffixed filter id.
        const index = new Map([['tests/foo.test.ts > Suite > dup', 'Suite dup EXACT']]);
        const result = buildTestNamePattern(testFilter, index);
        // Falls through to lossy reconstruction (suffix stripped), NOT the exact value above.
        expect(result).toBe('^(?:Suite dup)$');
    });
});

// ── TEST_FILE_EXT_PATTERN (shared extension alternation) ───────────────────
//
// Single source of truth for the recognised test-file extension grammar,
// shared with console-parser's file-header regex so the two ends can never
// drift apart.

describe('TEST_FILE_EXT_PATTERN', () => {
    it('matches every recognised test-file extension suffix', () => {
        const re = new RegExp(`^${TEST_FILE_EXT_PATTERN}$`);
        const kinds = ['test', 'spec'];
        const exts = ['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'];
        for(const kind of kinds) {
            for(const ext of exts) {
                expect(re.test(`${kind}.${ext}`)).toBe(true);
            }
        }
    });

    it('rejects non-test-file suffixes', () => {
        const re = new RegExp(`^${TEST_FILE_EXT_PATTERN}$`);
        for(const bad of ['tests.ts', 'test.tsxx', 'test.mtsx', 'test.d.ts', 'spec.md', 'test_ts', 'foo.ts']) {
            expect(re.test(bad)).toBe(false);
        }
    });
});
