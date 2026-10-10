/**
 * Unit tests for BunTestRunner's dry-run diagnostics and killedBy resolution helpers
 * (warnOnUnidentifiedDryRunFailure, checkCompletenessGate, emitCoverageBleedWarnings,
 * buildLocalTestFilterIndex, resolveKilledBy, dispose).
 *
 * These exercise the private helpers directly with synthetic inputs: the dryRun() pipeline
 * in front of them (checkDryRunProcessResult, the gate's own precondition) makes many of
 * their input combinations unreachable end-to-end, but each helper's contract is still
 * precise and worth pinning exactly (messages included, since they are the only place a
 * user learns why a dry run failed).
 */

import { format as formatLogCall } from 'node:util';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import type { InspectorCloseInfo } from '../../src/inspector/index.js';
import type { TestInfo } from '../../src/inspector/types.js';
import * as bunfigSanitizer from '../../src/utils/bunfig-sanitizer.js';

interface CloseInfoShape {
    code:                   number | undefined
    reason:                 string | undefined
    wasClean:               boolean | undefined
    msFromLastFrameToClose: number | undefined
}

/** The private surface under test. */
interface Internals {
    warnOnUnidentifiedDryRunFailure(
        result: { exitCode: number | null, stderr: string },
        parsed: { failed: number },
        tests:  readonly { status: TestStatus }[]
    ): void
    checkCompletenessGate(
        executionOrder:        number[],
        testHierarchy:         TestInfo[],
        parsed:                { summaryPassed: number, summaryFailed: number },
        rawKeyCount:           number,
        orphanedKeyCount:      number,
        wasClosedUnexpectedly: boolean,
        tests:                 readonly { status: TestStatus }[],
        closeInfo:             InspectorCloseInfo,
        stderr:                string
    ): { status: DryRunStatus, errorMessage?: string } | null
    emitCoverageBleedWarnings(lateHits: { testId: string, mutantIds: string[] }[], counterKeyToTestName: Map<string, string>): void
    buildLocalTestFilterIndex(testFilter: string[]): { localRegistry: Set<string>, localBaseIndex: Map<string, string[]> }
    resolveKilledBy(raw: string[], localRegistry: Set<string>, localBaseIndex: Map<string, string[]>, mutantId: string): string[]
    warnLossyPatternAlternatives(filterIds: readonly string[], mutantId: string): void
    testNameIndex?:       Map<string, string>
    cachedTestNames?:     Set<string>
    baseNameIndex?:       Map<string, string[]>
    sanitizedBunfigPath?: string
}

const noCloseInfo = { code: undefined, reason: undefined, wasClean: undefined, msFromLastFrameToClose: undefined };

function asCloseInfo(info: CloseInfoShape): InspectorCloseInfo {
    return info;
}

