/**
 * A tsconfig for @stryker-mutator/typescript-checker that leaves the project's
 * Bun tests out of type checking.
 *
 * The checker type-checks every mutant against the program of its
 * `tsconfigFile` and re-checks every file that depends on the mutated one. When
 * that tsconfig includes the tests, every mutant in a widely imported module
 * re-checks the test suite too. {@link withTestFilesExcludedFromTypeCheck}
 * derives, at config time, a tsconfig that extends the project's own and lists
 * only the code under test, and points the checker at it.
 *
 * No plugin can do this unasked: Stryker freezes its options before it creates
 * any plugin, and starts the checker processes before any test runner exists.
 */

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PartialStrykerOptions } from '@stryker-mutator/api/core';
import { glob } from 'tinyglobby';
import type * as TypeScript from 'typescript';
import { splitBunConfigArg } from './utils/bun-args.js';
import { readBunfigTestPreloads } from './utils/bunfig-sanitizer.js';
import { discoverTestFiles } from './utils/test-file-discovery.js';

type TS = typeof TypeScript;

/**
 * Stand-in for Stryker's default `mutate` patterns, which all match under these
 * directories. Matching them whole over-approximates, which is safe: a file
 * that `mutate` covers is only ever kept in the check.
 */
const DEFAULT_MUTATE_PATTERNS = ['{src,lib}/**'];

/** A trailing mutation range, `file:line[:column]-line[:column]`, on a `mutate` pattern. */
const MUTATION_RANGE_RE = /:\d+(?::\d+)?-\d+(?::\d+)?$/;

/** Suffix of the derived file, which sits next to the tsconfig it derives from. */
const DERIVED_SUFFIX = '.stryker-checker.json';

/** Options for {@link withTestFilesExcludedFromTypeCheck}. */
export interface TestFilesExcludedFromTypeCheckOptions {
    /** The project directory Stryker runs in (default: `process.cwd()`). */
    cwd?: string
}

/**
 * The parts of a Stryker config read here. PartialStrykerOptions is a deep
 * partial, which lets array items be undefined; Stryker's schema does not.
 */
interface ConfigView {
    mutate?:    string[]
    testFiles?: string[]
    bun?:       { bunArgs?: string[], testFiles?: string[] }
}

/** The project's own typescript, or undefined when it cannot be loaded (then the checker cannot run either). */
function loadTypeScript(cwd: string): TS | undefined {
    try {
        return createRequire(path.join(cwd, 'package.json'))('typescript') as TS;
    } catch{
        return undefined;
    }
}

/**
 * The project `tsconfigPath` describes, with `extends`, `files`, `include` and
 * `exclude` applied by TypeScript itself. Undefined when there is nothing this
 * module can safely derive from: a missing or broken tsconfig (left for the
 * checker to report as it always has), or one with project references, which
 * puts the checker in build mode with one program per referenced project.
 */
function readProject(ts: TS, tsconfigPath: string): TypeScript.ParsedCommandLine | undefined {
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    if(parsed === undefined || parsed.errors.length > 0 || parsed.projectReferences !== undefined) {
        return undefined;
    }
    return parsed;
}

/**
 * Absolute paths of the files the runner treats as tests: what its discovery
 * finds (Bun's naming rules under `[test].root`), `bun.testFiles`, the
 * `[test].preload` scripts and the files Stryker's `testFiles` patterns match.
 */
async function findTestFiles(config: ConfigView, cwd: string): Promise<Set<string>> {
    const bun = config.bun ?? {};
    const sourceBunfig = bun.bunArgs && splitBunConfigArg(bun.bunArgs).configPath;
    const testFiles = new Set(await readBunfigTestPreloads(cwd, sourceBunfig));
    for(const relativeFiles of [await discoverTestFiles(cwd, undefined, sourceBunfig), bun.testFiles]) {
        if(relativeFiles) {
            for(const file of relativeFiles) {
                testFiles.add(path.resolve(cwd, file));
            }
        }
    }
    if(config.testFiles) {
        for(const file of await glob(config.testFiles, { cwd, absolute: true })) {
            testFiles.add(file);
        }
    }
    return testFiles;
}

/**
 * Absolute paths of the files a positive `mutate` pattern matches. Negations
 * are ignored and ranges stripped: over-matching only keeps a file in the check.
 */
async function findMutateFiles(config: ConfigView, cwd: string): Promise<Set<string>> {
    const patterns = (config.mutate ?? DEFAULT_MUTATE_PATTERNS)
        .filter(pattern => !pattern.startsWith('!'))
        .map(pattern => pattern.replace(MUTATION_RANGE_RE, ''));
    return new Set(await glob(patterns, { cwd, absolute: true }));
}

