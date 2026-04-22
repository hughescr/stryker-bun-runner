/**
 * Unit tests for buildTestNamePattern
 */

import { describe, it, expect } from 'bun:test';
import { buildTestNamePattern } from '../../src/utils/test-name-pattern.js';

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
        const specialCharsName = 'a . * + ? ^ $ { } ( ) | [ ] \\ / b';
        const id = `tests/meta.test.ts > ${specialCharsName}`;
        const pattern = buildTestNamePattern([id]);

        expect(pattern).toBeDefined();

        // The regex constructed from the pattern must match the original unescaped name
        // when applied via new RegExp — proving the escaping is correct.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted defined above
        const re = new RegExp(pattern!);
        expect(re.test(specialCharsName)).toBe(true);

        // And must NOT match a different string
        expect(re.test('a X b')).toBe(false);
    });

    it('returns undefined when all alternatives are empty after stripping', () => {
        // An ID that is only a file prefix with no name after it would be stripped to ''.
        // In practice this cannot be produced by buildUniqueTestName, but guard anyway.
        // We simulate by passing an empty string directly (no separator at all).
        expect(buildTestNamePattern([''])).toBeUndefined();
    });
});