describe('BunTestRunner diagnostics and killedBy resolution', () => {
    let mockLogger: Logger;
    let runner: BunTestRunner;
    let internals: Internals;

    /** Every call of one logger level, rendered the way a real logger would print it. */
    function rendered(fn: unknown): string[] {
        return (fn as ReturnType<typeof mock>).mock.calls.map(args => formatLogCall(...(args as [string, ...unknown[]])));
    }

    beforeEach(() => {
        mockLogger = {
            debug:          mock(),
            info:           mock(),
            warn:           mock(),
            error:          mock(),
            trace:          mock(),
            fatal:          mock(),
            isTraceEnabled: mock().mockReturnValue(false),
            isDebugEnabled: mock().mockReturnValue(true),
            isInfoEnabled:  mock().mockReturnValue(true),
            isWarnEnabled:  mock().mockReturnValue(true),
            isErrorEnabled: mock().mockReturnValue(true),
            isFatalEnabled: mock().mockReturnValue(true),
        };
        runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
        internals = runner as unknown as Internals;
        // Drop the constructor's own "initialized" debug line so each test sees only what it triggers.
        (mockLogger.debug as ReturnType<typeof mock>).mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('warnOnUnidentifiedDryRunFailure', () => {
        const passed = { status: TestStatus.Success };
        const failed = { status: TestStatus.Failed };

        it('warns with the exit code, failed count and the LAST 500 chars of stderr when no built test failed', () => {
            const stderr = `${'a'.repeat(100)}${'b'.repeat(500)}`;

            internals.warnOnUnidentifiedDryRunFailure({ exitCode: 1, stderr }, { failed: 2 }, [passed]);

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(rendered(mockLogger.warn)[0]).toBe(
                'Bun exited with code 1 and its console output reported 2 failed test(s), '
                + 'but no failing test could be identified from inspector or console data. '
                + 'An unhandled error firing between tests (e.g. a rejected fire-and-forget '
                + `promise) is a likely cause. Last 500 chars of stderr:\n${'b'.repeat(500)}`
            );
        });

        it('renders a missing exit code (signal death) as "null"', () => {
            internals.warnOnUnidentifiedDryRunFailure({ exitCode: null, stderr: '' }, { failed: 1 }, []);

            expect(rendered(mockLogger.warn)[0]).toContain('Bun exited with code null and');
        });

        it('warns for a clean exit code when the console recap still counted failures (e.g. retried attempts)', () => {
            internals.warnOnUnidentifiedDryRunFailure({ exitCode: 0, stderr: '' }, { failed: 1 }, [passed]);

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        it('does not warn when the console recap counted no failures', () => {
            internals.warnOnUnidentifiedDryRunFailure({ exitCode: 0, stderr: 'noise' }, { failed: 0 }, [passed]);

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('does not warn when a built test is Failed, even alongside passing tests', () => {
            internals.warnOnUnidentifiedDryRunFailure({ exitCode: 1, stderr: '' }, { failed: 1 }, [passed, failed, passed]);
            internals.warnOnUnidentifiedDryRunFailure({ exitCode: 1, stderr: '' }, { failed: 1 }, [failed]);

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('checkCompletenessGate', () => {
        const green: readonly { status: TestStatus }[] = [{ status: TestStatus.Success }];

        function hierarchy(statuses: TestInfo['status'][]): TestInfo[] {
            return statuses.map((status, i) => ({ id: i + 1, name: `t${i + 1}`, fullName: `t${i + 1}`, type: 'test' as const, status }));
        }

        /** n ids, all passing, in execution order. */
        function passing(n: number): { order: number[], tree: TestInfo[] } {
            const tree = hierarchy(Array.from({ length: n }, () => 'pass' as const));
            return { order: tree.map(t => t.id), tree };
        }

        function gate(opts: {
            order?:  number[]
            tree?:   TestInfo[]
            passed?: number
            failed?: number
            raw?:    number
            orphan?: number
            closed?: boolean
            tests?:  readonly { status: TestStatus }[]
            close?:  CloseInfoShape
            stderr?: string
        }): { status: DryRunStatus, errorMessage?: string } | null {
            return internals.checkCompletenessGate(
                opts.order ?? [],
                opts.tree ?? [],
                { summaryPassed: opts.passed ?? 0, summaryFailed: opts.failed ?? 0 },
                opts.raw ?? 0,
                opts.orphan ?? 0,
                opts.closed ?? false,
                opts.tests ?? green,
                asCloseInfo(opts.close ?? noCloseInfo),
                opts.stderr ?? ''
            );
        }

        const PREFIX = 'stryker-bun-runner: dry run data-completeness check failed — ';
        const SUFFIX = [
            '. This indicates the Bun inspector event stream may have been ',
            'truncated mid-run; proceeding would risk silently ',
            'corrupted coverage attribution, so this dry run is being reported as an error instead of ',
            'Complete, and the test registry has NOT been persisted.',
        ].join('');

        it('Signal A: reports the exact error message, and logs it through logger.error', () => {
            const { order, tree } = passing(65);

            const result = gate({ order, tree, passed: 100 });

            const expected = [
                PREFIX,
                "console reported 100 test(s) (pass+fail) but the inspector's execution order ",
                `contains only 65 non-skipped test(s) (shortfall 35)${SUFFIX}`,
            ].join('');
            expect(result).toEqual({ status: DryRunStatus.Error, errorMessage: expected });
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith('%s', expected);
        });

        it('Signal A: consoleTotal is passes PLUS failures', () => {
            const { order, tree } = passing(65);

            // 60 + 40 = 100 → shortfall 35 (a subtraction would give 20 → shortfall -45, no shortfall at all).
            const result = gate({ order, tree, passed: 60, failed: 40 });

            expect(result?.errorMessage).toContain('console reported 100 test(s) (pass+fail) but');
            expect(result?.errorMessage).toContain('(shortfall 35)');
        });

        it('Signal A: skipped and todo tests in the execution order are not counted as executed', () => {
            // 65 passing + 25 skipped + 10 placeholder-status ids = 100 ids in executionOrder. Console says 100.
            // Only the 65 passing ones actually ran, so the shortfall is 35, not 0.
            const tree = hierarchy([
                ...Array.from({ length: 65 }, () => 'pass' as const),
                ...Array.from({ length: 25 }, () => 'skip' as const),
                ...Array.from({ length: 10 }, () => 'todo' as const),
            ]);

            const result = gate({ order: tree.map(t => t.id), tree, passed: 100 });

            expect(result?.errorMessage).toContain('contains only 65 non-skipped test(s) (shortfall 35)');
        });

        it('Signal A: skipped tests alone are excluded (todo not involved)', () => {
            const tree = hierarchy([
                ...Array.from({ length: 80 }, () => 'pass' as const),
                ...Array.from({ length: 20 }, () => 'skip' as const),
            ]);

            // 80 executed vs 100 → shortfall 20 > floor, ratio 0.2 > threshold.
            const result = gate({ order: tree.map(t => t.id), tree, passed: 100 });

            expect(result?.errorMessage).toContain('contains only 80 non-skipped test(s) (shortfall 20)');
        });

        it('Signal A: todo tests alone are excluded (skip not involved)', () => {
            const tree = hierarchy([
                ...Array.from({ length: 80 }, () => 'pass' as const),
                ...Array.from({ length: 20 }, () => 'todo' as const),
            ]);

            const result = gate({ order: tree.map(t => t.id), tree, passed: 100 });

            expect(result?.errorMessage).toContain('contains only 80 non-skipped test(s) (shortfall 20)');
        });

        it('Signal A: execution ids unknown to the hierarchy still count as executed', () => {
            // 100 ids, none in the hierarchy (so no status) → all count, no shortfall.
            const order = Array.from({ length: 100 }, (_, i) => i + 1);

            expect(gate({ order, tree: [], passed: 100 })).toBeNull();
        });

        it('Signal A: a shortfall exactly at the absolute floor (10) does not fire, one above does', () => {
            const ninety = passing(90);
            const eightyNine = passing(89);

            // 100 vs 90: shortfall 10 (ratio 0.1 > 0.05, but the floor is strict).
            expect(gate({ order: ninety.order, tree: ninety.tree, passed: 100 })).toBeNull();
            // 100 vs 89: shortfall 11.
            expect(gate({ order: eightyNine.order, tree: eightyNine.tree, passed: 100 })?.status).toBe(DryRunStatus.Error);
        });

        it('Signal A: a shortfall ratio exactly at the threshold (5%) does not fire, above it does', () => {
            const atThreshold = passing(209);
            const aboveThreshold = passing(208);

            // 220 vs 209: shortfall 11 > floor, ratio 11/220 = 0.05 exactly: strict comparison, no fire.
            expect(gate({ order: atThreshold.order, tree: atThreshold.tree, passed: 220 })).toBeNull();
            // 220 vs 208: shortfall 12, ratio 0.0545 > 0.05.
            expect(gate({ order: aboveThreshold.order, tree: aboveThreshold.tree, passed: 220 })?.status).toBe(DryRunStatus.Error);
        });

        it('Signal A: a large suite with a shortfall over the floor but a tiny ratio does not fire', () => {
            // 1000 vs 988: shortfall 12 > floor 10, ratio 1.2% < 5%.
            const { order, tree } = passing(988);

            expect(gate({ order, tree, passed: 1000 })).toBeNull();
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('Signal B: reports orphaned coverage keys, and nothing about the other signals', () => {
            const { order, tree } = passing(10);

            const result = gate({ order, tree, passed: 10, raw: 100, orphan: 6 });

            expect(result?.errorMessage).toBe(
                `${PREFIX}6 of 100 coverage key(s) could not be paired with any inspector test (orphaned)${SUFFIX}`
            );
        });

        it('Signal C: reports unattributable failures with the LAST 500 chars of stderr', () => {
            const { order, tree } = passing(10);

            const result = gate({ order, tree, failed: 3, passed: 7, stderr: `${'x'.repeat(100)}${'y'.repeat(500)}` });

            expect(result?.errorMessage).toBe(
                `${PREFIX}bun's console summary reported 3 failing test(s), but none of them could be `
                + 'attributed to an individual test — a whole spec file that fails to load (e.g. an unresolvable '
                + `import) produces exactly this shape. Last 500 chars of stderr:\n${'y'.repeat(500)}${SUFFIX}`
            );
        });

        it('joins several material signals with "; " in A, B, C order', () => {
            const { order, tree } = passing(10);

            const result = gate({ order, tree, passed: 70, failed: 30, raw: 40, orphan: 20, stderr: 'boom' });

            const message = result?.errorMessage ?? '';
            const a = message.indexOf("console reported 100 test(s) (pass+fail) but the inspector's execution order contains only 10 non-skipped test(s) (shortfall 90); ");
            const b = message.indexOf('20 of 40 coverage key(s) could not be paired with any inspector test (orphaned); ');
            const c = message.indexOf("bun's console summary reported 30 failing test(s)");
            expect(a).toBeGreaterThan(-1);
            expect(b).toBeGreaterThan(a);
            expect(c).toBeGreaterThan(b);
        });

        it('does not evaluate at all when a built test already Failed', () => {
            const { order, tree } = passing(10);

            expect(gate({ order, tree, passed: 100, failed: 5, orphan: 50, tests: [{ status: TestStatus.Failed }] })).toBeNull();
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('returns null for a healthy run and an unexpected close alone is never a trigger', () => {
            const { order, tree } = passing(10);

            expect(gate({ order, tree, passed: 10, closed: true, close: { code: 1006, reason: 'x', wasClean: false, msFromLastFrameToClose: 5 } })).toBeNull();
        });

        describe('unexpected-close context', () => {
            const fired = (extra: Parameters<typeof gate>[0]): string => {
                const { order, tree } = passing(10);
                return gate({ order, tree, orphan: 6, raw: 6, closed: true, ...extra })?.errorMessage ?? '';
            };
            const closedDetail = (detail: string): string =>
                `; the inspector WebSocket closed unexpectedly before this data could be fully drained (${detail})`;

            it('says the close code/reason were not captured when the close event carried no code', () => {
                expect(fired({ close: noCloseInfo })).toContain(closedDetail('close code/reason not captured'));
            });

            it('names the captured code, reason, cleanliness and timing', () => {
                const message = fired({ close: { code: 1006, reason: 'abnormal', wasClean: false, msFromLastFrameToClose: 12 } });

                expect(message).toContain(closedDetail('close code=1006 reason="abnormal" wasClean=false, 12ms after the last received frame'));
            });

            it('treats a genuinely captured code of 0 as captured, and an absent reason as the empty string', () => {
                const message = fired({ close: { code: 0, reason: undefined, wasClean: true, msFromLastFrameToClose: 0 } });

                expect(message).toContain(closedDetail('close code=0 reason="" wasClean=true, 0ms after the last received frame'));
            });

            it('is omitted when the socket did not close unexpectedly', () => {
                expect(fired({ closed: false })).not.toContain('closed unexpectedly');
            });
        });
    });

    describe('emitCoverageBleedWarnings', () => {
        const hit = (n: number): { testId: string, mutantIds: string[] } => ({ testId: `file@@test-${n}`, mutantIds: ['1', '2'] });

        it('lists each late hit with the resolved test name and mutant ids', () => {
            internals.emitCoverageBleedWarnings([hit(1)], new Map([['file@@test-1', 'Suite > my test']]));

            expect(rendered(mockLogger.warn)).toEqual([
                'mutant coverage was recorded between tests, after \'Suite > my test\' completed — likely fire-and-forget async work '
                + 'leaking past the test boundary (or beforeAll/fixture code running between tests); attribution for 2 '
                + 'mutant(s) may be wrong (mutant IDs: 1, 2)',
            ]);
        });

        it('emits no suppression line when the hits exactly fill the cap', () => {
            const hits = Array.from({ length: 25 }, (_, i) => hit(i));

            internals.emitCoverageBleedWarnings(hits, new Map());

            expect(mockLogger.warn).toHaveBeenCalledTimes(25);
            expect(rendered(mockLogger.warn).some(m => m.includes('suppressed'))).toBe(false);
        });

        it('caps individual warnings at 25 and summarises the rest', () => {
            const hits = Array.from({ length: 28 }, (_, i) => hit(i));

            internals.emitCoverageBleedWarnings(hits, new Map());

            expect(mockLogger.warn).toHaveBeenCalledTimes(26);
            expect(rendered(mockLogger.warn)[25]).toBe('...and 3 more coverage-bleed warning(s) suppressed');
        });

        it('logs nothing for no late hits', () => {
            internals.emitCoverageBleedWarnings([], new Map());

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('buildLocalTestFilterIndex', () => {
        it('indexes base names to every suffixed id and gives each suffixed id an identity entry', () => {
            const { localRegistry, localBaseIndex } = internals.buildLocalTestFilterIndex(['a [1]', 'a [2]', 'b']);

            expect([...localRegistry]).toEqual(['a [1]', 'a [2]', 'b']);
            expect(localBaseIndex.get('a')).toEqual(['a [1]', 'a [2]']);
            expect(localBaseIndex.get('a [1]')).toEqual(['a [1]']);
            expect(localBaseIndex.get('a [2]')).toEqual(['a [2]']);
            expect(localBaseIndex.get('b')).toEqual(['b']);
            expect(localBaseIndex.size).toBe(4);
        });

        it('keeps the unsuffixed id AND its suffixed siblings under the base name, whatever the order', () => {
            const suffixedFirst = internals.buildLocalTestFilterIndex(['x [1]', 'x']).localBaseIndex;
            const plainFirst = internals.buildLocalTestFilterIndex(['x', 'x [1]']).localBaseIndex;

            expect(suffixedFirst.get('x')).toEqual(['x [1]', 'x']);
            expect(plainFirst.get('x')).toEqual(['x', 'x [1]']);
            expect(plainFirst.get('x [1]')).toEqual(['x [1]']);
        });
    });

    describe('resolveKilledBy', () => {
        function resolve(raw: string[], filter: string[]): string[] {
            const { localRegistry, localBaseIndex } = internals.buildLocalTestFilterIndex(filter);
            return internals.resolveKilledBy(raw, localRegistry, localBaseIndex, 'm1');
        }

        it('an exact registry id resolves to exactly itself, not to its suffixed siblings', () => {
            expect(resolve(['x'], ['x', 'x [1]'])).toEqual(['x']);
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        it('a base name expands to every local registry id, and says so', () => {
            expect(resolve(['x'], ['x [1]', 'x [2]'])).toEqual(['x [1]', 'x [2]']);

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(rendered(mockLogger.debug)[0]).toBe('Expanded killedBy base name "x" → 2 local registry IDs for mutant m1');
        });

        it('an exact name known only to the instance registry resolves to exactly itself', () => {
            internals.cachedTestNames = new Set(['y']);
            internals.baseNameIndex = new Map([['y', ['y', 'y [1]']]]);

            expect(resolve(['y'], ['other'])).toEqual(['y']);
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        it('a base name known only to the instance registry expands, and says so', () => {
            internals.cachedTestNames = new Set(['z [1]', 'z [2]']);
            internals.baseNameIndex = new Map([['z', ['z [1]', 'z [2]']]]);

            expect(resolve(['z'], ['other'])).toEqual(['z [1]', 'z [2]']);

            expect(rendered(mockLogger.debug)).toEqual(['Expanded killedBy base name "z" → 2 instance registry IDs for mutant m1']);
        });

        it('drops names no registry knows, with one warning', () => {
            expect(resolve(['ghost'], ['other'])).toEqual([]);

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(rendered(mockLogger.warn)[0]).toContain('ghost');
        });

        const unresolvedWarning = (count: number, sample: string): string => `Mutant m1: ${count} failed test name(s) could not be resolved to dry-run test ids `
          + `and will not be recorded in killedBy — this mutant's Killed verdict will not be reusable from the incremental cache: ${sample}`;

        it('names every unresolved test, comma-separated and without an ellipsis, when there are at most five', () => {
            expect(resolve(['g1', 'g2', 'g3', 'g4', 'g5'], ['other'])).toEqual([]);

            expect(rendered(mockLogger.warn)).toEqual([unresolvedWarning(5, 'g1, g2, g3, g4, g5')]);
        });

        it('names only the first five unresolved tests, then an ellipsis, when there are more', () => {
            expect(resolve(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'], ['other'])).toEqual([]);

            expect(rendered(mockLogger.warn)).toEqual([unresolvedWarning(6, 'g1, g2, g3, g4, g5, …')]);
        });
    });

    describe('warnLossyPatternAlternatives', () => {
        const registryMissWarning = (missing: number, total: number, sample: string): string => `Mutant m2: ${missing} of ${total} testFilter ids missing from exact-name registry `
          + `(lossy fallback; " > " titles among them may be silently dropped): ${sample}`;

        beforeEach(() => {
            internals.testNameIndex = new Map([['present', 'present']]);
        });

        it('names one missing id exactly, without an ellipsis', () => {
            internals.warnLossyPatternAlternatives(['present', 'a'], 'm2');

            expect(rendered(mockLogger.warn)).toEqual([registryMissWarning(1, 2, 'a')]);
        });

        it('names all missing ids, comma-separated and without an ellipsis, when there are exactly five', () => {
            internals.warnLossyPatternAlternatives(['a', 'b', 'present', 'c', 'd', 'e'], 'm2');

            expect(rendered(mockLogger.warn)).toEqual([registryMissWarning(5, 6, 'a, b, c, d, e')]);
        });

        it('names only the first five missing ids, then an ellipsis, when there are more', () => {
            internals.warnLossyPatternAlternatives(['a', 'b', 'c', 'present', 'd', 'e', 'f'], 'm2');

            expect(rendered(mockLogger.warn)).toEqual([registryMissWarning(6, 7, 'a, b, c, d, e, …')]);
        });
    });

    describe('dispose', () => {
        it('cleans up the sanitized bunfig and says so', async () => {
            const cleanup = spyOn(bunfigSanitizer, 'cleanupSanitizedBunfig').mockResolvedValue(undefined);
            internals.sanitizedBunfigPath = '/tmp/sanitized-bunfig.toml';

            await runner.dispose();

            expect(cleanup).toHaveBeenCalledTimes(1);
            expect(cleanup).toHaveBeenCalledWith('/tmp/sanitized-bunfig.toml');
            expect(rendered(mockLogger.debug)).toContain('Cleaning up sanitized bunfig: /tmp/sanitized-bunfig.toml');
        });

        it('does not touch the sanitizer when no sanitized bunfig exists', async () => {
            const cleanup = spyOn(bunfigSanitizer, 'cleanupSanitizedBunfig').mockResolvedValue(undefined);

            await runner.dispose();

            expect(cleanup).not.toHaveBeenCalled();
        });
    });
});