/** The project's files that another of its files imports, resolved the way TypeScript resolves them. */
function findImportedFiles(ts: TS, project: TypeScript.ParsedCommandLine): Set<string> {
    const imported = new Set<string>();
    for(const file of project.fileNames) {
        for(const { fileName } of ts.preProcessFile(ts.sys.readFile(file)!).importedFiles) {
            const resolved = ts.resolveModuleName(fileName, file, project.options, ts.sys).resolvedModule;
            if(resolved) {
                imported.add(resolved.resolvedFileName);
            }
        }
    }
    return imported;
}

/** Header of the derived tsconfig, which TypeScript reads as JSON with comments. */
function derivedHeader(source: string): string {
    return [
        '// Generated by withTestFilesExcludedFromTypeCheck() from @hughescr/stryker-bun-runner for the',
        `// TypeScript checker: ${source} minus Bun's test files, their preloads and the files only`,
        '// they import. `files` lists the entry points; TypeScript adds everything they import.',
        '// Rewritten on every Stryker run: do not edit or commit it.',
        '',
    ].join('\n');
}

/** The derived tsconfig's text. */
function renderDerivedTsconfig(sourcePath: string, derivedPath: string, project: TypeScript.ParsedCommandLine, entryPoints: readonly string[]): string {
    const source = path.basename(sourcePath);
    const body = {
        'extends': `./${source}`,
        // In single-project mode the checker turns composite off and deletes declarationDir
        // from the tsconfig it is given. Inherited from the original instead, declarationDir
        // would fail every check (TS5069) wherever composite was what implied declaration.
        ...(project.options.declarationDir !== undefined && { compilerOptions: { declarationDir: null } }),
        include:   [],
        files:     entryPoints.map(file => path.relative(path.dirname(derivedPath), file)),
    };
    return `${derivedHeader(source)}${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Point @stryker-mutator/typescript-checker at a copy of the project's tsconfig
 * without the tests, so mutants are type-checked against the code under test only.
 *
 * Reads the config's `tsconfigFile` (default `tsconfig.json`) with the
 * project's own TypeScript and writes `<name>.stryker-checker.json` next to it.
 * That file extends the original and lists as `files` every file of the project
 * except:
 * - test files, by this runner's rules: Bun's naming rules under bunfig's
 *   `[test].root`, `bun.testFiles` and Stryker's `testFiles` patterns;
 * - bunfig `[test].preload` scripts;
 * - files that only those (and each other) import, such as test helpers,
 *   unless a `mutate` pattern covers them.
 *
 * A file the remaining code imports still comes in through that import, so the
 * program always compiles as before. Returns a copy of `config` with
 * `tsconfigFile` set to the derived file and, when `ignorePatterns` is set, a
 * negation for it appended, so Stryker's sandbox gets it too (Stryker rewrites
 * the `tsconfigFile` chain's paths there).
 *
 * Returns `config` itself, writing nothing, when typescript cannot be loaded
 * from `cwd`, the tsconfig is missing, has errors or uses project references,
 * includes no test files, or would be left with no files at all.
 *
 * @example
 * // stryker.conf.mjs
 * import { withTestFilesExcludedFromTypeCheck } from '@hughescr/stryker-bun-runner';
 * export default await withTestFilesExcludedFromTypeCheck({ testRunner: 'bun', checkers: ['typescript'] });
 */
export async function withTestFilesExcludedFromTypeCheck<T extends PartialStrykerOptions>(config: T, { cwd = process.cwd() }: TestFilesExcludedFromTypeCheckOptions = {}): Promise<T & PartialStrykerOptions> {
    const ts = loadTypeScript(cwd);
    if(!ts) {
        return config;
    }
    const sourcePath = path.resolve(cwd, config.tsconfigFile ?? 'tsconfig.json');
    const project = readProject(ts, sourcePath);
    if(!project) {
        return config;
    }
    const testFiles = await findTestFiles(config as ConfigView, cwd);
    if(!project.fileNames.some(file => testFiles.has(file))) {
        return config;
    }
    const mutateFiles = await findMutateFiles(config as ConfigView, cwd);
    const importedFiles = findImportedFiles(ts, project);
    const entryPoints = project.fileNames.filter(file => !testFiles.has(file) && (mutateFiles.has(file) || !importedFiles.has(file)));
    if(entryPoints.length === 0) {
        return config;
    }
    const derivedPath = path.join(path.dirname(sourcePath), `${path.basename(sourcePath, '.json')}${DERIVED_SUFFIX}`);
    await writeFile(derivedPath, renderDerivedTsconfig(sourcePath, derivedPath, project, entryPoints));
    const tsconfigFile = path.relative(cwd, derivedPath);
    return {
        ...config,
        tsconfigFile,
        ...(config.ignorePatterns && { ignorePatterns: [...config.ignorePatterns, `!${tsconfigFile}`] }),
    };
}
