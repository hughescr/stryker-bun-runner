/**
 * Unit tests for console-parser
 * Tests the Bun test output parsing functionality
 */

import { describe, it, expect } from 'bun:test';
import { parseBunTestOutput } from '../../src/parsers/console-parser.js';

describe('parseBunTestOutput', () => {
  describe('passing tests', () => {
    it('should parse single passing test', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should add numbers [0.12ms]

 1 pass
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.totalTests).toBe(1);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0]).toEqual({
        name: 'tests/example.test.ts > should add numbers',
        status: 'passed',
        duration: 0.12,
        file: 'tests/example.test.ts',
      });
    });

    it('should parse multiple passing tests', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should add numbers [0.12ms]
✓ should subtract numbers [0.05ms]
✓ should multiply numbers [0.08ms]

 3 pass
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.totalTests).toBe(3);
      expect(result.tests).toHaveLength(3);
      expect(result.tests[0].name).toBe('tests/example.test.ts > should add numbers');
      expect(result.tests[1].name).toBe('tests/example.test.ts > should subtract numbers');
      expect(result.tests[2].name).toBe('tests/example.test.ts > should multiply numbers');
    });
  });

  describe('failing tests', () => {
    it('should parse single failing test with error message', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should multiply numbers [0.08ms]
  error: Expected 6 but received 5
  at /path/to/test.ts:10:15

 0 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.totalTests).toBe(1);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0]).toMatchObject({
        name: 'tests/example.test.ts > should multiply numbers',
        status: 'failed',
        duration: 0.08,
        file: 'tests/example.test.ts',
      });
      expect(result.tests[0].failureMessage).toContain('Expected 6 but received 5');
    });

    it('should parse failing test without duration', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail
  error: Test failed

 0 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(1);
      expect(result.tests[0]).toMatchObject({
        name: 'tests/example.test.ts > should fail',
        status: 'failed',
        file: 'tests/example.test.ts',
      });
      expect(result.tests[0].duration).toBeUndefined();
    });

    it('should parse multi-line error messages', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should handle complex errors [0.15ms]
  error: Expected object to match
  Expected: { foo: 'bar' }
  Received: { foo: 'baz' }
  at /path/to/test.ts:15:20

 0 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      expect(result.tests[0].failureMessage).toContain('Expected object to match');
      expect(result.tests[0].failureMessage).toContain('Expected: { foo: \'bar\' }');
      expect(result.tests[0].failureMessage).toContain('Received: { foo: \'baz\' }');
    });
  });

  describe('skipped tests', () => {
    it('should parse single skipped test', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
⏭ should divide numbers

 0 pass
 0 fail
 1 skip
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.totalTests).toBe(1);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0]).toEqual({
        name: 'tests/example.test.ts > should divide numbers',
        status: 'skipped',
        file: 'tests/example.test.ts',
      });
    });

    it('should parse multiple skipped tests', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
⏭ should test feature A
⏭ should test feature B

 0 pass
 0 fail
 2 skip
`;
      const result = parseBunTestOutput(output, '');

      expect(result.skipped).toBe(2);
      expect(result.totalTests).toBe(2);
      expect(result.tests).toHaveLength(2);
    });
  });

  describe('mixed test results', () => {
    it('should parse output with all test types', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should add numbers [0.12ms]
✓ should subtract numbers [0.05ms]
✗ should multiply numbers [0.08ms]
  error: Expected 6 but received 5
⏭ should divide numbers

 2 pass
 1 fail
 1 skip
 4 expect() calls
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.totalTests).toBe(4);
      expect(result.tests).toHaveLength(4);

      expect(result.tests[0].status).toBe('passed');
      expect(result.tests[1].status).toBe('passed');
      expect(result.tests[2].status).toBe('failed');
      expect(result.tests[3].status).toBe('skipped');
    });

    it('should handle multiple failing tests in sequence', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ first failure [0.05ms]
  error: First error message
✗ second failure [0.08ms]
  error: Second error message

 0 pass
 2 fail
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(2);
      expect(result.tests).toHaveLength(2);
      expect(result.tests[0].failureMessage).toContain('First error message');
      expect(result.tests[1].failureMessage).toContain('Second error message');
    });
  });

  describe('edge cases', () => {
    it('should handle empty output', () => {
      const result = parseBunTestOutput('', '');

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.totalTests).toBe(0);
      expect(result.tests).toHaveLength(0);
    });

    it('should handle output with no test results', () => {
      const output = `
bun test v1.1.0

 0 pass
 0 fail
 0 skip
`;
      const result = parseBunTestOutput(output, '');

      expect(result.totalTests).toBe(0);
      expect(result.tests).toHaveLength(0);
    });

    it('should parse stderr as well as stdout', () => {
      const stdout = `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms]

 1 pass
`;
      const stderr = 'Some warning message\n';
      const result = parseBunTestOutput(stdout, stderr);

      expect(result.passed).toBe(1);
      expect(result.tests).toHaveLength(1);
    });

    it('should handle test names with special characters', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should handle "quotes" and 'apostrophes' [0.12ms]
✓ should handle (parentheses) and [brackets] [0.05ms]
✓ should handle dots.and.underscores_here [0.08ms]

 3 pass
`;
      const result = parseBunTestOutput(output, '');

      expect(result.tests[0].name).toBe('tests/example.test.ts > should handle "quotes" and \'apostrophes\'');
      expect(result.tests[1].name).toBe('tests/example.test.ts > should handle (parentheses) and [brackets]');
      expect(result.tests[2].name).toBe('tests/example.test.ts > should handle dots.and.underscores_here');
    });

    it('should use summary numbers when individual tests are not parsed', () => {
      const output = `
bun test v1.1.0

 10 pass
 2 fail
 3 skip
`;
      const result = parseBunTestOutput(output, '');

      // Should fall back to summary numbers
      expect(result.passed).toBe(10);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(3);
      expect(result.totalTests).toBe(15);
    });

    it('should handle whitespace variations', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓   should handle extra spaces   [0.12ms]

 1 pass
`;
      const result = parseBunTestOutput(output, '');

      expect(result.tests[0].name).toBe('tests/example.test.ts > should handle extra spaces');
    });

    it('should handle tests from multiple files', () => {
      const output = `
bun test v1.1.0

tests/file1.test.ts:
✓ test from file 1 [0.12ms]

tests/file2.test.ts:
✓ test from file 2 [0.05ms]

 2 pass
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(2);
      expect(result.tests).toHaveLength(2);
      expect(result.tests[0].name).toBe('tests/file1.test.ts > test from file 1');
      expect(result.tests[1].name).toBe('tests/file2.test.ts > test from file 2');
    });
  });

  describe('duration parsing', () => {
    it('should parse millisecond durations correctly', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ fast test [0.12ms]
✓ slower test [15.67ms]
✓ very slow test [1234.56ms]

 3 pass
`;
      const result = parseBunTestOutput(output, '');

      expect(result.tests[0].duration).toBe(0.12);
      expect(result.tests[1].duration).toBe(15.67);
      expect(result.tests[2].duration).toBe(1234.56);
    });
  });
});
