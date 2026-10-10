/**
 * Stryker's infinite-loop protection (hitLimit) through real `bun test` children:
 * the dry run reports real hit counts, and a mutant that loops forever is stopped
 * by the instrumenter's hit limit and scored Timeout in well under its time budget.
 */

import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, type MutantRunOptions } from '@stryker-mutator/api/test-runner';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { resolveRunTempDir } from '../../src/utils/private-temp-dir.js';
import { allowRealTimersFromSource } from '../real-clock-guard.js';
import { resetAllMocks } from '../test-preload.js';

// Real bun children: the runner's own timers (inspector-URL timeout, drain-silence
// poll) have to run on real time here. The tests themselves wait on nothing but
// the runner's results.
allowRealTimersFromSource();

/**
 * Real output of @stryker-mutator/instrumenter 10.0.0 for
 *
 *     export function sumBelow(n) {
 *         let total = 0;
 *         let i = 0;
 *         while (i < n) {
 *             total += i;
 *             i++;
 *         }
 *         return total;
 *     }
 *
 * Its mutants: 0 BlockStatement (whole body), 1 ConditionalExpression `false`,
 * 2 EqualityOperator `i <= n`, 3 EqualityOperator `i >= n`, 4 BlockStatement
 * (loop body — never increments: loops forever), 5 AssignmentOperator
 * `total -= i`, 6 UpdateOperator `i--` (loops forever).
 */
const INSTRUMENTED_LOOP = `function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
export function sumBelow(n) {
  if (stryMutAct_9fa48("0")) {
    {}
  } else {
    stryCov_9fa48("0");
    let total = 0;
    let i = 0;
    while (stryMutAct_9fa48("3") ? i >= n : stryMutAct_9fa48("2") ? i <= n : stryMutAct_9fa48("1") ? false : (stryCov_9fa48("1", "2", "3"), i < n)) {
      if (stryMutAct_9fa48("4")) {
        {}
      } else {
        stryCov_9fa48("4");
        stryMutAct_9fa48("5") ? total -= i : (stryCov_9fa48("5"), total += i);
        stryMutAct_9fa48("6") ? i-- : (stryCov_9fa48("6"), i++);
      }
    }
    return total;
  }
}
`;

/** Stryker core's HIT_LIMIT_FACTOR (mutants/mutant-test-planner.js): hitLimit = 100 × the mutant's dry-run hits. */
const HIT_LIMIT_FACTOR = 100;

const silentLogger = {
    debug:          () => {},
    info:           () => {},
    warn:           () => {},
    error:          () => {},
    trace:          () => {},
    fatal:          () => {},
    isDebugEnabled: () => false,
    isInfoEnabled:  () => false,
    isWarnEnabled:  () => false,
    isErrorEnabled: () => false,
    isTraceEnabled: () => false,
    isFatalEnabled: () => false,
} as unknown as Logger;

