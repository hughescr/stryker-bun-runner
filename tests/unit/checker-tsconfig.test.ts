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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type * as TypeScript from 'typescript';
import { withTestFilesExcludedFromTypeCheck } from '../../src/checker-tsconfig.js';
import { withTestFilesExcludedFromTypeCheck as fromIndex } from '../../src/index.js';
import { resetFsMocks } from '../test-preload.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const ts = createRequire(path.join(REPO_ROOT, 'package.json'))('typescript') as typeof TypeScript;

const COMPILER_OPTIONS = {
    strict:           true,
    target:           'ES2022',
    module:           'ESNext',
    moduleResolution: 'bundler',
    types:            [],
    noEmit:           true,
    skipLibCheck:     true,
};

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

let dir: string;

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

beforeEach(() => {
    resetFsMocks();
    dir = '';
});

afterEach(async () => {
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

    it('produces a program with no test files that still compiles cleanly', async () => {
        dir = await makeProject(BASE_FILES);
        await withTestFilesExcludedFromTypeCheck({}, { cwd: dir });

        expect(compile('tsconfig.stryker-checker.json')).toEqual({
            files:       ['other/outside.test.ts', 'src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts'],
            diagnostics: [],
        });
    });

    it('leaves ignorePatterns unset when the config has none', async () => {
        dir = await makeProject(BASE_FILES);
        expect(await withTestFilesExcludedFromTypeCheck({ concurrency: 2 }, { cwd: dir })).toEqual({ concurrency: 2, tsconfigFile: 'tsconfig.stryker-checker.json' });
    });

    it('defaults cwd to the process cwd', async () => {
        dir = await makeProject(BASE_FILES);
        const previous = process.cwd();
        process.chdir(dir);
        try {
            expect(await withTestFilesExcludedFromTypeCheck({})).toEqual({ tsconfigFile: 'tsconfig.stryker-checker.json' });
        } finally {
            process.chdir(previous);
        }
    });

    it('still compiles when a source file imports a test file: TypeScript pulls the test file back in', async () => {
        dir = await makeProject({ ...BASE_FILES, 'src/b.ts': 'import { a } from \'./a.js\';\nimport { t } from \'../tests/t.test.js\';\nexport const b: number = a + t;\n', 'tests/t.test.ts': 'export const t = 4;\n' });
        await withTestFilesExcludedFromTypeCheck({}, { cwd: dir });

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
        await withTestFilesExcludedFromTypeCheck({}, { cwd: dir });

        // No test imports helper.ts any more, so it is an entry point of its own (and deep.ts comes in through it).
        expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'tests/helpers/helper.ts', 'other/outside.test.ts']);
    });

    describe('mutate decides which files only tests import are still code under test', () => {
        it('drops such a file when mutate does not cover it', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/a.ts', 'src/b.ts'] }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('keeps it when a positive mutate pattern covers it, ignoring negations', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/a.ts', 'src/entry.ts', '!src/entry.ts'] }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('keeps it when mutate names it with a mutation range', async () => {
            dir = await makeProject(BASE_FILES);
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/entry.ts:1-2', 'src/a.ts:10:30-20:40'] }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('strips only a trailing mutation range', async () => {
            dir = await makeProject({ ...BASE_FILES, 'src/v:1-2/entry.ts': 'export const v = 5;\n', 'tests/v.test.ts': 'import { v } from \'../src/v:1-2/entry.js\';\nvoid v;\n' });
            await withTestFilesExcludedFromTypeCheck({ mutate: ['src/v:1-2/entry.ts:1-2'] }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/v:1-2/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });
    });

    describe('test files beyond Bun\'s own discovery', () => {
        const withCheck = { ...BASE_FILES, 'tests/check.ts': 'export const check = 6;\n' };

        it('keeps a file that is not named as a test', async () => {
            dir = await makeProject(withCheck);
            await withTestFilesExcludedFromTypeCheck({}, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toContain('tests/check.ts');
        });

        it('drops the files listed in bun.testFiles', async () => {
            dir = await makeProject(withCheck);
            await withTestFilesExcludedFromTypeCheck({ bun: { testFiles: ['tests/check.ts'] } }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('drops the files matched by Stryker\'s testFiles patterns', async () => {
            dir = await makeProject(withCheck);
            await withTestFilesExcludedFromTypeCheck({ testFiles: ['tests/*.ts'] }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/fixtures/standalone.ts', 'other/outside.test.ts']);
        });

        it('reads root and preload from the bunfig named by --config in bun.bunArgs', async () => {
            dir = await makeProject({ ...BASE_FILES, 'config/alt.toml': '[test]\nroot = "other"\npreload = "./tests/fixtures/standalone.ts"\n' });
            await withTestFilesExcludedFromTypeCheck({ bun: { bunArgs: ['--config', 'config/alt.toml'] } }, { cwd: dir });
            expect(await derivedFiles('tsconfig.stryker-checker.json')).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'tests/a.test.ts', 'tests/setup.ts']);
        });
    });

    it('derives from a tsconfigFile in another directory, next to it', async () => {
        dir = await makeProject({
            ...BASE_FILES,
            'config/tsconfig.app.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['../src', '../tests'] }),
        });
        const config: PartialStrykerOptions = { tsconfigFile: 'config/tsconfig.app.json', ignorePatterns: [] };

        expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toEqual({ tsconfigFile: 'config/tsconfig.app.stryker-checker.json', ignorePatterns: ['!config/tsconfig.app.stryker-checker.json'] });
        expect(await readProjectFile('config/tsconfig.app.stryker-checker.json')).toContain('"extends": "./tsconfig.app.json"');
        expect(await derivedFiles('config/tsconfig.app.stryker-checker.json')).toEqual(['../src/a.ts', '../src/b.ts', '../src/entry.ts', '../tests/fixtures/standalone.ts']);
        expect(compile('config/tsconfig.app.stryker-checker.json').diagnostics).toEqual([]);
    });

    it('resets an inherited declarationDir, as the checker does for the tsconfig it is given', async () => {
        dir = await makeProject({
            ...BASE_FILES,
            'tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, noEmit: false, composite: true, declarationDir: 'types', outDir: 'out' }, include: ['src', 'tests'] }),
        });
        await withTestFilesExcludedFromTypeCheck({}, { cwd: dir });

        const text = await readProjectFile('tsconfig.stryker-checker.json');
        expect(text).toContain('{\n  "extends": "./tsconfig.json",\n  "compilerOptions": {\n    "declarationDir": null\n  },\n  "include": [],\n');
        // What the checker type-checks: the derived file with its overrides (composite and emit off) applied.
        const { config } = ts.parseConfigFileTextToJson('d.json', text) as { config: { compilerOptions: object } };
        await writeFile(path.join(dir, 'checker-view.json'), JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, noEmit: true, composite: false } }));
        expect(compile('checker-view.json').diagnostics).toEqual([]);
    });

    describe('returns the config unchanged, writing nothing', () => {
        /** Run on a project made from `files` and expect the very same config object back and no derived file. */
        async function expectUnchanged(files: Record<string, string>, config: PartialStrykerOptions = {}, linkTypescript = true): Promise<void> {
            dir = await makeProject(files, linkTypescript);
            const before = await readdir(dir);
            expect(await withTestFilesExcludedFromTypeCheck(config, { cwd: dir })).toBe(config);
            expect(await readdir(dir)).toEqual(before);
        }

        it('when typescript cannot be loaded from the project', async () => {
            await expectUnchanged({ ...BASE_FILES, 'node_modules/typescript/package.json': '{ "name": "typescript", "main": "index.js" }', 'node_modules/typescript/index.js': 'throw new Error("broken");\n' }, {}, false);
        });

        it('when the tsconfig does not exist', async () => {
            await expectUnchanged(BASE_FILES, { tsconfigFile: 'missing.json' });
        });

        it('when the tsconfig has errors', async () => {
            await expectUnchanged({ ...BASE_FILES, 'tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, target: 'nope' }, include: ['src', 'tests'] }) });
        });

        it('when the tsconfig uses project references', async () => {
            await expectUnchanged({
                ...BASE_FILES,
                'tsconfig.json':     JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src', 'tests'], references: [{ path: './lib' }] }),
                'lib/tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, composite: true, noEmit: false }, include: ['.'] }),
                'lib/x.ts':          'export const x = 1;\n',
            });
        });

        it('when the tsconfig includes no test files', async () => {
            await expectUnchanged({ ...BASE_FILES, 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src', 'tests/helpers'] }) });
        });

        it('when the project has no test files at all', async () => {
            await expectUnchanged({ 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src'] }), 'src/a.ts': 'export const a = 1;\n' });
        });

        it('when nothing but tests and their helpers would be left', async () => {
            await expectUnchanged({ ...BASE_FILES, 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['tests/a.test.ts', 'tests/helpers'] }) });
        });
    });
});
