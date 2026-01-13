import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { DryRunStatus } from '@stryker-mutator/api/test-runner';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Inspector Integration', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeAll(async () => {
    // Create temp directory with a simple test file
    tempDir = join(tmpdir(), 'inspector-test-' + Date.now());
    await mkdir(tempDir, { recursive: true });

    testFilePath = join(tempDir, 'example.test.ts');
    await writeFile(testFilePath, `
      import { describe, test, expect } from 'bun:test';

      describe('Math operations', () => {
        test('addition works', () => {
          expect(1 + 1).toBe(2);
        });

        test('subtraction works', () => {
          expect(5 - 3).toBe(2);
        });
      });

      test('standalone test', () => {
        expect(true).toBe(true);
      });
    `);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Skip: requires running with bun-25986 which supports TestReporter events
  test.skip('collects test names via inspector', async () => {
    // Create a mock logger
    const logs: string[] = [];
    const mockLogger = {
      debug: (msg: string, ...args: unknown[]) => {
        const formatted = msg.replace(/%([sdjoO])/g, () => String(args.shift() ?? ''));
        logs.push('DEBUG: ' + formatted);
      },
      info: (msg: string, ...args: unknown[]) => {
        const formatted = msg.replace(/%([sdjoO])/g, () => String(args.shift() ?? ''));
        logs.push('INFO: ' + formatted);
      },
      warn: (msg: string, ...args: unknown[]) => {
        const formatted = msg.replace(/%([sdjoO])/g, () => String(args.shift() ?? ''));
        logs.push('WARN: ' + formatted);
      },
      error: (msg: string, ...args: unknown[]) => {
        const formatted = msg.replace(/%([sdjoO])/g, () => String(args.shift() ?? ''));
        logs.push('ERROR: ' + formatted);
      },
      trace: (msg: string, ...args: unknown[]) => {
        const formatted = msg.replace(/%([sdjoO])/g, () => String(args.shift() ?? ''));
        logs.push('TRACE: ' + formatted);
      },
      fatal: (msg: string, ...args: unknown[]) => {
        const formatted = msg.replace(/%([sdjoO])/g, () => String(args.shift() ?? ''));
        logs.push('FATAL: ' + formatted);
      },
      isDebugEnabled: () => true,
      isInfoEnabled: () => true,
      isWarnEnabled: () => true,
      isErrorEnabled: () => true,
      isTraceEnabled: () => true,
      isFatalEnabled: () => true,
    };

    const runner = new BunTestRunner(mockLogger as any, {
      bun: {
        bunPath: 'bun-25986',  // Use the fixed bun version
        timeout: 30000,
        inspectorTimeout: 10000,
        bunArgs: [testFilePath],  // Point to our test file
      },
      testRunner: { name: 'bun' },
    } as any);

    await runner.init();

    // Run dry run - this should connect via inspector
    const result = await runner.dryRun();

    await runner.dispose();

    // Verify results
    console.log('DryRun result:', JSON.stringify(result, null, 2));
    console.log('Logs:', logs.join('\n'));

    expect(result.status).toBe(DryRunStatus.Complete);

    // Type narrowing: only CompleteDryRunResult has tests property
    if (result.status !== DryRunStatus.Complete) {
      throw new Error('Expected complete status');
    }

    expect(result.tests).toBeDefined();
    expect(result.tests.length).toBeGreaterThan(0);

    // Check that test names are proper (not counter-based)
    const testNames = result.tests.map((t: { name: string }) => t.name);
    console.log('Test names:', testNames);

    // Should have hierarchical names like "Math operations > addition works"
    // NOT counter-based names like "test-1", "test-2"
    const hasProperNames = testNames.some((name: string) =>
      name.includes('>') || name.includes('addition') || name.includes('standalone')
    );
    expect(hasProperNames).toBe(true);
  }, 60000); // 60 second timeout
});
