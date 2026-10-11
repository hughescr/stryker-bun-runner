/**
 * tests/leak-guard.ts in a whole `bun test` run: a child `bun test`, with this
 * suite's preload, runs fixture files that leak on purpose. The guard must
 * fail exactly the test (or file) that leaked, naming what leaked, put the
 * state back so the tests after it pass, and leave file and describe-level
 * fixtures that are cleaned up in afterAll alone.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetFsMocks } from '../test-preload.js';

const PRELOAD = path.resolve(import.meta.dir, '..', 'test-preload.ts');

/** A test file that leaks a little of everything, each leak followed by a test that needs it gone. */
const LEAKS = String.raw`
import { describe, expect, jest, mock, spyOn, test, beforeAll, afterAll } from 'bun:test';
import { mockSpawn } from ${JSON.stringify(PRELOAD)};

test('leaves a spy', () => {
    spyOn(process, 'uptime').mockReturnValue(-1);
});

test('finds the spy restored', () => {
    expect(process.uptime()).not.toBe(-1);
});

test('leaves an implementation and a call on a shared mock', () => {
    mockSpawn.mockImplementation(() => undefined as never);
    mockSpawn('nothing');
});

test('finds the shared mock clean', () => {
    expect(mockSpawn).not.toHaveBeenCalled();
});

test('leaves an env key, a listener and fake timers', () => {
    process.env.LEAK_GUARD_FIXTURE = 'set';
    process.on('SIGUSR2', () => undefined);
    jest.useFakeTimers();
});

test('finds them all undone', () => {
    expect(process.env.LEAK_GUARD_FIXTURE).toBeUndefined();
    expect(process.listenerCount('SIGUSR2')).toBe(0);
    expect(jest.isFakeTimers()).toBe(false);
});

test('mocks a module', () => {
    mock.module('leak-guard-fixture-module', () => ({}));
});

describe('a describe-level fixture cleaned up in its afterAll', () => {
    let spy: ReturnType<typeof spyOn>;
    beforeAll(() => {
        spy = spyOn(process, 'hrtime');
        process.env.LEAK_GUARD_DESCRIBE = 'set';
    });
    afterAll(() => {
        spy.mockRestore();
        delete process.env.LEAK_GUARD_DESCRIBE;
    });

    test('is not a leak of the test that runs under it', () => {
        expect(process.hrtime).toBe(spy);
    });
});
`;

/** A file whose beforeAll fixture is never cleaned up. */
const FILE_LEAK = String.raw`
import { beforeAll, spyOn, test } from 'bun:test';

beforeAll(() => {
    spyOn(process, 'uptime');
    process.env.LEAK_GUARD_FILE = 'set';
});

test('passes on its own', () => undefined);
`;

/**
 * A file whose beforeAll fixture is cleaned up in its afterAll, and whose tests
 * each clear the calls they record on the file's spy.
 */
const FILE_CLEAN = String.raw`
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';

let spy: ReturnType<typeof spyOn>;
beforeAll(() => {
    spy = spyOn(process, 'uptime').mockReturnValue(-1);
    process.env.LEAK_GUARD_FILE = 'set';
});
afterEach(() => {
    spy.mockClear();
});
afterAll(() => {
    spy.mockRestore();
    delete process.env.LEAK_GUARD_FILE;
});

test('one', () => {
    expect(process.uptime()).toBe(-1);
    expect(spy).toHaveBeenCalledTimes(1);
});
test('two', () => {
    expect(process.uptime()).toBe(-1);
    expect(spy).toHaveBeenCalledTimes(1);
});
`;

interface Outcome {
    exitCode: number
    /** Per test, keyed "file > name", its failure message, or '' when it passed. */
    results:  Map<string, string>
    /** Everything the child printed, and its JUnit report: shown when an expectation fails. */
    output:   string
}

function unescapeXml(text: string): string {
    const entities: Record<string, string> = { amp: '&', apos: '\'', quot: '"', lt: '<', gt: '>' };
    return text.replaceAll(/&(#\d+|\w+);/g, (_match, entity: string) => (entity.startsWith('#')
        ? String.fromCodePoint(Number(entity.slice(1)))
        : entities[entity] ?? `&${entity};`));
}

