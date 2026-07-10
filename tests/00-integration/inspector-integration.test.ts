import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, type MutantRunOptions } from '@stryker-mutator/api/test-runner';
import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { resetAllMocks } from '../test-preload.js';

/**
 * Builds a Stryker-shaped logger stub that captures every formatted log line
 * (with printf-style %s/%d/%j/%o/%O substitution applied) so integration
 * tests can assert on warn/debug output from real runner + real bun spawns.
 */
function createCapturingLogger(): { logger: Logger, logs: string[] } {
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

    const logger = {
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

    return { logger, logs };
}

describe('Inspector Integration', () => {
    let tempDir: string;
    let testFilePath: string;
    let gtTestFilePath: string;
    let originalForceColor: string | undefined;

    beforeAll(async () => {
        // Reset all mocks to ensure clean state (unit tests may have set mock implementations)
        resetAllMocks();

        // The real-spawn harness below inherits process.env (process-runner.ts spreads
        // process.env into the child's env). If FORCE_COLOR is set, bun colorizes piped
        // stderr/stdout and process-runner's inspector-URL regex (no ANSI tolerance) fails
        // to find "Listening: ws://...", so dryRun errors out before mutantRun is ever
        // exercised. Deletion (not override) is required: bun treats a set-but-empty
        // FORCE_COLOR as forcing color, and NO_COLOR=1 does not override it (verified live,
        // bun 1.3.14). Restored in afterAll so later test files in the same bun process
        // aren't affected.
        originalForceColor = process.env.FORCE_COLOR;
        delete process.env.FORCE_COLOR;

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

        // Isambard repro shape (TEST-NAME-PATTERN-BUG.md): a test title that legitimately
        // contains a literal " > " (a comparison operator), nested under a describe, plus a
        // sibling test so a testFilter of just the ">"-titled test is a genuine subset.
        gtTestFilePath = path.join(tempDir, 'greater-than.test.ts');
        await fsPromises.writeFile(gtTestFilePath, `
      import { describe, test, expect } from 'bun:test';

      describe('createContextBuilder loading methods', () => {
        test('should call listMessages with CleanInbox when unread > 0', () => {
          expect(true).toBe(true);
        });

        test('sibling test', () => {
          expect(true).toBe(true);
        });
      });
    `);
    });

    afterEach(() => {
        // Reset all mocks and timers to prevent leakage to other tests
        resetAllMocks();
        jest.useRealTimers();
    });

    afterAll(async () => {
        // Restore FORCE_COLOR so later test files running in the same bun process
        // (bun test loads all matched files into one process) see the original env.
        // Done before the awaits below (no shared-state race across them).
        if(originalForceColor !== undefined) {
            process.env.FORCE_COLOR = originalForceColor;
        }

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
        const { logger: mockLogger, logs } = createCapturingLogger();

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

    test('runs a test whose title contains a literal " > " under mutantRun testFilter', async () => {
        const { logger: mockLogger, logs } = createCapturingLogger();

        const runner = new BunTestRunner(mockLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                testFiles:        [gtTestFilePath],
            },
            testRunner: { name: 'bun' },
        } as unknown as StrykerOptions);

        await runner.init();

        const dryRunResult = await runner.dryRun();

        if(dryRunResult.status !== DryRunStatus.Complete) {
            console.error('DryRun failed with result:', JSON.stringify(dryRunResult, null, 2));
            console.error('Logs:', logs.join('\n'));
        }
        expect(dryRunResult.status).toBe(DryRunStatus.Complete);

        // Type narrowing: only CompleteDryRunResult has tests property
        if(dryRunResult.status !== DryRunStatus.Complete) {
            throw new Error('Expected complete status');
        }

        // Find the id of the test whose title contains the literal " > " sequence.
        const targetTest = dryRunResult.tests.find(t => t.name.includes('unread > 0'));
        expect(targetTest).toBeDefined();
        if(!targetTest) {
            throw new Error('Expected to find the "unread > 0" test in dryRun results');
        }

        const result = await runner.mutantRun({
            activeMutant:    { id: '1' },
            testFilter:      [targetTest.id],
            sandboxFileName: gtTestFilePath,
        } as unknown as MutantRunOptions);

        await runner.dispose();

        if(result.status !== MutantRunStatus.Survived) {
            console.error('MutantRun result:', JSON.stringify(result, null, 2));
            console.error('Logs:', logs.join('\n'));
        }

        // Today (pre-fix): buildTestNamePattern collapses the literal " > " in the title
        // to a single space, the resulting pattern matches zero tests, bun exits 1, and
        // mutantRun misreports this as Killed with killedBy: ['unknown'] instead of
        // Survived — see TEST-NAME-PATTERN-BUG.md defect 1 (and its defect-2 false-Killed
        // edge, since this goes through the same exit!==0 path).
        expect(result.status).toBe(MutantRunStatus.Survived);
        if(result.status === MutantRunStatus.Survived) {
            expect(result.nrOfTests).toBeGreaterThanOrEqual(1);
        }
    }, 60_000);

    test('never reports Killed when the pattern matches zero tests', async () => {
        const { logger: mockLogger, logs } = createCapturingLogger();

        const runner = new BunTestRunner(mockLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                testFiles:        [gtTestFilePath],
            },
            testRunner: { name: 'bun' },
        } as unknown as StrykerOptions);

        await runner.init();

        const dryRunResult = await runner.dryRun();
        expect(dryRunResult.status).toBe(DryRunStatus.Complete);

        // A testFilter id that cannot match anything in this test file: the pattern
        // built from it matches zero tests in bun's matcher.
        const result = await runner.mutantRun({
            activeMutant:    { id: '2' },
            testFilter:      ['tests/whatever.test.ts > nope > not real'],
            sandboxFileName: gtTestFilePath,
        } as unknown as MutantRunOptions);

        await runner.dispose();

        if(result.status === MutantRunStatus.Killed) {
            console.error('MutantRun unexpectedly Killed:', JSON.stringify(result, null, 2));
            console.error('Logs:', logs.join('\n'));
        }

        // Today (pre-fix): a zero-match --test-name-pattern makes bun exit 1 with no
        // parsed failures, and mutantRun's exitCode!==0 branch misreports this as
        // Killed with killedBy: ['unknown'] — see TEST-NAME-PATTERN-BUG.md defect 2.
        // Post-fix (Stage 5): the runner retries once with the full suite and this
        // becomes a genuine Survived, with a warn log naming the zero-match retry.
        expect(result.status).not.toBe(MutantRunStatus.Killed);
        expect(logs.some(line => line.includes('matched 0 tests'))).toBe(true);
    }, 60_000);
});