describe('hit limit (real bun children)', () => {
    let tempDir: string;
    let sumTestFile: string;
    let swallowTestFile: string;
    let spoofTestFile: string;
    let originalForceColor: string | undefined;

    function createRunner(testFile: string): BunTestRunner {
        return new BunTestRunner(silentLogger, {
            bun: {
                bunPath:          'bun',
                timeout:          60_000,
                inspectorTimeout: 30_000,
                maxSpawnDepth:    2, // under Stryker this suite is itself a depth-1 run
                testFiles:        [testFile],
            },
            coverageAnalysis: 'perTest',
            testRunner:       { name: 'bun' },
        } as unknown as StrykerOptions);
    }

    /** Dry run, then the covering test's id and its real hit count for `mutantId`. */
    async function dryRunFor(runner: BunTestRunner, mutantId: string): Promise<{ testId: string, hits: number }> {
        await runner.init();
        const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);
        if(dryRun.status !== DryRunStatus.Complete) {
            throw new Error(`dry run did not complete: ${JSON.stringify(dryRun)}`);
        }
        const [onlyTest] = dryRun.tests;
        return { testId: onlyTest.id, hits: dryRun.mutantCoverage!.perTest[onlyTest.id][mutantId] };
    }

    beforeAll(async () => {
        resetAllMocks();
        // See inspector-integration.test.ts: a set FORCE_COLOR breaks the inspector-URL scrape.
        originalForceColor = process.env.FORCE_COLOR;
        delete process.env.FORCE_COLOR;

        tempDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'hit-limit-integration-'));
        await fsPromises.writeFile(path.join(tempDir, 'loop.js'), INSTRUMENTED_LOOP);
        sumTestFile = path.join(tempDir, 'sum.test.ts');
        await fsPromises.writeFile(sumTestFile, [
            "import { test, expect } from 'bun:test';",
            "import { sumBelow } from './loop.js';",
            "test('sums the numbers below ten', () => { expect(sumBelow(10)).toBe(45); });",
        ].join('\n'));
        // A test that swallows every error, including the instrumenter's hit-limit error.
        swallowTestFile = path.join(tempDir, 'swallow.test.ts');
        await fsPromises.writeFile(swallowTestFile, [
            "import { test, expect } from 'bun:test';",
            "import { sumBelow } from './loop.js';",
            "test('tolerates a failing sum', () => { let r; try { r = sumBelow(10); } catch { r = 45; } expect(r).toBe(45); });",
        ].join('\n'));
        // A test that asserts nothing and prints lines shaped like the preload's sentinel:
        // one in the token-less format, one signed with whatever token the test can read.
        spoofTestFile = path.join(tempDir, 'spoof.test.ts');
        await fsPromises.writeFile(spoofTestFile, [
            "import { test } from 'bun:test';",
            "import { writeSync } from 'node:fs';",
            "import { sumBelow } from './loop.js';",
            "test('prints sentinel-shaped lines', () => {",
            '    sumBelow(10);',
            String.raw`    writeSync(2, '\n__STRYKER_HIT_LIMIT_REACHED__ 999999\n');`,
            String.raw`    writeSync(2, '\n__STRYKER_HIT_LIMIT_REACHED__ ' + process.env.__STRYKER_HIT_LIMIT_TOKEN__ + ' 999999\n');`,
            '});',
        ].join('\n'));
    });

    afterAll(async () => {
        if(originalForceColor !== undefined) {
            process.env.FORCE_COLOR = originalForceColor;
        }
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        // Clean up the run's private temp directory (and the dryRun registry the runner
        // leaves in it), resolved exactly as the runner resolves it for this process.
        await fsPromises.rm(await resolveRunTempDir(), { recursive: true, force: true });
    });

    test('the dry run reports the instrumenter\'s real hit counts', async () => {
        const runner = createRunner(sumTestFile);
        try {
            await runner.init();
            const dryRun = await runner.dryRun({ coverageAnalysis: 'perTest' } as Parameters<BunTestRunner['dryRun']>[0]);
            expect(dryRun.status).toBe(DryRunStatus.Complete);
            if(dryRun.status !== DryRunStatus.Complete) {
                return;
            }
            const [onlyTest] = dryRun.tests;
            // sumBelow(10): the body runs once, the loop condition 11 times, the loop body 10 times.
            expect(dryRun.mutantCoverage!.perTest[onlyTest.id]).toEqual({ '0': 1, '1': 11, '2': 11, '3': 11, '4': 10, '5': 10, '6': 10 });
        } finally {
            await runner.dispose();
        }
    }, 60_000);

    test('stops a mutant that loops forever at its hit limit and scores it Timeout, long before its time budget', async () => {
        const runner = createRunner(sumTestFile);
        try {
            const { testId, hits } = await dryRunFor(runner, '6');
            const hitLimit = HIT_LIMIT_FACTOR * hits;

            const startedAt = Date.now();
            const result = await runner.mutantRun({
                activeMutant:    { id: '6' },
                testFilter:      [testId],
                sandboxFileName: path.join(tempDir, 'loop.js'),
                timeout:         30_000,
                hitLimit,
            } as unknown as MutantRunOptions);
            const elapsedMs = Date.now() - startedAt;

            expect(result).toEqual({ status: MutantRunStatus.Timeout, reason: `Hit limit reached (${hitLimit + 1}/${hitLimit})` });
            // Without the hit limit this run would spin until the runner's kill at ~28.5 s.
            expect(elapsedMs).toBeLessThan(15_000);
        } finally {
            await runner.dispose();
        }
    }, 60_000);

    test('scores Timeout when the test swallows the instrumenter\'s hit-limit error and passes', async () => {
        const runner = createRunner(swallowTestFile);
        try {
            const { testId, hits } = await dryRunFor(runner, '4');
            const hitLimit = HIT_LIMIT_FACTOR * hits;

            const result = await runner.mutantRun({
                activeMutant:    { id: '4' },
                testFilter:      [testId],
                sandboxFileName: path.join(tempDir, 'loop.js'),
                timeout:         30_000,
                hitLimit,
            } as unknown as MutantRunOptions);

            expect(result).toEqual({ status: MutantRunStatus.Timeout, reason: `Hit limit reached (${hitLimit + 1}/${hitLimit})` });
        } finally {
            await runner.dispose();
        }
    }, 60_000);

    test('does not let a test that prints sentinel-shaped lines turn a surviving mutant into a Timeout', async () => {
        // `total -= i` terminates and the test asserts nothing, so the mutant survives.
        // The token-less line is rejected by format; the signed one fails because the
        // preload removes the token from process.env before any test code runs.
        const runner = createRunner(spoofTestFile);
        try {
            const { testId, hits } = await dryRunFor(runner, '5');

            const result = await runner.mutantRun({
                activeMutant:    { id: '5' },
                testFilter:      [testId],
                sandboxFileName: path.join(tempDir, 'loop.js'),
                timeout:         30_000,
                hitLimit:        HIT_LIMIT_FACTOR * hits,
            } as unknown as MutantRunOptions);

            expect(result.status).toBe(MutantRunStatus.Survived);
        } finally {
            await runner.dispose();
        }
    }, 60_000);

    test('does not flag a mutant that is hit more often than in the dry run but terminates', async () => {
        // `i <= n` runs one extra iteration: 12 hits against a limit of 100 × 11. It is
        // an ordinary kill (the sum is wrong), not a runaway.
        const runner = createRunner(sumTestFile);
        try {
            const { testId, hits } = await dryRunFor(runner, '2');

            const result = await runner.mutantRun({
                activeMutant:    { id: '2' },
                testFilter:      [testId],
                sandboxFileName: path.join(tempDir, 'loop.js'),
                timeout:         30_000,
                hitLimit:        HIT_LIMIT_FACTOR * hits,
            } as unknown as MutantRunOptions);

            expect(result.status).toBe(MutantRunStatus.Killed);
        } finally {
            await runner.dispose();
        }
    }, 60_000);
});