/** Each test case of bun's JUnit report: "file > describe > name" to its failure message ('' when it passed). */
function parseJunit(xml: string): Map<string, string> {
    const results = new Map<string, string>();
    for(const [, attributes, body = ''] of xml.matchAll(/<testcase ([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const attribute = (name: string): string => unescapeXml(new RegExp(String.raw`\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? '');
        const name = [attribute('file'), attribute('classname'), attribute('name')].filter(part => part !== '').join(' > ');
        results.set(name, unescapeXml(/<failure [^>]*?message="([^"]*)"/.exec(body)?.[1] ?? ''));
    }
    return results;
}

describe('leak guard in a bun test run', () => {
    let fixture: string;
    let outcome: Outcome;

    beforeAll(async () => {
        fixture = await mkdtemp(path.join(tmpdir(), 'stryker-bun-leak-guard-'));
        await writeFile(path.join(fixture, 'leaks.test.ts'), LEAKS);
        await writeFile(path.join(fixture, 'file-leak.test.ts'), FILE_LEAK);
        await writeFile(path.join(fixture, 'file-clean.test.ts'), FILE_CLEAN);
        // A plain run: no colours, and none of a surrounding Stryker run's settings.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FORCE_COLOR' && !key.startsWith('__STRYKER')));
        const report = path.join(fixture, 'report.xml');
        const child = Bun.spawn(
            [
                process.execPath, 'test', '--preload', PRELOAD, '--reporter=junit', `--reporter-outfile=${report}`,
                './leaks.test.ts', './file-leak.test.ts', './file-clean.test.ts',
            ],
            { cwd: fixture, env, stdout: 'pipe', stderr: 'pipe' }
        );
        // This subprocess is intentionally Bun-owned; Bun implements the web
        // Response API even though the package's Node compatibility floor predates it.
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- executed only by Bun's integration-test runtime
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const xml = await Bun.file(report).text();
        outcome = { exitCode, results: parseJunit(xml), output: `${stdout}\n${stderr}\n${xml}` };
    });

    /** The failure message of a test case ('' when it passed); fails, showing the run, when there is no such case. */
    function result(name: string): string {
        const message = outcome.results.get(name);
        expect(message, `no test case "${name}" in:\n${outcome.output}`).toBeDefined();
        return message ?? '';
    }

    afterAll(async () => {
        await rm(fixture, { recursive: true, force: true });
        // The fixture writes above went through the preload's shared fs mocks, which record every call.
        resetFsMocks();
    });

    test('fails the run', () => {
        expect(outcome.exitCode, outcome.output).toBe(1);
    });

    test('fails a test that leaves a spy, naming the spy and the line that made it', () => {
        const message = result('leaks.test.ts > leaves a spy');
        expect(message).toStartWith('This test left state behind that leaks into the tests after it (1 leak):');
        expect(message).toContain('spyOn(process, "uptime")');
        expect(message).toContain('leaks.test.ts:6:');
    });

    test('fails a test that leaves state on a shared mock', () => {
        expect(result('leaks.test.ts > leaves an implementation and a call on a shared mock')).toContain(
            'mock mockSpawn (tests/test-preload.ts): 1 recorded call(s) not cleared (mockClear() it after the test); its implementation was changed and not put back'
        );
    });

    test('fails a test that leaves an env key, a listener and fake timers, naming each', () => {
        const message = result('leaks.test.ts > leaves an env key, a listener and fake timers');
        expect(message).toContain('process.env.LEAK_GUARD_FIXTURE was added and not restored');
        expect(message).toContain('1 process \'SIGUSR2\' listener(s) added and not removed');
        expect(message).toContain('fake timers are still installed');
    });

    test('fails a test that mocks a module, which bun cannot undo, and only that test', () => {
        const message = result('leaks.test.ts > mocks a module');
        expect(message).toContain('mock.module(\'leak-guard-fixture-module\')');
        expect(message).toContain('bun cannot undo a module mock');
        // Reported once: not again when the file ends.
        expect(outcome.results.has('leaks.test.ts > (unnamed)'), outcome.output).toBe(false);
    });

    test('puts each leak back, so the test after it passes', () => {
        expect(result('leaks.test.ts > finds the spy restored')).toBe('');
        expect(result('leaks.test.ts > finds the shared mock clean')).toBe('');
        expect(result('leaks.test.ts > finds them all undone')).toBe('');
    });

    test('leaves a describe-level fixture cleaned up in its afterAll alone', () => {
        const names = [...outcome.results.keys()].filter(name => name.endsWith('is not a leak of the test that runs under it'));
        expect(names, outcome.output).toHaveLength(1);
        expect(result(names[0])).toBe('');
    });

    test('fails a file whose beforeAll fixture is never cleaned up, naming the file and the fixture', () => {
        expect(result('file-leak.test.ts > passes on its own')).toBe('');
        const message = result('file-leak.test.ts > (unnamed)');
        expect(message).toMatch(/^Test file \S*file-leak\.test\.ts \(its beforeAll\/afterAll or top level\) left state behind/);
        expect(message).toContain('spyOn(process, "uptime")');
        expect(message).toContain('process.env.LEAK_GUARD_FILE was added and not restored');
    });

    test('leaves a file-level fixture cleaned up in its afterAll alone', () => {
        expect(result('file-clean.test.ts > one')).toBe('');
        expect(result('file-clean.test.ts > two')).toBe('');
        expect(outcome.results.has('file-clean.test.ts > (unnamed)'), outcome.output).toBe(false);
    });
});
