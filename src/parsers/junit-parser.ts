/**
 * JUnit XML parser for extracting test metadata from Bun's JUnit reporter output
 *
 * Parses nested testsuite hierarchies to build complete test names with describe blocks.
 *
 * Example JUnit structure:
 * ```xml
 * <testsuites>
 *   <testsuite name="file.test.ts" file="file.test.ts">
 *     <testsuite name="DescribeBlock" line="10">
 *       <testsuite name="nested describe" line="20">
 *         <testcase name="test name" file="file.test.ts" line="25" time="0.001" />
 *       </testsuite>
 *     </testsuite>
 *   </testsuite>
 * </testsuites>
 * ```
 */

export interface JUnitTestResult {
  name: string;           // Test name (e.g., "should run tests with coverage")
  fullName: string;       // describe hierarchy + name (e.g., "BunTestRunner > dryRun > should run tests with coverage")
  fileName: string;       // File path (e.g., "tests/unit/bun-test-runner.test.ts")
  line: number;           // Line number
  time: number;           // Duration in seconds
  passed: boolean;
  failureMessage?: string;
}

/**
 * Unescape XML entities
 */
function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Extract attribute value from an XML tag string
 */
function extractAttribute(tag: string, attrName: string): string | undefined {
  const pattern = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const match = tag.match(pattern);
  return match ? unescapeXml(match[1]) : undefined;
}

/**
 * Parse JUnit XML output from Bun's test runner
 *
 * @param xml - JUnit XML string from Bun's --reporter=junit
 * @returns Array of test results with metadata
 */
export function parseJunitXml(xml: string): JUnitTestResult[] {
  if (!xml || typeof xml !== 'string') {
    return [];
  }

  const results: JUnitTestResult[] = [];

  try {
    // Track the hierarchy of describe blocks as we traverse nested testsuites
    const hierarchyStack: string[] = [];

    // Split into lines for simpler parsing
    const lines = xml.split('\n');
    let currentFile = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Opening testsuite tag - might be a describe block or file
      const testsuiteOpenMatch = line.match(/^<testsuite\s+([^>]+)>$/);
      if (testsuiteOpenMatch) {
        const attrs = testsuiteOpenMatch[1];
        const name = extractAttribute(attrs, 'name');
        const file = extractAttribute(attrs, 'file');

        // Update current file if this testsuite has a file attribute
        if (file) {
          currentFile = file;
        }

        // Add to hierarchy if it has a name and it's not just the filename
        if (name && (!file || name !== file)) {
          hierarchyStack.push(name);
        }
        continue;
      }

      // Closing testsuite tag - pop from hierarchy
      if (line === '</testsuite>') {
        if (hierarchyStack.length > 0) {
          hierarchyStack.pop();
        }
        continue;
      }

      // Self-closing testsuite tag - update file but don't add to hierarchy
      const testsuiteSelfClosingMatch = line.match(/^<testsuite\s+([^>]+)\/>$/);
      if (testsuiteSelfClosingMatch) {
        const attrs = testsuiteSelfClosingMatch[1];
        const file = extractAttribute(attrs, 'file');
        if (file) {
          currentFile = file;
        }
        continue;
      }

      // Testcase - extract test information
      const testcaseMatch = line.match(/^<testcase\s+([^>]+?)(?:\/>|>)/);
      if (testcaseMatch) {
        const attrs = testcaseMatch[1];
        const name = extractAttribute(attrs, 'name');
        const file = extractAttribute(attrs, 'file');
        const lineAttr = extractAttribute(attrs, 'line');
        const timeAttr = extractAttribute(attrs, 'time');

        if (!name) {
          continue;
        }

        // Build full name from hierarchy
        const fullName = hierarchyStack.length > 0
          ? `${hierarchyStack.join(' > ')} > ${name}`
          : name;

        const fileName = file || currentFile;
        const lineNum = lineAttr ? parseInt(lineAttr, 10) : 0;
        const time = timeAttr ? parseFloat(timeAttr) : 0;

        // Check if this testcase has a failure element
        let passed = true;
        let failureMessage: string | undefined;

        // If the testcase is not self-closing, check for failure element
        if (!line.endsWith('/>')) {
          // Look ahead for <failure> element
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();

            // Found closing testcase tag
            if (nextLine === '</testcase>') {
              break;
            }

            // Found failure element
            const failureMatch = nextLine.match(/<failure[^>]*>(.+)<\/failure>/);
            if (failureMatch) {
              passed = false;
              failureMessage = unescapeXml(failureMatch[1]);
              break;
            }

            // Multi-line failure
            const failureOpenMatch = nextLine.match(/<failure[^>]*>/);
            if (failureOpenMatch) {
              passed = false;
              const failureLines: string[] = [];

              // Collect failure message lines
              for (let k = j + 1; k < lines.length; k++) {
                const failureLine = lines[k].trim();
                if (failureLine === '</failure>') {
                  break;
                }
                failureLines.push(failureLine);
              }

              failureMessage = unescapeXml(failureLines.join('\n'));
              break;
            }
          }
        }

        results.push({
          name,
          fullName,
          fileName,
          line: lineNum,
          time,
          passed,
          failureMessage
        });
      }
    }

    return results;
  } catch (error) {
    // Return empty array on parse errors
    return [];
  }
}
