import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { DryRunStatus } from '@stryker-mutator/api/test-runner';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '@stryker-mutator/api/logging';
import type { StrykerOptions } from '@stryker-mutator/api/core';

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

    // FIXME: Test fails with port allocation error - needs investigation
    test.skip('collects test names via inspector', async () => {
    // Create a mock logger
        const logs: string[] = [];
        const formatArg = (arg: unknown): string => {
            if(arg == null) {
                return '';
            }
            if(typeof arg === 'object') {
                return JSON.stringify(arg);
            }
            if(typeof arg === 'symbol') {
                return arg.toString();
            }
            if(typeof arg === 'function') {
                return '[Function]';
            }
            // After all checks, arg is string, number, boolean, or bigint
            // Type assertion is safe here as we've exhausted all object-like types
            return String(arg as string | number | boolean | bigint);
        };

        const mockLogger = {
            debug: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replace(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push('DEBUG: ' + formatted);
            },
            info: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replace(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push('INFO: ' + formatted);
            },
            warn: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replace(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push('WARN: ' + formatted);
            },
            error: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replace(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push('ERROR: ' + formatted);
            },
            trace: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replace(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push('TRACE: ' + formatted);
            },
            fatal: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replace(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push('FATAL: ' + formatted);
            },
            isDebugEnabled: () => true,
            isInfoEnabled:  () => true,
            isWarnEnabled:  () => true,
            isErrorEnabled: () => true,
            isTraceEnabled: () => true,
            isFatalEnabled: () => true,
        };

        const runner = new BunTestRunner(mockLogger as unknown as Logger, {
            bun: {
                bunPath:          'bun',  // Use the default bun
                timeout:          30000,
                inspectorTimeout: 10000,
                bunArgs:          [testFilePath],  // Point to our test file
            },
            testRunner: { name: 'bun' },
        } as unknown as StrykerOptions);

        await runner.init();

        // Run dry run - this should connect via inspector
        const result = await runner.dryRun();

        await runner.dispose();

        // Verify results
        expect(result.status).toBe(DryRunStatus.Complete);

        // Type narrowing: only CompleteDryRunResult has tests property
        if(result.status !== DryRunStatus.Complete) {
            throw new Error('Expected complete status');
        }

        expect(result.tests).toBeDefined();
        expect(result.tests.length).toBeGreaterThan(0);

        // Check that test names are proper (not counter-based)
        const testNames = result.tests.map((t: { name: string }) => t.name);

        // Should have hierarchical names like "Math operations > addition works"
        // NOT counter-based names like "test-1", "test-2"
        const hasProperNames = testNames.some((name: string) =>
            name.includes('>') || name.includes('addition') || name.includes('standalone')
        );
        expect(hasProperNames).toBe(true);
    }, 60000); // 60 second timeout
});
