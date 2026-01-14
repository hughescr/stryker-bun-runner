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

  describe('bail mode output parsing', () => {
    it('should parse (fail) format failures with duration', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
(fail) should catch mutation [0.08ms]
  error: Expected true but got false
  at /path/to/test.ts:10:15

Bailed out after 1 failure
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(1);
      expect(result.totalTests).toBe(1);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0]).toMatchObject({
        name: 'tests/example.test.ts > should catch mutation',
        status: 'failed',
        duration: 0.08,
        file: 'tests/example.test.ts',
      });
      expect(result.tests[0].failureMessage).toContain('Expected true but got false');
    });

    it('should parse (fail) format without duration', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
(fail) should catch mutation
  error: Expected true but got false

Bailed out after 1 failure
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(1);
      expect(result.tests[0]).toMatchObject({
        name: 'tests/example.test.ts > should catch mutation',
        status: 'failed',
        file: 'tests/example.test.ts',
      });
      expect(result.tests[0].duration).toBeUndefined();
      expect(result.tests[0].failureMessage).toContain('Expected true but got false');
    });

    it('should handle bail summary count', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
(fail) should catch mutation [0.08ms]
  error: Expected true but got false

Bailed out after 1 failure
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(1);
      expect(result.totalTests).toBe(1);
    });

    it('should handle multiple failures in bail summary', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
(fail) should catch first mutation [0.08ms]
  error: First failure
(fail) should catch second mutation [0.05ms]
  error: Second failure

Bailed out after 2 failures
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(2);
      expect(result.totalTests).toBe(2);
      expect(result.tests).toHaveLength(2);
      expect(result.tests[0].failureMessage).toContain('First failure');
      expect(result.tests[1].failureMessage).toContain('Second failure');
    });
  });

  describe('error message finalization transitions', () => {
    it('should finalize error message when pass follows fail', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail first [0.05ms]
  error: First test failure
  at /path/to/test.ts:10:15
✓ should pass after fail [0.12ms]

 1 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(1);
      expect(result.passed).toBe(1);
      expect(result.totalTests).toBe(2);
      expect(result.tests).toHaveLength(2);

      // Verify first test's error message was finalized before second test
      expect(result.tests[0].status).toBe('failed');
      expect(result.tests[0].failureMessage).toContain('First test failure');
      expect(result.tests[0].failureMessage).not.toContain('should pass');

      expect(result.tests[1].status).toBe('passed');
      expect(result.tests[1].failureMessage).toBeUndefined();
    });

    it('should finalize error message when skip follows fail', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail first [0.05ms]
  error: Test failure message
  at /path/to/test.ts:10:15
⏭ should skip after fail

 0 pass
 1 fail
 1 skip
`;
      const result = parseBunTestOutput(output, '');

      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.totalTests).toBe(2);
      expect(result.tests).toHaveLength(2);

      // Verify error message was finalized
      expect(result.tests[0].status).toBe('failed');
      expect(result.tests[0].failureMessage).toContain('Test failure message');
      expect(result.tests[0].failureMessage).not.toContain('should skip');

      expect(result.tests[1].status).toBe('skipped');
      expect(result.tests[1].failureMessage).toBeUndefined();
    });

    it('should finalize error message with multi-line errors before next test', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail with complex error [0.15ms]
  error: Expected object to match
  Expected: { foo: 'bar' }
  Received: { foo: 'baz' }
  at /path/to/test.ts:15:20
✓ should pass after complex error [0.08ms]

 1 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      expect(result.tests[0].status).toBe('failed');
      expect(result.tests[0].failureMessage).toContain('Expected object to match');
      expect(result.tests[0].failureMessage).toContain('Expected: { foo: \'bar\' }');
      expect(result.tests[0].failureMessage).toContain('Received: { foo: \'baz\' }');
      expect(result.tests[0].failureMessage).not.toContain('should pass');

      expect(result.tests[1].status).toBe('passed');
    });
  });

  describe('Ran N tests fallback parsing', () => {
    it('should use Ran N tests when no pass/fail counts available', () => {
      const output = `
bun test v1.1.0

Ran 5 tests across 2 files. [123.00ms]
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.totalTests).toBe(5);
    });

    it('should not override existing counts from Ran N tests', () => {
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms]
✗ should fail [0.05ms]
  error: Test failed

 1 pass
 1 fail
Ran 2 tests across 1 files. [123.00ms]
`;
      const result = parseBunTestOutput(output, '');

      // Should preserve parsed counts, not override with Ran total
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.totalTests).toBe(2);
    });

    it('should handle singular "Ran 1 test" format', () => {
      const output = `
bun test v1.1.0

Ran 1 test across 1 files. [50.00ms]
`;
      const result = parseBunTestOutput(output, '');

      expect(result.passed).toBe(1);
      expect(result.totalTests).toBe(1);
    });

    it('should prefer summary counts over Ran N tests fallback', () => {
      const output = `
bun test v1.1.0

 3 pass
 2 fail
Ran 5 tests across 1 files. [100.00ms]
`;
      const result = parseBunTestOutput(output, '');

      // Summary counts should be used, Ran line is consistent
      expect(result.passed).toBe(3);
      expect(result.failed).toBe(2);
      expect(result.totalTests).toBe(5);
    });
  });

  describe('regex anchor mutation tests', () => {
    it('should not match file header with trailing content after colon', () => {
      // This test kills the mutation that removes $ from the file header regex
      // The $ anchor ensures the line must END with just a colon, nothing after
      // Without the $ anchor, "tests/example.test.ts: extra" would incorrectly match
      const output = `
bun test v1.1.0

tests/example.test.ts: extra content here
✓ should pass [0.12ms]

 1 pass
`;
      const result = parseBunTestOutput(output, '');

      // File header should not match because $ anchor requires line to end with just ':'
      // So test name should not include file prefix
      expect(result.tests[0].name).toBe('should pass');
      expect(result.tests[0].file).toBeUndefined();
    });

    it('should not match test result with trailing content after duration', () => {
      // This test kills the mutation that removes $ from the pass/fail regex
      // If $ is removed, "✓ test [1ms] extra" would match when it shouldn't
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms] extra content
✓ should also pass [0.05ms]

 2 pass
`;
      const result = parseBunTestOutput(output, '');

      // First line should not match as a test due to trailing content
      // Only the second test should be parsed
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].name).toBe('tests/example.test.ts > should also pass');
    });
  });

  describe('state initialization mutation tests', () => {
    it('should start with clean error collection state', () => {
      // This test kills mutations on line 53 (collectingError = false → true)
      // and line 54 (errorLines = [] → ["Stryker was here"])
      // If collectingError starts as true or errorLines is pre-populated,
      // a passing test at the start would incorrectly collect errors
      const output = `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms]

 1 pass
`;
      const result = parseBunTestOutput(output, '');

      // Passing test should have no failure message
      expect(result.tests[0].failureMessage).toBeUndefined();
    });

    it('should not carry over error state between invocations', () => {
      // Test that each call to parseBunTestOutput starts fresh
      const failOutput = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail [0.05ms]
  error: Test failed

 0 pass
 1 fail
`;
      const passOutput = `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms]

 1 pass
`;

      // First call with failure
      const result1 = parseBunTestOutput(failOutput, '');
      expect(result1.tests[0].failureMessage).toContain('Test failed');

      // Second call with pass should not have error from first call
      const result2 = parseBunTestOutput(passOutput, '');
      expect(result2.tests[0].failureMessage).toBeUndefined();
    });
  });

  describe('stdout/stderr separator mutation tests', () => {
    it('should preserve newline separator between stdout and stderr', () => {
      // This test kills the mutation on line 49 where '\n' is replaced with ""
      // Without the newline, output lines could incorrectly merge
      const stdout = `bun test v1.1.0

tests/example.test.ts:
✓ first test [0.12ms]`;
      const stderr = `✓ second test [0.05ms]`;

      const result = parseBunTestOutput(stdout, stderr);

      // Without newline separator, the lines would merge and second test
      // would be appended directly to first test line, causing parsing issues
      // With proper newline, both tests should parse correctly
      expect(result.tests).toHaveLength(2);
      expect(result.tests[0].name).toBe('tests/example.test.ts > first test');
      expect(result.tests[1].name).toBe('tests/example.test.ts > second test');
    });

    it('should handle stderr error messages with proper line breaks', () => {
      // Test that stderr errors are properly separated from stdout
      const stdout = `bun test v1.1.0

tests/example.test.ts:
✗ should fail [0.05ms]`;
      const stderr = `  error: Assertion failed
  at /path/to/test.ts:10:15`;

      const result = parseBunTestOutput(stdout, stderr);

      // Error message from stderr should be properly captured
      expect(result.tests[0].failureMessage).toContain('Assertion failed');
      expect(result.tests[0].failureMessage).toContain('at /path/to/test.ts:10:15');
    });
  });

  describe('error message trimming mutation tests', () => {
    it('should trim whitespace from error messages', () => {
      // This test kills mutations on line 71 and 94 where .trim() is removed
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail [0.05ms]
  error: Test failed

 0 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      // Error message should be trimmed (no trailing spaces)
      expect(result.tests[0].failureMessage).toBe('error: Test failed');
      expect(result.tests[0].failureMessage).not.toMatch(/\s+$/);
    });

    it('should handle error messages with leading and trailing whitespace', () => {
      // Test that both leading and trailing whitespace is removed
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail [0.05ms]

  error: Test failed

✓ should pass [0.12ms]

 1 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      // Error should be trimmed of surrounding blank lines
      expect(result.tests[0].failureMessage).toBe('error: Test failed');
      // Should not have leading or trailing newlines
      expect(result.tests[0].failureMessage).not.toMatch(/^\s/);
      expect(result.tests[0].failureMessage).not.toMatch(/\s$/);
    });

    it('should join error lines with newlines', () => {
      // This test kills the mutation on line 71 and 169 where '\n' is changed in join()
      // Without '\n' separator, error lines would be concatenated without breaks
      const output = `
bun test v1.1.0

tests/example.test.ts:
✗ should fail [0.05ms]
  error: Line 1
  error: Line 2
  error: Line 3

 0 pass
 1 fail
`;
      const result = parseBunTestOutput(output, '');

      // Error lines should be joined with newlines, not empty strings
      // Note: final .trim() removes leading/trailing whitespace from the entire message,
      // but newlines between lines are preserved
      expect(result.tests[0].failureMessage).toBe('error: Line 1\n  error: Line 2\n  error: Line 3');
      expect(result.tests[0].failureMessage).toContain('\n');
      // Verify we have multiple lines (mutation would make it single line)
      expect(result.tests[0].failureMessage?.split('\n')).toHaveLength(3);
    });
  });

  describe('regex anchor edge cases', () => {
    it('should not match pass result with prefix', () => {
      // The ^ anchor ensures ✓ must be at start of line
      const output = `bun test v1.1.0

tests/example.test.ts:
prefix ✓ test name [1ms]

 1 pass`;
      const result = parseBunTestOutput(output, '');
      // Should not match the checkmark that has prefix
      expect(result.tests).toHaveLength(0);
    });

    it('should not match pass result with suffix', () => {
      // The $ anchor ensures line must end with ms]
      const output = `bun test v1.1.0

tests/example.test.ts:
✓ test name [1ms] suffix

 1 pass`;
      const result = parseBunTestOutput(output, '');
      // Should not match because of suffix after duration
      expect(result.tests).toHaveLength(0);
    });

    it('should not match fail result with prefix', () => {
      // The ^ anchor ensures ✗ must be at start of line
      const output = `bun test v1.1.0

tests/example.test.ts:
prefix ✗ test name [1ms]

 0 pass
 1 fail`;
      const result = parseBunTestOutput(output, '');
      // Should not match the X mark that has prefix
      expect(result.tests).toHaveLength(0);
    });

    it('should not match skip result with prefix', () => {
      // The ^ anchor ensures ⏭ must be at start of line
      const output = `bun test v1.1.0

tests/example.test.ts:
prefix ⏭ test name

 0 pass
 1 skip`;
      const result = parseBunTestOutput(output, '');
      // Should not match the skip symbol that has prefix
      expect(result.tests).toHaveLength(0);
    });

    it('should not match bail fail result with prefix', () => {
      // The ^ anchor ensures (fail) must be at start of line
      const output = `bun test v1.1.0

tests/example.test.ts:
prefix (fail) test name [1ms]

Bailed out after 1 failure`;
      const result = parseBunTestOutput(output, '');
      // Should not match the (fail) that has prefix
      expect(result.tests).toHaveLength(0);
    });

    it('should NOT match file header with prefix (fixed greedy capture)', () => {
      // FIXED: The file header regex now uses [\w./-]+ which only matches valid path characters
      // So "some prefix tests/example.test.ts:" will NOT match because "some prefix " contains spaces
      // This prevents matching error output lines like "111 |         // Match file header: tests/example.test.ts:"
      const output = `bun test v1.1.0

some prefix tests/example.test.ts:
✓ test [1ms]

 1 pass`;
      const result = parseBunTestOutput(output, '');
      // Should NOT match because of the prefix
      expect(result.tests[0].file).toBeUndefined();
      expect(result.tests[0].name).toBe('test');
    });

    it('should not match file header with suffix text after colon', () => {
      // The $ anchor ensures line must end with : (no suffix after colon)
      const output = `bun test v1.1.0

tests/example.test.ts: some suffix
✓ test [1ms]

 1 pass`;
      const result = parseBunTestOutput(output, '');
      // Should NOT match because line doesn't end with just ':'
      expect(result.tests[0].file).toBeUndefined();
      expect(result.tests[0].name).toBe('test');
    });
  });
});
