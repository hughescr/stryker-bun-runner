/**
 * Unit tests for junit-parser
 * Tests the JUnit XML parsing functionality from Bun's --reporter=junit
 */

import { describe, it, expect } from 'bun:test';
import { parseJunitXml } from '../../src/parsers/junit-parser.js';

describe('parseJunitXml', () => {
  describe('basic parsing', () => {
    it('should parse simple testcase element', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/example.test.ts" file="tests/example.test.ts" tests="1">
    <testcase name="should add numbers" file="tests/example.test.ts" line="10" time="0.001524" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'should add numbers',
        fullName: 'should add numbers',
        fileName: 'tests/example.test.ts',
        line: 10,
        time: 0.001524,
        passed: true,
        failureMessage: undefined,
      });
    });

    it('should extract name, file, line, time attributes', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="file.test.ts" file="file.test.ts">
    <testcase name="test name" file="path/to/file.test.ts" line="25" time="0.123" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test name');
      expect(result[0].fileName).toBe('path/to/file.test.ts');
      expect(result[0].line).toBe(25);
      expect(result[0].time).toBe(0.123);
    });

    it('should verify passed status for testcase without failure element', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="passing test" file="test.ts" line="5" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].passed).toBe(true);
      expect(result[0].failureMessage).toBeUndefined();
    });
  });

  describe('hierarchy building', () => {
    it('should parse nested testsuite elements to build fullName', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/unit/foo.test.ts" file="tests/unit/foo.test.ts">
    <testsuite name="FooClass" file="tests/unit/foo.test.ts" line="15">
      <testsuite name="methodName" file="tests/unit/foo.test.ts" line="20">
        <testcase name="should do something" file="tests/unit/foo.test.ts" line="25" time="0.001524" />
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('should do something');
      expect(result[0].fullName).toBe('FooClass > methodName > should do something');
    });

    it('should test with multiple levels of nesting', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="file.test.ts" file="file.test.ts">
    <testsuite name="A" line="10">
      <testsuite name="B" line="20">
        <testsuite name="C" line="30">
          <testcase name="test name" file="file.test.ts" line="35" time="0.001" />
        </testsuite>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].fullName).toBe('A > B > C > test name');
    });

    it('should not include file testsuite name in hierarchy', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/example.test.ts" file="tests/example.test.ts">
    <testsuite name="DescribeBlock" line="10">
      <testcase name="test" file="tests/example.test.ts" line="15" time="0.001" />
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      // File name should not be in hierarchy, only describe block
      expect(result[0].fullName).toBe('DescribeBlock > test');
    });

    it('should handle multiple tests at different hierarchy levels', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="file.test.ts" file="file.test.ts">
    <testsuite name="Outer" line="5">
      <testcase name="test1" file="file.test.ts" line="10" time="0.001" />
      <testsuite name="Inner" line="15">
        <testcase name="test2" file="file.test.ts" line="20" time="0.001" />
      </testsuite>
      <testcase name="test3" file="file.test.ts" line="25" time="0.001" />
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(3);
      expect(result[0].fullName).toBe('Outer > test1');
      expect(result[1].fullName).toBe('Outer > Inner > test2');
      expect(result[2].fullName).toBe('Outer > test3');
    });
  });

  describe('failed tests', () => {
    it('should parse testcase with failure child element', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="should fail" file="test.ts" line="10" time="0.002">
      <failure message="expected 1 to equal 2">AssertionError: expected 1 to equal 2</failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].passed).toBe(false);
      expect(result[0].failureMessage).toBe('AssertionError: expected 1 to equal 2');
    });

    it('should extract failure message', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="failing test" file="test.ts" line="15" time="0.001">
      <failure message="Test failed">Error: Something went wrong</failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].failureMessage).toBe('Error: Something went wrong');
    });

    it('should handle multi-line failure messages', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="complex failure" file="test.ts" line="20" time="0.003">
      <failure message="expected object to match">
Expected: { foo: 'bar' }
Received: { foo: 'baz' }
at /path/to/test.ts:20:15
      </failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].passed).toBe(false);
      expect(result[0].failureMessage).toContain('Expected: { foo: \'bar\' }');
      expect(result[0].failureMessage).toContain('Received: { foo: \'baz\' }');
      expect(result[0].failureMessage).toContain('at /path/to/test.ts:20:15');
    });
  });

  describe('XML entity unescaping', () => {
    it('should handle &gt; in names', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="a &gt; b" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].name).toBe('a > b');
    });

    it('should handle &lt; in names', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="a &lt; b" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].name).toBe('a < b');
    });

    it('should handle &amp; in names', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="foo &amp; bar" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].name).toBe('foo & bar');
    });

    it('should handle &quot; in names', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="say &quot;hello&quot;" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].name).toBe('say "hello"');
    });

    it('should handle &apos; in names', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="it&apos;s working" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].name).toBe("it's working");
    });

    it('should handle entities in failure messages', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test" file="test.ts" line="10" time="0.001">
      <failure>Expected &lt;div&gt; but got &amp;nbsp;</failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].failureMessage).toBe('Expected <div> but got &nbsp;');
    });

    it('should handle multiple entities in single string', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="&quot;foo&quot; &amp; &apos;bar&apos; &lt; &gt;" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].name).toBe('"foo" & \'bar\' < >');
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty XML string', () => {
      const result = parseJunitXml('');

      expect(result).toEqual([]);
    });

    it('should return empty array for invalid XML', () => {
      const xml = 'not valid xml at all <unclosed tag';

      const result = parseJunitXml(xml);

      expect(result).toEqual([]);
    });

    it('should return empty array for malformed XML', () => {
      const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="test">
    <testcase name="test"
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toEqual([]);
    });

    it('should handle self-closing testcase elements', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test1" file="test.ts" line="10" time="0.001" />
    <testcase name="test2" file="test.ts" line="15" time="0.002"/>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('test1');
      expect(result[1].name).toBe('test2');
    });

    it('should handle multiple test files', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/file1.test.ts" file="tests/file1.test.ts">
    <testcase name="test from file 1" file="tests/file1.test.ts" line="10" time="0.001" />
  </testsuite>
  <testsuite name="tests/file2.test.ts" file="tests/file2.test.ts">
    <testcase name="test from file 2" file="tests/file2.test.ts" line="20" time="0.002" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(2);
      expect(result[0].fileName).toBe('tests/file1.test.ts');
      expect(result[0].name).toBe('test from file 1');
      expect(result[1].fileName).toBe('tests/file2.test.ts');
      expect(result[1].name).toBe('test from file 2');
    });

    it('should handle testcase without name attribute', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase file="test.ts" line="10" time="0.001" />
    <testcase name="valid test" file="test.ts" line="15" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      // Should skip testcase without name
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid test');
    });

    it('should handle missing time attribute', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test without time" file="test.ts" line="10" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].time).toBe(0);
    });

    it('should handle missing line attribute', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test without line" file="test.ts" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].line).toBe(0);
    });

    it('should use current file from parent testsuite when testcase has no file', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="parent.test.ts" file="parent.test.ts">
    <testsuite name="Describe" line="10">
      <testcase name="test" line="15" time="0.001" />
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].fileName).toBe('parent.test.ts');
    });

    it('should handle self-closing testsuite', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="empty.test.ts" file="empty.test.ts" tests="0" />
  <testsuite name="real.test.ts" file="real.test.ts">
    <testcase name="test" file="real.test.ts" line="5" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('real.test.ts');
    });

    it('should update current file from self-closing testsuite', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="first.test.ts" file="first.test.ts" tests="0" />
  <testsuite name="Describe">
    <testcase name="test without file" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      // Test should inherit file from self-closing testsuite
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('first.test.ts');
    });
  });

  describe('real Bun output example', () => {
    it('should parse realistic Bun JUnit output', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="137" time="0.499907">
  <testsuite name="tests/unit/foo.test.ts" file="tests/unit/foo.test.ts" tests="5">
    <testsuite name="FooClass" file="tests/unit/foo.test.ts" line="15" tests="5">
      <testsuite name="methodName" file="tests/unit/foo.test.ts" line="20" tests="2">
        <testcase name="should do something" classname="methodName &gt; FooClass" time="0.001524" file="tests/unit/foo.test.ts" line="25" />
        <testcase name="should fail" classname="methodName &gt; FooClass" time="0.002" file="tests/unit/foo.test.ts" line="30">
          <failure message="expected 1 to equal 2">AssertionError: expected 1 to equal 2</failure>
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(2);

      // First test - passing
      expect(result[0]).toEqual({
        name: 'should do something',
        fullName: 'FooClass > methodName > should do something',
        fileName: 'tests/unit/foo.test.ts',
        line: 25,
        time: 0.001524,
        passed: true,
        failureMessage: undefined,
      });

      // Second test - failing
      expect(result[1]).toEqual({
        name: 'should fail',
        fullName: 'FooClass > methodName > should fail',
        fileName: 'tests/unit/foo.test.ts',
        line: 30,
        time: 0.002,
        passed: false,
        failureMessage: 'AssertionError: expected 1 to equal 2',
      });
    });
  });

  describe('classname attribute handling', () => {
    it('should ignore classname attribute in favor of hierarchy', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="file.test.ts" file="file.test.ts">
    <testsuite name="RealDescribe" line="10">
      <testcase name="test" classname="WrongClass" file="file.test.ts" line="15" time="0.001" />
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      // Should use testsuite hierarchy, not classname attribute
      expect(result[0].fullName).toBe('RealDescribe > test');
    });
  });

  describe('non-string input', () => {
    it('should return empty array for null input', () => {
      const result = parseJunitXml(null as any);

      expect(result).toEqual([]);
    });

    it('should return empty array for undefined input', () => {
      const result = parseJunitXml(undefined as any);

      expect(result).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
      const result = parseJunitXml(123 as any);

      expect(result).toEqual([]);
    });
  });

  describe('whitespace handling', () => {
    it('should handle extra whitespace in XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">

    <testcase name="test with whitespace" file="test.ts" line="10" time="0.001" />

  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test with whitespace');
    });

    it('should handle tabs and mixed whitespace', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
\t<testsuite name="test.ts" file="test.ts">
\t\t<testcase name="test" file="test.ts" line="10" time="0.001" />
\t</testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test');
    });
  });

  describe('attribute parsing edge cases', () => {
    it('should handle attributes with single quotes', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name='test.ts' file='test.ts'>
    <testcase name='test with single quotes' file='test.ts' line='10' time='0.001' />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      // Our parser expects double quotes, so this won't parse correctly
      // This documents current behavior
      expect(result).toHaveLength(0);
    });

    it('should handle attribute values with spaces', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test file.test.ts" file="path/to/test file.test.ts">
    <testcase name="test with spaces in path" file="path/to/test file.test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('path/to/test file.test.ts');
    });
  });

  describe('hierarchy stack management', () => {
    it('should correctly pop hierarchy stack on testsuite close', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="file.test.ts" file="file.test.ts">
    <testsuite name="Outer" line="10">
      <testsuite name="Inner" line="15">
        <testcase name="deep test" file="file.test.ts" line="20" time="0.001" />
      </testsuite>
      <testcase name="shallow test" file="file.test.ts" line="25" time="0.001" />
    </testsuite>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result).toHaveLength(2);
      expect(result[0].fullName).toBe('Outer > Inner > deep test');
      expect(result[1].fullName).toBe('Outer > shallow test'); // Inner should be popped
    });

    it('should handle closing testsuite with empty hierarchy stack gracefully', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test" file="test.ts" line="10" time="0.001" />
  </testsuite>
</testsuites>
</testsuite>`;

      // Extra closing tag - should not crash
      const result = parseJunitXml(xml);

      expect(result).toHaveLength(1);
    });
  });

  describe('failure element variations', () => {
    it('should handle failure element on same line as testcase close', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test" file="test.ts" line="10" time="0.001">
      <failure>Error message</failure></testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].passed).toBe(false);
      expect(result[0].failureMessage).toBe('Error message');
    });

    it('should handle failure element with attributes', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test" file="test.ts" line="10" time="0.001">
      <failure message="assertion failed" type="AssertionError">Full error details</failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].passed).toBe(false);
      expect(result[0].failureMessage).toBe('Full error details');
    });

    it('should handle empty failure element', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="test.ts" file="test.ts">
    <testcase name="test" file="test.ts" line="10" time="0.001">
      <failure>
      </failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = parseJunitXml(xml);

      expect(result[0].passed).toBe(false);
      // Multi-line failure parsing collects lines between <failure> and </failure>
      // Empty lines get trimmed but the structure is preserved
      expect(result[0].failureMessage).toBeDefined();
    });
  });
});
