/**
 * Unit tests for src/checker-tsconfig: the derived tsconfig that keeps Bun's
 * test files (and what only they import) out of the TypeScript checker.
 *
 * Every test builds a small real project in a temp dir, with this repo's own
 * typescript linked into its node_modules, because the behaviour under test is
 * TypeScript's own config parsing and module resolution.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PartialStrykerOptions } from '@stryker-mutator/api/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type * as TypeScript from 'typescript';
import { withTestFilesExcludedFromTypeCheck } from '../../src/checker-tsconfig.js';
import { withTestFilesExcludedFromTypeCheck as fromIndex } from '../../src/index.js';
import { mockRename, mockWriteFile, resetFsMocks } from '../test-preload.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const ts = createRequire(path.join(REPO_ROOT, 'package.json'))('typescript') as typeof TypeScript;

/**
 * `lib` is spelled out because the default for an ES2022 target adds the DOM
 * and web-worker declarations, which no project here uses. Parsing and binding
 * them is most of the work in each of the several TypeScript programs a test
 * builds (the helper's own and the ones `compile` checks), enough that a test
 * could outrun bun's 5 s test timeout on a busy machine.
 */
const COMPILER_OPTIONS = {
    strict:           true,
    target:           'ES2022',
    lib:              ['ES2022'],
    module:           'ESNext',
    moduleResolution: 'bundler',
    types:            [],
    noEmit:           true,
    skipLibCheck:     true,
};

/** The one thing the helper requires of a config: the TypeScript checker. */
const CHECKED = { checkers: ['typescript'] };

/** Start of every line the helper logs. */
const PREFIX = '[Stryker] withTestFilesExcludedFromTypeCheck: ';

/** A project with src, Bun tests under tests/ (the bunfig root), a preload, helpers and a stray test outside the root. */
const BASE_FILES: Record<string, string> = {
    'tsconfig.json':                JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src', 'tests', 'other'] }),
    'bunfig.toml':                  '[test]\nroot = "tests"\npreload = ["./tests/setup.ts"]\n',
    'src/a.ts':                     'export const a = 1;\n',
    'src/b.ts':                     'import { a } from \'./a.js\';\nexport const b: number = a;\n',
    'src/entry.ts':                 'import { b } from \'./b.js\';\nexport const entry: number = b;\n',
    'tests/a.test.ts':              'import { entry } from \'../src/entry.js\';\nimport { helper } from \'./helpers/helper.js\';\nimport \'not-installed\';\nvoid [entry, helper];\n',
    'tests/setup.ts':               'import { a } from \'../src/a.js\';\nvoid a;\n',
    'tests/helpers/helper.ts':      'import { a } from \'../../src/a.js\';\nimport { deep } from \'./deep.js\';\nexport const helper: number = a + deep;\n',
    'tests/helpers/deep.ts':        'export const deep = 2;\n',
    'tests/fixtures/standalone.ts': 'export const standalone = 3;\n',
    'other/outside.test.ts':        'import { a } from \'../src/a.js\';\nvoid a;\n',
};

/** BASE_FILES with a `types` directory in the project, for the files that only tests import but the code under test relies on. */
const WITH_TYPES: Record<string, string> = {
    ...BASE_FILES,
    'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src', 'tests', 'other', 'types'] }),
};

/** A src file that needs the global `APP_NAME`, declared wherever the test supplies it. */
const USES_APP_NAME = 'import { a } from \'./a.js\';\nexport const b: number = a + Number(globalThis.APP_NAME);\n';

let dir: string;
let warn: ReturnType<typeof spyOn<Console, 'warn'>>;
let info: ReturnType<typeof spyOn<Console, 'info'>>;

/** Write `files` (relative path → content) into a fresh project dir with typescript linked in. */
async function makeProject(files: Record<string, string>, linkTypescript = true): Promise<string> {
    // realpath: TypeScript resolves imports to real paths, so the project path must be one too.
    const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'checker-tsconfig-')));
    if(linkTypescript) {
        await mkdir(path.join(root, 'node_modules'));
        await symlink(path.join(REPO_ROOT, 'node_modules', 'typescript'), path.join(root, 'node_modules', 'typescript'));
    }
    await Promise.all(Object.entries(files).map(async ([file, content]) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content);
    }));
    return root;
}

