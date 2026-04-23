import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import { DryRunStatus } from '@stryker-mutator/api/test-runner';
import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { resetAllMocks } from '../test-preload.js';

describe('Inspector Integration', () => {
    let tempDir: string;
    let testFilePath: string;

    beforeAll(async () => {
        // Reset all mocks to ensure clean state (unit tests may have set mock implementations)
        resetAllMocks();

        // Create temp directory with a simple test file
        tempDir = path.join(tmpdir(), `inspector-test-${Date.now()}`);
        await fsPromises.mkdir(tempDir, { recursive: true });

        testFilePath = path.join(tempDir, 'example.test.ts');
        await fsPromises.writeFile(testFilePath, `
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

    afterEach(() => {
        // Reset all mocks and timers to prevent leakage to other tests
        resetAllMocks();
        jest.useRealTimers();
    });

    afterAll(async () => {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        // Clean up the dryRun registry file that BunTestRunner writes to process.cwd().
        // This prevents leaving .stryker-bun-runner-registry.json as an untracked file
        // after the integration test run.
        const registryPath = path.join(process.cwd(), '.stryker-bun-runner-registry.json');
        await fsPromises.rm(registryPath, { force: true });
        await fsPromises.rm(`${registryPath}.tmp`, { force: true });
    });

    test('collects test names via inspector', async () => {
    // Create a mock logger
        const logs: string[] = [];
        const formatArg = (arg: unknown): string => {
            if(arg === null || arg === undefined) {
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
            // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions -- exhaustive type guards above eliminate all non-primitive cases; TypeScript cannot narrow unknown past typeof guards
            return `${arg}`;
        };

        const mockLogger = {
            debug: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replaceAll(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push(`DEBUG: ${formatted}`);
            },
            info: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replaceAll(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push(`INFO: ${formatted}`);
            },
            warn: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replaceAll(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push(`WARN: ${formatted}`);
            },
            error: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replaceAll(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push(`ERROR: ${formatted}`);
            },
            trace: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replaceAll(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push(`TRACE: ${formatted}`);
            },
            fatal: (msg: string, ...args: unknown[]) => {
                const formatted = msg.replaceAll(/%[sdjoO]/g, () => formatArg(args.shift()));
                logs.push(`FATAL: ${formatted}`);
            },
            isDebugEnabled: () => true,
            isInfoEnabled:  () => true,
            isWarnEnabled:  () => true,
            isErrorEnabled: () => true,
            isTraceEnabled: () => true,
            isFatalEnabled: () => true,
        };

        const runner = new BunTestRunner(mockLogger, {
            bun: {
                bunPath:          'bun',  // Use the default bun
                timeout:          60_000,
                inspectorTimeout: 30_000,  // Increased for resource contention during full test suite
                testFiles:        [testFilePath],  // Point to our test file; bypasses auto-discovery
            },
            testRunner: { name: 'bun' },
        } as unknown as StrykerOptions);

        await runner.init();

        // Run dry run - this should connect via inspector
        const result = await runner.dryRun();

        await runner.dispose();

        // Verify results - log error details if failed
        if(result.status !== DryRunStatus.Complete) {
            console.error('DryRun failed with result:', JSON.stringify(result, null, 2));
            console.error('Logs:', logs.join('\n'));
        }
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
    }, 60_000); // 60 second timeout
});
