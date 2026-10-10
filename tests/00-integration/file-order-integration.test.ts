/**
 * What a mutant run's `bun test` child really does with the runner's file order,
 * randomize setting and failure output (real bun children, bun 1.4.2 measured).
 *
 * - Files handed to runBunTests run in the order given, and with --bail the run
 *   stops at the first failure in that order. (Bare relative arguments would be
 *   substring filters that bun runs in its own scan order, also matching a
 *   `dist/` copy; runBunTests passes absolute paths.)
 * - The sanitizer's mutant-run copy of a bunfig that sets `randomize`/`seed`
 *   runs files and tests in the given order; the bunfig itself shuffles both.
 * - A failing assertion whose diff contains a header-shaped line is still
 *   credited to the right file once the parser knows the run's files.
 *
 * Each case runs in its own `bun --eval` process whose cwd is the fixture,
 * because runBunTests resolves relative files against the cwd.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const SRC = (file: string): string => new URL(`../../src/${file}`, import.meta.url).href;

/** A test file whose tests print `RAN <label><n>` to stderr; test `failAt` (1-based) fails. */
function fixtureFile(label: string, tests: number, failAt?: number): string {
    const lines = ['import { test, expect } from \'bun:test\';'];
    for(let n = 1; n <= tests; n++) {
        lines.push(`test('${label}${n}', () => { console.error('RAN ${label}${n}'); expect(${n === failAt ? 1 : 0}).toBe(0); });`);
    }
    return lines.join('\n');
}

let fixture: string;

beforeAll(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'stryker-bun-file-order-'));
    await mkdir(path.join(fixture, 'tests', 'unit'), { recursive: true });
    await mkdir(path.join(fixture, 'tests', '00-integration'), { recursive: true });
    await mkdir(path.join(fixture, 'dist', 'tests', 'unit'), { recursive: true });
    await mkdir(path.join(fixture, 'private'), { mode: 0o700 });
    await writeFile(path.join(fixture, 'tests', 'unit', 'a.test.ts'), fixtureFile('A', 3));
    await writeFile(path.join(fixture, 'tests', 'unit', 'b.test.ts'), fixtureFile('B', 3, 2));
    await writeFile(path.join(fixture, 'tests', 'unit', 'c.test.ts'), fixtureFile('C', 3, 1));
    await writeFile(path.join(fixture, 'tests', '00-integration', 'slow.test.ts'), fixtureFile('S', 3));
    await writeFile(path.join(fixture, 'dist', 'tests', 'unit', 'a.test.ts'), fixtureFile('DIST', 1));
    await writeFile(path.join(fixture, 'tests', 'unit', 'diff.test.ts'), [
        'import { test, expect } from \'bun:test\';',
        String.raw`test('reports a nested run', () => { expect('bun test v1\n\ntests/foo.test.ts:\n(pass) inner').toBe('x'); });`,
    ].join('\n'));
    await writeFile(path.join(fixture, 'bunfig.toml'), '[test]\nrandomize = true\nseed = 3\n');
});

afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
});

interface ChildRun { ran: string[], stdout: string, stderr: string, exitCode: number | null }

/** Run `body` (which must set `result` to a runBunTests result) in a bun process whose cwd is the fixture. */
async function inFixture(body: string): Promise<ChildRun & { extra?: unknown }> {
    const script = [
        `const { runBunTests } = await import(${JSON.stringify(SRC('process-runner.ts'))});`,
        `const { generateSanitizedBunfig, mutantRunBunfigPath } = await import(${JSON.stringify(SRC('utils/bunfig-sanitizer.ts'))});`,
        `const { parseBunTestOutput } = await import(${JSON.stringify(SRC('parsers/console-parser.ts'))});`,
        'let result; let extra;',
        body,
        String.raw`const ran = [...result.stderr.matchAll(/^RAN (\S+)$/gm)].map(m => m[1]);`,
        'console.log(JSON.stringify({ ran, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, extra }));',
    ].join('\n');
    const proc = Bun.spawn([process.execPath, '--eval', script], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' });
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- executed only by Bun's integration-test runtime
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as ChildRun & { extra?: unknown };
}

const RUN = (files: string[], extra = ''): string =>
    `result = await runBunTests({ bunPath: process.execPath, timeout: 10000, maxSpawnDepth: 2, bunfigPath: ${JSON.stringify('/dev/null')}, testFiles: ${JSON.stringify(files)}${extra} });`;

describe('file order in a real bun test child', () => {
    it('runs relative files in the order given, and only those files (not the dist/ copy a filter would match)', async () => {
        const run = await inFixture(RUN(['tests/unit/a.test.ts', 'tests/00-integration/slow.test.ts']));
        const reversed = await inFixture(RUN(['tests/00-integration/slow.test.ts', 'tests/unit/a.test.ts']));

        expect(run.ran).toEqual(['A1', 'A2', 'A3', 'S1', 'S2', 'S3']);
        expect(reversed.ran).toEqual(['S1', 'S2', 'S3', 'A1', 'A2', 'A3']);
    });

    it('with bail, stops at the first failure in the order given', async () => {
        const run = await inFixture(RUN(['tests/unit/a.test.ts', 'tests/unit/c.test.ts', 'tests/unit/b.test.ts'], ', bail: true'));
        const other = await inFixture(RUN(['tests/unit/b.test.ts', 'tests/unit/c.test.ts'], ', bail: true'));

        expect(run.exitCode).toBe(1);
        expect(run.ran).toEqual(['A1', 'A2', 'A3', 'C1']);
        expect(other.ran).toEqual(['B1', 'B2']);
    });
});

describe('randomized order in a real bun test child', () => {
    const FILES = ['tests/unit/a.test.ts', 'tests/00-integration/slow.test.ts'];
    const GIVEN = ['A1', 'A2', 'A3', 'S1', 'S2', 'S3'];

    it('the sanitized bunfig keeps the project\'s randomize = true / seed = 3, which shuffles files and tests', async () => {
        const run = await inFixture([
            'const bunfig = await generateSanitizedBunfig(process.cwd(), process.cwd() + \'/private\');',
            RUN(FILES).replace('"/dev/null"', 'bunfig'),
        ].join('\n'));

        expect(run.ran).not.toEqual(GIVEN);
        expect(run.ran.toSorted((a, b) => a.localeCompare(b))).toEqual(GIVEN);
    });

    it('its mutant-run copy runs files and tests in the order given', async () => {
        const run = await inFixture([
            'const bunfig = mutantRunBunfigPath(await generateSanitizedBunfig(process.cwd(), process.cwd() + \'/private\'));',
            RUN(FILES).replace('"/dev/null"', 'bunfig'),
        ].join('\n'));

        expect(run.ran).toEqual(GIVEN);
    });
});

describe('failure output in a real bun test child', () => {
    it('credits a failing test whose diff holds a header-shaped line to its own file', async () => {
        const files = ['tests/unit/a.test.ts', 'tests/unit/diff.test.ts'];
        const run = await inFixture([
            RUN(files, ', bail: true'),
            `extra = { withFiles: parseBunTestOutput(result.stdout, result.stderr, ${JSON.stringify(files)}).tests.filter(t => t.status === 'failed').map(t => t.name),`
            + ' without: parseBunTestOutput(result.stdout, result.stderr).tests.filter(t => t.status === \'failed\').map(t => t.name) };',
        ].join('\n'));

        expect(run.stderr).toContain('+ tests/foo.test.ts:');
        expect(run.extra).toEqual({
            withFiles: ['tests/unit/diff.test.ts > reports a nested run'],
            without:   ['+ tests/foo.test.ts > reports a nested run'],
        });
    });
});
