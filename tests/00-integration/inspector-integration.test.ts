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
    let gapBleedTestFilePath: string;
    let cleanTwoTestFilePath: string;
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

        // Backlog item 2 (coverage-bleed detection): a deterministic trigger for the
        // preload's gap-window check (see emitCoverageBleedWarnings in
        // bun-test-runner.ts and detectGapWindowBleed in preload-logic.ts).
        //
        // The gap window is the span between one test's afterEach (which snapshots
        // globalThis.__stryker__.mutantCoverage.static) and the NEXT test's beforeEach
        // (which diffs against that snapshot). A fire-and-forget setTimeout/promise
        // chain is NOT a reliable way to land code there: empirically (bun 1.3.14),
        // bun's test dispatch loop chains hook/test invocations purely via microtask
        // continuations with no macrotask-phase yield in between when hooks/tests are
        // synchronous, so a pending timer from test A is never serviced until some
        // LATER test's own body forces a real event-loop turn — by which point
        // currentTestId has already moved on to that later test, not "no test".
        //
        // A describe-level beforeAll for the NEXT describe block, however, IS
        // deterministically ordered to run in exactly that gap: verified empirically
        // with bun 1.3.14 that for [root test A][describe B { beforeAll; test }],
        // hooks fire in the order afterEach(A) -> beforeAll(B) -> beforeEach(B) — this
        // is also the exact "known benign trigger" the preload's own doc comment
        // calls out (a describe-level beforeAll looks identical to genuine bleed from
        // the gap-check's vantage point). We reuse that same, reliably-ordered
        // mechanism here as a deterministic stand-in for a genuine fire-and-forget
        // leak, rather than a racy timer.
        gapBleedTestFilePath = path.join(tempDir, 'gap-bleed.test.ts');
        await fsPromises.writeFile(gapBleedTestFilePath, `
      import { describe, test, expect, beforeAll } from 'bun:test';

      test('gap bleed source test', () => {
        expect(true).toBe(true);
      });

      describe('gap bleed group', () => {
        beforeAll(() => {
          const g = globalThis as unknown as { __stryker__?: { mutantCoverage?: { static: Record<string, number> } } };
          const bucket = g.__stryker__?.mutantCoverage?.static;
          if (bucket) {
            bucket['999001'] = (bucket['999001'] ?? 0) + 1;
          }
        });

        test('gap bleed sink test', () => {
          expect(true).toBe(true);
        });
      });
    `);

        // Companion clean fixture (no describe-level beforeAll, no async work between
        // tests) to assert the gap-window check produces NO lateHits / warning on an
        // ordinary two-test file — i.e. no false positive.
        cleanTwoTestFilePath = path.join(tempDir, 'gap-clean.test.ts');
        await fsPromises.writeFile(cleanTwoTestFilePath, `
      import { test, expect } from 'bun:test';

      test('clean test one', () => {
        expect(true).toBe(true);
      });

      test('clean test two', () => {
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

    // Both tests below pin `bunArgs: ['--seed=0']`. This repo's own bunfig.toml sets
    // `randomize = true`, and bunfig-sanitizer.ts's SAFE_TEST_KEYS deliberately forwards
    // `randomize` (and `seed`, if set) from the project bunfig into the sanitized bunfig
    // used for spawned child `bun test` processes — including the ones these two tests
    // spawn via BunTestRunner. Verified empirically: WITHOUT pinning a seed, bun
    // randomizes the relative execution order of the two top-level sibling items in
    // gap-bleed.test.ts (the root `test` and the sibling `describe` block), which flips
    // whether the describe's beforeAll lands in the gap window after the root test's
    // afterEach (as intended) or runs first, before there's any "previous test" for the
    // gap-window check to attribute a bleed to — making the bleed warning fire only
    // ~50% of the time. `--seed=0` was verified (20/20 runs) to consistently order the
    // root test first; several other fixed seeds work too, but plenty of others (e.g.
    // 42) consistently give the opposite order instead — so a fixed seed makes the run
    // deterministic, but does not by itself guarantee our intended order without
    // checking. Do not remove this without re-verifying determinism (see task notes).
    test('detects a coverage-bleed hit that lands in the gap window between two tests (backlog item 2)', async () => {
        const { logger: mockLogger, logs } = createCapturingLogger();

        const runner = new BunTestRunner(mockLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                testFiles:        [gapBleedTestFilePath],
                bunArgs:          ['--seed=0'],
            },
            testRunner: { name: 'bun' },
        } as unknown as StrykerOptions);

        await runner.init();
        const result = await runner.dryRun();
        await runner.dispose();

        if(result.status !== DryRunStatus.Complete) {
            console.error('DryRun failed with result:', JSON.stringify(result, null, 2));
            console.error('Logs:', logs.join('\n'));
        }
        expect(result.status).toBe(DryRunStatus.Complete);

        // emitCoverageBleedWarnings' message: "mutant coverage was recorded between
        // tests, after '<testName>' completed ... (mutant IDs: 999001)" — asserted on
        // the mutant id rather than the resolved test name, since name resolution is
        // an orthogonal concern to the gap-window detection this test targets.
        const bleedWarning = logs.find(line =>
            line.includes('mutant coverage was recorded between tests') && line.includes('999001'));
        if(!bleedWarning) {
            console.error('Logs:', logs.join('\n'));
        }
        expect(bleedWarning).toBeDefined();
    }, 60_000);

    test('reports no coverage-bleed lateHits for a clean two-test file (no false positive)', async () => {
        const { logger: mockLogger, logs } = createCapturingLogger();

        const runner = new BunTestRunner(mockLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                testFiles:        [cleanTwoTestFilePath],
                bunArgs:          ['--seed=0'],
            },
            testRunner: { name: 'bun' },
        } as unknown as StrykerOptions);

        await runner.init();
        const result = await runner.dryRun();
        await runner.dispose();

        if(result.status !== DryRunStatus.Complete) {
            console.error('DryRun failed with result:', JSON.stringify(result, null, 2));
            console.error('Logs:', logs.join('\n'));
        }
        expect(result.status).toBe(DryRunStatus.Complete);
        expect(logs.some(line => line.includes('mutant coverage was recorded between tests'))).toBe(false);
    }, 60_000);
});