/** The text of the file at `relativePath` inside the project. */
async function readProjectFile(relativePath: string): Promise<string> {
    return readFile(path.join(dir, relativePath), 'utf8');
}

/** The `files` list of the derived tsconfig at `relativePath` inside the project. */
async function derivedFiles(relativePath: string): Promise<string[]> {
    const { config } = ts.parseConfigFileTextToJson(relativePath, await readProjectFile(relativePath)) as { config: { files: string[] } };
    return config.files;
}

/** Project-relative names of the non-library source files TypeScript's program for `tsconfigFile` contains, plus its diagnostics. */
function compile(tsconfigFile: string): { files: string[], diagnostics: string[] } {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(dir, tsconfigFile), undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    return {
        files: program.getSourceFiles()
            .map(file => path.relative(dir, file.fileName))
            .filter(file => !file.startsWith('node_modules') && !file.startsWith('..'))
            .toSorted((left, right) => left.localeCompare(right)),
        diagnostics: [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    };
}

/** Names of the temp files the helper may have left in the project dir. */
async function tempFiles(): Promise<string[]> {
    const names = await readdir(dir);
    return names.filter(name => name.includes('.tmp'));
}

/** Everything the helper has logged with console.warn, one string per call. */
function warnings(): string[] {
    return warn.mock.calls.map(call => call.join(' '));
}

/** Everything the helper has logged with console.info, one string per call. */
function infos(): string[] {
    return info.mock.calls.map(call => call.join(' '));
}

beforeEach(() => {
    resetFsMocks();
    dir = '';
    warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    info = spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
    warn.mockRestore();
    info.mockRestore();
    if(dir !== '') {
        await rm(dir, { recursive: true, force: true });
    }
});

describe('withTestFilesExcludedFromTypeCheck', () => {
    it('is exported from the package entry point', () => {
        expect(fromIndex).toBe(withTestFilesExcludedFromTypeCheck);
    });

    it('writes a tsconfig next to the original that leaves out tests, preloads and files only tests import', async () => {
        dir = await makeProject(BASE_FILES);
        const config = { testRunner: 'bun', checkers: ['typescript'], ignorePatterns: ['**', '!src/**'] };

        const result = await withTestFilesExcludedFromTypeCheck(config, { cwd: dir });

        expect(result).toEqual({
            testRunner:     'bun',
            checkers:       ['typescript'],
            ignorePatterns: ['**', '!src/**', '!tsconfig.stryker-checker.json'],
            tsconfigFile:   'tsconfig.stryker-checker.json',
        });
        expect(config.ignorePatterns).toEqual(['**', '!src/**']);
        expect(await readProjectFile('tsconfig.stryker-checker.json')).toBe(
            '// Generated by withTestFilesExcludedFromTypeCheck() from @hughescr/stryker-bun-runner for the\n'
            + '// TypeScript checker: tsconfig.json minus Bun\'s test files, their preloads and the files only\n'
            + '// they import. `files` lists the entry points; TypeScript adds everything they import.\n'
            + '// Rewritten on every Stryker run: do not edit or commit it.\n'
            + '{\n'
            + '  "extends": "./tsconfig.json",\n'
            + '  "include": [],\n'
            + '  "files": [\n'
            + '    "src/a.ts",\n'
            + '    "src/b.ts",\n'
            + '    "src/entry.ts",\n'
            + '    "tests/fixtures/standalone.ts",\n'
            + '    "other/outside.test.ts"\n'
            + '  ]\n'
            + '}\n'
        );
    });

    it('logs one info line naming the derived file and how many files it excluded and kept', async () => {
        dir = await makeProject(BASE_FILES);
        await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

        // a.test.ts, setup.ts, helper.ts and deep.ts go; the other five of the nine files stay.
        expect(infos()).toEqual([`${PREFIX}using tsconfig.stryker-checker.json, 4 test/helper files excluded, 5 files kept`]);
        expect(warnings()).toEqual([]);
    });

    it('produces a program with no test files that still compiles cleanly', async () => {
        dir = await makeProject(BASE_FILES);
        await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

        expect(compile('tsconfig.stryker-checker.json')).toEqual({
            files:       ['other/outside.test.ts', 'src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts'],
            diagnostics: [],
        });
    });

    it('leaves ignorePatterns unset when the config has none', async () => {
        dir = await makeProject(BASE_FILES);
        expect(await withTestFilesExcludedFromTypeCheck({ concurrency: 2, ...CHECKED }, { cwd: dir })).toEqual({ concurrency: 2, ...CHECKED, tsconfigFile: 'tsconfig.stryker-checker.json' });
    });

    it('defaults cwd to the process cwd', async () => {
        dir = await makeProject(BASE_FILES);
        const previous = process.cwd();
        process.chdir(dir);
        try {
            expect(await withTestFilesExcludedFromTypeCheck(CHECKED)).toEqual({ ...CHECKED, tsconfigFile: 'tsconfig.stryker-checker.json' });
        } finally {
            process.chdir(previous);
        }
    });

    it('still compiles when a source file imports a test file: TypeScript pulls the test file back in', async () => {
        dir = await makeProject({ ...BASE_FILES, 'src/b.ts': 'import { a } from \'./a.js\';\nimport { t } from \'../tests/t.test.js\';\nexport const b: number = a + t;\n', 'tests/t.test.ts': 'export const t = 4;\n' });
        await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

        expect(await derivedFiles('tsconfig.stryker-checker.json')).not.toContain('tests/t.test.ts');
        expect(compile('tsconfig.stryker-checker.json')).toEqual({
            files:       ['other/outside.test.ts', 'src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'tests/t.test.ts'],
            diagnostics: [],
        });
    });

    it('drops helpers that only import each other once tests are gone', async () => {
        dir = await makeProject({
            ...BASE_FILES,
            'tests/a.test.ts':       'import { ping } from \'./helpers/ping.js\';\nvoid ping;\n',
            'tests/helpers/ping.ts': 'import { pong } from \'./pong.js\';\nexport const ping = (): number => pong();\n',
            'tests/helpers/pong.ts': 'import { ping } from \'./ping.js\';\nexport const pong = (): number => ping();\n',
        });
        await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

        // No test imports helper.ts any more, so it is an entry point of its own (and deep.ts comes in through it).
        expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'tests/helpers/helper.ts', 'other/outside.test.ts']);
    });

    describe('mutate decides which files only tests import are still code under test', () => {
        it('drops such a file when mutate does not cover it', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/a.ts', 'src/b.ts'], ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('keeps it when a positive mutate pattern covers it, ignoring negations', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/a.ts', 'src/entry.ts', '!src/entry.ts'], ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('keeps it when mutate names it with a mutation range', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/entry.ts:1-2', 'src/a.ts:10:30-20:40'], ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('strips only a trailing mutation range', async () => {
            dir = await makeProject({ ...BASE_FILES, 'src/v:1-2/entry.ts': 'export const v = 5;\n', 'tests/v.test.ts': 'import { v } from \'../src/v:1-2/entry.js\';\nvoid v;\n' });
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/v:1-2/entry.ts:1-2'], ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/v:1-2/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });
    });

    describe('test files beyond Bun\'s own discovery', () => {
        const withCheck = { ...BASE_FILES, 'tests/check.ts': 'export const check = 6;\n' };

        it('keeps a file that is not named as a test', async () => {
            dir = await makeProject(withCheck);
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toContain('tests/check.ts');
        });

        it('drops the files listed in bun.testFiles', async () => {
            dir = await makeProject(withCheck);
            await withTestFilesExcludedFromTypeCheck({ bun: { testFiles: ['tests/check.ts'] }, ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('drops the files matched by Stryker\'s testFiles patterns', async () => {
            dir = await makeProject(withCheck);
            await withTestFilesExcludedFromTypeCheck({ testFiles: ['tests/*.ts'], ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('reads root and preload from the bunfig named by --config in bun.bunArgs', async () => {
            dir = await makeProject({ ...BASE_FILES, 'config/alt.toml': '[test]\nroot = "other"\npreload = "./tests/fixtures/standalone.ts"\n' });
            await withTestFilesExcludedFromTypeCheck({ bun: { bunArgs: ['--config', 'config/alt.toml'] }, ...CHECKED }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/a.test.ts', 'tests/setup.ts']);
        });
    });

    it('derives from a tsconfigFile in another directory, next to it', async () => {
        dir = await makeProject({
            ...BASE_FILES,
            'config/tsconfig.app.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['../src', '../tests'] }),
        });
        const config: PartialStrykerOptions = { tsconfigFile: 'config/tsconfig.app.json', ignorePatterns: [], ...CHECKED };

        expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toEqual({ ...CHECKED, tsconfigFile: 'config/tsconfig.app.stryker-checker.json', ignorePatterns: ['!config/tsconfig.app.stryker-checker.json'] });
        expect(await readProjectFile('config/tsconfig.app.stryker-checker.json')).toContain('"extends": "./tsconfig.app.json"');
        expect(await derivedFiles('config/tsconfig.app.stryker-checker.json')).toEqual(['../src/a.ts', '../src/b.ts', '../src/entry.ts', '../tests/fixtures/standalone.ts']);
        expect(compile('config/tsconfig.app.stryker-checker.json').diagnostics).toEqual([]);
        expect(infos()).toEqual([`${PREFIX}using config/tsconfig.app.stryker-checker.json, 4 test/helper files excluded, 4 files kept`]);
    });

    it('resets an inherited declarationDir, as the checker does for the tsconfig it is given', async () => {
        dir = await makeProject({
            ...BASE_FILES,
            'tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, noEmit: false, composite: true, declarationDir: 'types', outDir: 'out' }, include: ['src', 'tests'] }),
        });
        await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

        const text = await readProjectFile('tsconfig.stryker-checker.json');
        expect(text).toContain('{\n  "extends": "./tsconfig.json",\n  "compilerOptions": {\n    "declarationDir": null\n  },\n  "include": [],\n');
        // What the checker type-checks: the derived file with its overrides (composite and emit off) applied.
        const { config } = ts.parseConfigFileTextToJson('d.json', text) as { config: { compilerOptions: object } };
        await writeFile(path.join(dir, 'checker-view.json'), JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, noEmit: true, composite: false } }));
        expect(compile('checker-view.json').diagnostics).toEqual([]);
    });

    describe('keeps what the code under test relies on, even when only tests import it', () => {
        /** Run on `files` with a test preload importing `setup` and check the file at `kept` stays listed and the program is clean. */
        async function expectKept(files: Record<string, string>, kept: string): Promise<void> {
            dir = await makeProject(files);
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

            expect(await derivedFiles('tsconfig.stryker-checker.json')).toContain(kept);
            expect(compile('tsconfig.stryker-checker.json').diagnostics).toEqual([]);
            expect(warnings()).toEqual([]);
        }

        it('a global augmentation', async () => {
            await expectKept({
                ...WITH_TYPES,
                'src/b.ts':         USES_APP_NAME,
                'types/globals.ts': 'declare global {\n    var APP_NAME: string;\n}\nexport {};\n',
                'tests/setup.ts':   'import \'../types/globals.js\';\nglobalThis.APP_NAME = \'x\';\n',
            }, 'types/globals.ts');
            expect(infos()).toEqual([`${PREFIX}using tsconfig.stryker-checker.json, 4 test/helper files excluded, 6 files kept`]);
        });

        it('a module augmentation', async () => {
            await expectKept({
                ...WITH_TYPES,
                'src/b.ts':         'import { a, extra } from \'./a.js\';\nexport const b: number = a + extra;\n',
                'types/augment.ts': 'export {};\ndeclare module \'../src/a.js\' {\n    export const extra: number;\n}\n',
                'tests/setup.ts':   'import \'../types/augment.js\';\n',
            }, 'types/augment.ts');
        });

        it('a global script, which has no imports or exports', async () => {
            await expectKept({
                ...WITH_TYPES,
                'src/b.ts':        'import { a } from \'./a.js\';\nexport const b: number = a + Number(globalThis.LEGACY);\n',
                'types/legacy.ts': 'declare var LEGACY: string;\n',
                'tests/setup.ts':  'import \'../types/legacy.js\';\n',
            }, 'types/legacy.ts');
        });

        it('but not a module that merely declares a namespace', async () => {
            dir = await makeProject({
                ...BASE_FILES,
                'tests/helpers/ns.ts': 'export namespace N {\n    export const x = 1;\n}\n',
                'tests/a.test.ts':     'import { N } from \'./helpers/ns.js\';\nvoid N;\n',
            });
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).not.toContain('tests/helpers/ns.ts');
        });
    });

    describe('type-checks the derived program once and falls back when leaving tests out adds errors', () => {
        /** A global that only a test's triple-slash reference declares, from a package outside the project's files. */
        const OUTSIDE_GLOBAL: Record<string, string> = {
            'node_modules/custom-types/index.d.ts': 'declare var APP_NAME: string;\n',
            'tests/setup.ts':                       '/// <reference types="custom-types" />\nglobalThis.APP_NAME = \'x\';\n',
        };

        it('returns the config unchanged, naming the new errors, and writes nothing', async () => {
            dir = await makeProject({ ...BASE_FILES, ...OUTSIDE_GLOBAL, 'src/b.ts': USES_APP_NAME });
            const before = await readdir(dir);

            expect(await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir })).toEqual(CHECKED);
            expect(await readdir(dir)).toEqual(before);

            expect(infos()).toEqual([]);
            expect(warnings()).toEqual([
                `${PREFIX}not applied: leaving test files out would add type errors, so tsconfig.json stays in use. First: `
                + 'src/b.ts(2,48): error TS7017: Element implicitly has an \'any\' type because type \'typeof globalThis\' has no index signature.',
            ]);
        });

        it('quotes a multi-line error on one line and separates errors with semicolons', async () => {
            // Settings has an id only where custom-types is loaded, so need(settings) is a (two-line) error without it.
            dir = await makeProject({
                ...BASE_FILES,
                ...OUTSIDE_GLOBAL,
                'node_modules/custom-types/index.d.ts': 'interface Settings { id: number }\ndeclare var APP_NAME: string;\n',
                'src/b.ts':                             [
                    'import { a } from \'./a.js\';',
                    'declare global { interface Settings { name: string } }',
                    'declare const settings: Settings;',
                    'declare function need(x: { name: string, id: number }): void;',
                    'need(settings);',
                    'globalThis.APP_NAME;',
                    'export const b: number = a;',
                    '',
                ].join('\n'),
            });
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

            expect(warnings()).toEqual([
                `${PREFIX}not applied: leaving test files out would add type errors, so tsconfig.json stays in use. First: `
                + 'src/b.ts(5,6): error TS2345: Argument of type \'Settings\' is not assignable to parameter of type \'{ name: string; id: number; }\'.'
                + '   Property \'id\' is missing in type \'Settings\' but required in type \'{ name: string; id: number; }\'.; '
                + 'src/b.ts(6,12): error TS7017: Element implicitly has an \'any\' type because type \'typeof globalThis\' has no index signature.',
            ]);
        });

        it('lists at most the first three new errors', async () => {
            const uses = 'globalThis.APP_NAME;\n';
            dir = await makeProject({ ...BASE_FILES, ...OUTSIDE_GLOBAL, 'src/b.ts': USES_APP_NAME + uses.repeat(4) });
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

            expect(warnings()[0]?.match(/TS7017/g)).toHaveLength(3);
        });

        it('counts a new error even in a file that already had others', async () => {
            // OTHER is an old TS7017 in b.ts; the APP_NAME one is new, and the same code.
            dir = await makeProject({ ...BASE_FILES, ...OUTSIDE_GLOBAL, 'src/b.ts': `globalThis.OTHER;\n${USES_APP_NAME}` });
            const config = { ...CHECKED };

            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toBe(config);
            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toStartWith(`${PREFIX}not applied: leaving test files out would add type errors, so tsconfig.json stays in use. First: src/b.ts(3,`);
            expect(warnings()[0]).not.toContain('src/b.ts(1,');
        });

        it('checks the program as the checker does, with composite off, so a pulled-in file missing from `files` is no error', async () => {
            dir = await makeProject({
                ...BASE_FILES,
                'tsconfig.json':   JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, noEmit: false, composite: true, declarationDir: 'types', outDir: 'out' }, include: ['src', 'tests'] }),
                'src/b.ts':        'import { a } from \'./a.js\';\nimport { t } from \'../tests/t.test.js\';\nexport const b: number = a + t;\n',
                'tests/t.test.ts': 'export const t = 4;\n',
            });

            expect(await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir })).toEqual({ ...CHECKED, tsconfigFile: 'tsconfig.stryker-checker.json' });
            expect(warnings()).toEqual([]);
        });

        it('proceeds when the program already had the errors: only new ones count', async () => {
            dir = await makeProject({ ...BASE_FILES, 'src/bad.ts': 'export const bad: number = \'x\';\n' });
            const config = { ...CHECKED };

            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toEqual({ ...CHECKED, tsconfigFile: 'tsconfig.stryker-checker.json' });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toContain('src/bad.ts');
            expect(warnings()).toEqual([]);
        });

        it('ignores errors only in test files that stay in the program through an import', async () => {
            dir = await makeProject({
                ...BASE_FILES,
                ...OUTSIDE_GLOBAL,
                'src/b.ts':        'import { a } from \'./a.js\';\nimport { t } from \'../tests/t.test.js\';\nexport const b: number = a + t;\n',
                'tests/t.test.ts': 'export const t = Number(globalThis.APP_NAME);\n',
            });

            expect(await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir })).toEqual({ ...CHECKED, tsconfigFile: 'tsconfig.stryker-checker.json' });
            expect(warnings()).toEqual([]);
        });
    });

    describe('the derived file on disk', () => {
        it('is left untouched, with no new write, when its content is unchanged', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });
            const first = await readProjectFile('tsconfig.stryker-checker.json');
            mockWriteFile.mockClear();
            mockRename.mockClear();

            expect(await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir })).toEqual({ ...CHECKED, tsconfigFile: 'tsconfig.stryker-checker.json' });

            expect(mockWriteFile).not.toHaveBeenCalled();
            expect(mockRename).not.toHaveBeenCalled();
            expect(await readProjectFile('tsconfig.stryker-checker.json')).toBe(first);
            expect(infos()).toHaveLength(2);
        });

        it('is replaced through a temp file when its content is stale, leaving no temp file behind', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });
            await writeFile(path.join(dir, 'src/extra.ts'), 'export const extra = 7;\n');
            mockWriteFile.mockClear();
            mockRename.mockClear();

            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

            expect(await derivedFiles('tsconfig.stryker-checker.json')).toContain('src/extra.ts');
            expect(mockWriteFile).toHaveBeenCalledTimes(1);
            expect(mockRename).toHaveBeenCalledTimes(1);
            expect(mockRename.mock.calls[0]?.[1]).toBe(path.join(dir, 'tsconfig.stryker-checker.json'));
            expect(await tempFiles()).toEqual([]);
        });

        it('is not overwritten when it exists without the generated header', async () => {
            dir = await makeProject({ ...BASE_FILES, 'tsconfig.stryker-checker.json': '{ "mine": true }\n' });
            const config = { ...CHECKED };

            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toBe(config);

            expect(await readProjectFile('tsconfig.stryker-checker.json')).toBe('{ "mine": true }\n');
            expect(warnings()).toEqual([`${PREFIX}not applied: tsconfig.stryker-checker.json exists and was not generated by this helper (rename or delete it)`]);
            expect(infos()).toEqual([]);
        });

        it('falls back, warning, when it cannot be read or written (here: a directory in the way)', async () => {
            dir = await makeProject({ ...BASE_FILES, 'tsconfig.stryker-checker.json/keep': '' });
            const config = { ...CHECKED };

            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toBe(config);

            expect(warnings()).toHaveLength(1);
            // The read fails, and only a missing file is a reason to carry on to the write.
            expect(warnings()[0]).toStartWith(`${PREFIX}not applied: cannot update tsconfig.stryker-checker.json: EISDIR: illegal operation on a directory, read`);
            expect(infos()).toEqual([]);
        });

        it('falls back, warning, and removes its temp file when the final rename fails', async () => {
            dir = await makeProject(BASE_FILES);
            const config = { ...CHECKED };
            mockRename.mockRejectedValueOnce(new Error('EXDEV: cross-device link not permitted'));

            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toBe(config);

            expect(warnings()).toEqual([`${PREFIX}not applied: cannot update tsconfig.stryker-checker.json: EXDEV: cross-device link not permitted`]);
            expect(await readdir(dir)).not.toContain('tsconfig.stryker-checker.json');
            expect(await tempFiles()).toEqual([]);
        });

        it('reports a thrown value that is not an Error as text', async () => {
            dir = await makeProject(BASE_FILES);
            mockRename.mockImplementationOnce(() => Promise.reject('plain string'));  // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors -- deliberately not an Error

            await withTestFilesExcludedFromTypeCheck(CHECKED, { cwd: dir });

            expect(warnings()).toEqual([`${PREFIX}not applied: cannot update tsconfig.stryker-checker.json: plain string`]);
        });
    });

    describe('returns the config unchanged, writing nothing, and says why', () => {
        /** Run on a project made from `files` and expect the very same config object back, no derived file and `reason` (with `<cwd>` filled in) as the only log line. */
        async function expectUnchanged(files: Record<string, string>, reason: string, config: PartialStrykerOptions = CHECKED, linkTypescript = true, level: 'warn' | 'info' = 'warn'): Promise<void> {
            dir = await makeProject(files, linkTypescript);
            const before = await readdir(dir);
            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toBe(config);
            expect(await readdir(dir)).toEqual(before);
            expect(level === 'warn' ? warnings() : infos()).toEqual([`${PREFIX}not applied: ${reason.replaceAll('<cwd>', dir)}`]);
            expect(level === 'warn' ? infos() : warnings()).toEqual([]);
        }

        it('when the config has no typescript checker (an info, not a warning)', async () => {
            await expectUnchanged(BASE_FILES, 'the config\'s checkers do not include \'typescript\'', {}, true, 'info');
        });

        it('when its checkers are other than typescript', async () => {
            await expectUnchanged(BASE_FILES, 'the config\'s checkers do not include \'typescript\'', { checkers: ['other'] }, true, 'info');
        });

        it('when typescript cannot be loaded from the project', async () => {
            await expectUnchanged(
                { ...BASE_FILES, 'node_modules/typescript/package.json': '{ "name": "typescript", "main": "index.js" }', 'node_modules/typescript/index.js': 'throw new Error("broken");\n' },
                'typescript cannot be loaded from <cwd>; install it there',
                CHECKED,
                false
            );
        });

        it('when the tsconfig does not exist', async () => {
            await expectUnchanged(BASE_FILES, 'missing.json not found; set tsconfigFile', { tsconfigFile: 'missing.json', ...CHECKED });
        });

        it('when the tsconfig has errors', async () => {
            await expectUnchanged(
                { ...BASE_FILES, 'tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, target: 'nope' }, include: ['src', 'tests'] }) },
                'tsconfig.json has errors; fix them (tsc -p tsconfig.json lists them)'
            );
        });

        it('when the tsconfig uses project references', async () => {
            await expectUnchanged(
                {
                    ...BASE_FILES,
                    'tsconfig.json':     JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src', 'tests'], references: [{ path: './lib' }] }),
                    'lib/tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, composite: true, noEmit: false }, include: ['.'] }),
                    'lib/x.ts':          'export const x = 1;\n',
                },
                'tsconfig.json uses project references, which are not supported'
            );
        });

        it('when the tsconfig includes no test files', async () => {
            await expectUnchanged(
                { ...BASE_FILES, 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src', 'tests/helpers'] }) },
                'tsconfig.json includes no test files, so there is nothing to exclude'
            );
        });

        it('when the project has no test files at all', async () => {
            await expectUnchanged(
                { 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src'] }), 'src/a.ts': 'export const a = 1;\n' },
                'tsconfig.json includes no test files, so there is nothing to exclude'
            );
        });

        it('when nothing but tests and their helpers would be left', async () => {
            await expectUnchanged(
                { ...BASE_FILES, 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['tests/a.test.ts', 'tests/helpers'] }) },
                'tsconfig.json would have no files left once test files are excluded'
            );
        });
    });
});
