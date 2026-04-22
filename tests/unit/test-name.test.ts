/**
 * Unit tests for test-name utility functions.
 * Imported directly from the canonical module so a future barrel removal
 * does not break these tests.
 */

import { describe, it, expect } from 'bun:test';
import { normalizeTestFilePath, normalizeTestName, buildUniqueTestName } from '../../src/utils/test-name.js';

describe('normalizeTestFilePath', () => {
    it('returns undefined for undefined input', () => {
        expect(normalizeTestFilePath(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
        expect(normalizeTestFilePath('')).toBeUndefined();
    });

    it('extracts path after .stryker-tmp/sandbox-XXXXX/', () => {
        const input = '/path/to/project/.stryker-tmp/sandbox-ABC123/tests/unit/foo.test.ts';
        expect(normalizeTestFilePath(input)).toBe('tests/unit/foo.test.ts');
    });

    it('handles various sandbox IDs', () => {
        const input = '/project/.stryker-tmp/sandbox-12345678/src/test.ts';
        expect(normalizeTestFilePath(input)).toBe('src/test.ts');
    });

    it('returns original path if no sandbox pattern', () => {
        const input = 'tests/unit/foo.test.ts';
        expect(normalizeTestFilePath(input)).toBe('tests/unit/foo.test.ts');
    });

    it('handles absolute paths without sandbox', () => {
        const input = '/absolute/path/to/file.ts';
        expect(normalizeTestFilePath(input)).toBe('/absolute/path/to/file.ts');
    });
});

describe('normalizeTestName', () => {
    it('keeps printable ASCII characters unchanged', () => {
        const input = 'Suite > Test name with spaces and punctuation!?.,;:\'"-_()[]{}@#$%&*+=/<>|~`';
        expect(normalizeTestName(input)).toBe(input);
    });

    it('replaces newlines with underscores', () => {
        expect(normalizeTestName('Line 1\nLine 2')).toBe('Line 1_Line 2');
        expect(normalizeTestName('Line 1\r\nLine 2')).toBe('Line 1__Line 2');
    });

    it('replaces tabs with underscores', () => {
        expect(normalizeTestName('Part1\tPart2')).toBe('Part1_Part2');
    });

    it('replaces control characters with underscores', () => {
        expect(normalizeTestName('before\x00after')).toBe('before_after');
        expect(normalizeTestName('before\x1Fafter')).toBe('before_after');
    });

    it('preserves unicode characters verbatim', () => {
        // Unicode letters (café) and non-latin scripts must round-trip so the
        // normalized form matches Bun's internal test-name format, which keeps
        // unicode as-is. Emoji (surrogate pair) also preserved.
        expect(normalizeTestName('café')).toBe('café');
        expect(normalizeTestName('日本語')).toBe('日本語');
        expect(normalizeTestName('emoji 😀 test')).toBe('emoji 😀 test');
    });

    it('preserves the em-dash (U+2014) used in describe names', () => {
        // This is the concrete regression that caused every filtered mutant
        // run to match zero tests when a project uses an em-dash separator.
        expect(normalizeTestName('createWebViewAdapter — lazy init')).toBe('createWebViewAdapter — lazy init');
        expect(normalizeTestName('A › B → C')).toBe('A › B → C');
    });

    it('preserves character count (1:1 replacement)', () => {
        const input = 'a\n\nb'; // 4 chars: a, \n, \n, b
        const output = normalizeTestName(input);
        expect(output).toBe('a__b');
        expect(output.length).toBe(4);
    });

    it('handles empty string', () => {
        expect(normalizeTestName('')).toBe('');
    });

    it('handles string with only unsafe characters', () => {
        expect(normalizeTestName('\n\t\r')).toBe('___');
    });

    it('preserves the > hierarchy separator', () => {
        expect(normalizeTestName('Suite > Nested > Test')).toBe('Suite > Nested > Test');
    });

    it('trims leading and trailing whitespace', () => {
        expect(normalizeTestName(' test ')).toBe('test');
        expect(normalizeTestName('  multiple spaces  ')).toBe('multiple spaces');
        expect(normalizeTestName(' leading')).toBe('leading');
        expect(normalizeTestName('trailing ')).toBe('trailing');
    });
});

describe('buildUniqueTestName', () => {
    it('includes file path when URL is provided', () => {
        const fullName = 'Suite > test';
        const url = 'file:///path/.stryker-tmp/sandbox-ABC123/tests/unit/foo.test.ts';
        expect(buildUniqueTestName(fullName, url)).toBe('tests/unit/foo.test.ts > Suite > test');
    });

    it('returns just normalized name when URL is undefined', () => {
        const fullName = 'Suite > test';
        expect(buildUniqueTestName(fullName, undefined)).toBe('Suite > test');
    });

    it('strips sandbox path from file URL', () => {
        const fullName = 'My Suite > My Test';
        const url = 'file:///Users/me/project/.stryker-tmp/sandbox-XYZ789/src/utils.test.ts';
        expect(buildUniqueTestName(fullName, url)).toBe('src/utils.test.ts > My Suite > My Test');
    });

    it('normalizes special characters in both path and name', () => {
        const fullName = 'Suite\nwith\nnewlines > test\twith\ttabs';
        const url = 'file:///.stryker-tmp/sandbox-123/path/to/file.test.ts';
        expect(buildUniqueTestName(fullName, url)).toBe('path/to/file.test.ts > Suite_with_newlines > test_with_tabs');
    });

    it('handles deeply nested test hierarchies', () => {
        const fullName = 'Level1 > Level2 > Level3 > Level4 > test';
        const url = 'file:///.stryker-tmp/sandbox-ABC/tests/deep/nested.test.ts';
        expect(buildUniqueTestName(fullName, url)).toBe('tests/deep/nested.test.ts > Level1 > Level2 > Level3 > Level4 > test');
    });

    it('handles file paths without sandbox pattern', () => {
        const fullName = 'Suite > test';
        const url = 'file:///direct/path/tests/file.test.ts';
        expect(buildUniqueTestName(fullName, url)).toBe('file:///direct/path/tests/file.test.ts > Suite > test');
    });

    it('preserves unicode characters in path and name', () => {
        // Unicode is preserved verbatim so the id matches Bun's internal test
        // name exactly (bun reports describe/test names as written in source).
        const fullName = 'café > test';
        const url = 'file:///.stryker-tmp/sandbox-123/tests/café.test.ts';
        expect(buildUniqueTestName(fullName, url)).toBe('tests/café.test.ts > café > test');
    });

    it('handles empty string URL', () => {
        const fullName = 'Suite > test';
        expect(buildUniqueTestName(fullName, '')).toBe('Suite > test');
    });

    it('preserves original behavior when normalizeTestFilePath returns undefined', () => {
        const fullName = 'Suite > test';
        const url = undefined;
        expect(buildUniqueTestName(fullName, url)).toBe('Suite > test');
    });
});
