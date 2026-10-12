/**
 * The test-file arguments handed to `bun test`, and the byte budget they must stay in.
 *
 * Absolute paths are what makes bun run exactly the listed files in the listed
 * order (a bare relative argument is a substring filter), but they are longer
 * than the project-relative ids the runner used to pass, and a full-suite run
 * on a big project lists every test file. The kernel's limit on argv plus the
 * environment is in bytes (macOS: 1 MiB, and each argv entry also costs a
 * pointer), so the list has a budget; past it the entries shrink to the
 * `./`-relative form, which bun also takes as a path.
 */

import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { buildTestFileArgs, MAX_TEST_FILE_ARGS_BYTES } from '../../src/utils/test-file-args.js';

/** One argv entry costs its UTF-8 bytes, a NUL terminator and a 64-bit pointer. */
const ENTRY_OVERHEAD = 9;

const CWD = '/work/project';

/** `n` ASCII chars of file name under CWD: the absolute entry is `CWD + '/' + name`. */
const nameOfLength = (n: number): string => `${'a'.repeat(n - '.test.ts'.length)}.test.ts`;

describe('buildTestFileArgs', () => {
    describe('the form of the entries', () => {
        it('resolves relative entries against the cwd, keeping the given order', () => {
            const result = buildTestFileArgs(['tests/z.test.ts', 'tests/a.test.ts'], CWD);

            expect(result).toEqual({
                args:  ['/work/project/tests/z.test.ts', '/work/project/tests/a.test.ts'],
                form:  'absolute',
                bytes: '/work/project/tests/z.test.ts'.length + '/work/project/tests/a.test.ts'.length + (2 * ENTRY_OVERHEAD),
                fits:  true,
            });
        });

        it('keeps absolute entries and normalizes ./ and ../ spellings', () => {
            expect(buildTestFileArgs(['/elsewhere/x.test.ts', './tests/a.test.ts', '../b.test.ts', 'tests/dir/'], CWD).args).toEqual([
                '/elsewhere/x.test.ts',
                '/work/project/tests/a.test.ts',
                '/work/b.test.ts',
                '/work/project/tests/dir',
            ]);
        });

        it('defaults the cwd to the process\'s', () => {
            expect(buildTestFileArgs(['tests/a.test.ts']).args).toEqual([path.resolve('tests/a.test.ts')]);
        });

        it('has no entries for no files', () => {
            expect(buildTestFileArgs([], CWD)).toEqual({ args: [], form: 'absolute', bytes: 0, fits: true });
        });
    });

    describe('the budget', () => {
        const budgetFiller = (entries: number, entryBytes: number): string[] => Array.from({ length: entries }, (_, i) => `${String(i).padStart(3, '0')}${nameOfLength(entryBytes - '/work/project/'.length - 3)}`);

        it('is 128 KiB', () => {
            expect(MAX_TEST_FILE_ARGS_BYTES).toBe(131_072);
        });

        it('keeps the absolute form for a list of exactly the budget', () => {
            // One entry: its bytes + the 9 of overhead land exactly on the budget.
            const file = nameOfLength(MAX_TEST_FILE_ARGS_BYTES - ENTRY_OVERHEAD - '/work/project/'.length);
            const result = buildTestFileArgs([file], CWD);

            expect(result.bytes).toBe(MAX_TEST_FILE_ARGS_BYTES);
            expect(result).toMatchObject({ form: 'absolute', fits: true, args: [`${CWD}/${file}`] });
        });

        it('switches to the relative form one byte past the budget', () => {
            const file = nameOfLength(MAX_TEST_FILE_ARGS_BYTES - ENTRY_OVERHEAD - '/work/project/'.length + 1);
            const result = buildTestFileArgs([file], CWD);

            expect(result).toMatchObject({ form: 'relative', fits: true, args: [`./${file}`] });
            expect(result.bytes).toBe(`./${file}`.length + ENTRY_OVERHEAD);
        });

        it('counts the UTF-8 bytes of an entry, not its characters', () => {
            // 'é' is 2 bytes in UTF-8: the entry is one char short of the budget but one byte over it.
            const file = `é${nameOfLength(MAX_TEST_FILE_ARGS_BYTES - ENTRY_OVERHEAD - '/work/project/'.length - 1)}`;
            const result = buildTestFileArgs([file], CWD);

            expect(`${CWD}/${file}`.length + ENTRY_OVERHEAD).toBe(MAX_TEST_FILE_ARGS_BYTES);
            expect(result.form).toBe('relative');
        });

        it('adds up all the entries', () => {
            const files = budgetFiller(10, 100);
            const total = 10 * (100 + ENTRY_OVERHEAD);

            expect(buildTestFileArgs(files, CWD).bytes).toBe(total);
            expect(buildTestFileArgs(files, CWD, total)).toMatchObject({ form: 'absolute', fits: true });
            expect(buildTestFileArgs(files, CWD, total - 1)).toMatchObject({ form: 'relative', fits: true });
        });

        it('reports a list that does not fit even in the relative form', () => {
            const files = budgetFiller(10, 100);
            const relative = 10 * ((100 - '/work/project/'.length + 2) + ENTRY_OVERHEAD);

            expect(buildTestFileArgs(files, CWD, relative)).toMatchObject({ form: 'relative', fits: true, bytes: relative });
            expect(buildTestFileArgs(files, CWD, relative - 1)).toMatchObject({ form: 'relative', fits: false, bytes: relative });
        });
    });

    describe('the relative form', () => {
        const OVER = 1; // a budget no list fits in the absolute form

        it('writes entries below the cwd as ./ paths', () => {
            expect(buildTestFileArgs(['tests/unit/a.test.ts', '/work/project/tests/b.test.ts', 'tests/dir'], CWD, OVER).args).toEqual([
                './tests/unit/a.test.ts',
                './tests/b.test.ts',
                './tests/dir',
            ]);
        });

        it('writes entries outside the cwd as ../ paths, which bun also takes as paths', () => {
            expect(buildTestFileArgs(['/work/other/x.test.ts', '../y.test.ts'], CWD, OVER).args).toEqual([
                '../other/x.test.ts',
                '../y.test.ts',
            ]);
        });

        it('keeps the absolute spelling where it is the shorter one', () => {
            // Far from the cwd the ../../ spelling is the longer one, and the cwd itself has no relative spelling.
            expect(buildTestFileArgs(['/elsewhere/z.test.ts', '/x.test.ts', '/work/project'], CWD, OVER).args).toEqual([
                '/elsewhere/z.test.ts',
                '/x.test.ts',
                '/work/project',
            ]);
        });

        it('keeps the absolute spelling of the cwd\'s parent: a bare .. is not clearly a path to bun', () => {
            expect(buildTestFileArgs(['/work'], CWD, OVER).args).toEqual(['/work']);
        });

        it('treats a name that merely starts with two dots as an entry below the cwd', () => {
            expect(buildTestFileArgs(['..odd/x.test.ts'], CWD, OVER).args).toEqual(['./..odd/x.test.ts']);
        });

        it('keeps the absolute spelling of an entry below a root cwd, where ./ is longer', () => {
            expect(buildTestFileArgs(['x.test.ts'], '/', OVER).args).toEqual(['/x.test.ts']);
        });

        it('keeps the absolute spelling when both are equally long', () => {
            expect(buildTestFileArgs(['/a/c'], '/a/b', OVER).args).toEqual(['/a/c']);
        });

        it('keeps the order', () => {
            expect(buildTestFileArgs(['tests/z.test.ts', 'tests/a.test.ts'], CWD, OVER).args).toEqual(['./tests/z.test.ts', './tests/a.test.ts']);
        });
    });
});

describe('buildTestFileArgs remembering the previous call', () => {
    const FILES = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
    const ABSOLUTE = FILES.map(file => path.resolve(CWD, file));
    let resolveSpy: ReturnType<typeof spyOn<typeof path, 'resolve'>>;

    beforeEach(() => {
        // A call with other inputs first, so each test starts from a remembered call that cannot match its own.
        buildTestFileArgs(['tests/never-matches.test.ts'], '/unrelated', 1);
        resolveSpy = spyOn(path, 'resolve');
    });

    afterEach(() => {
        resolveSpy.mockRestore();
    });

    it('does the path work once for two calls in a row with the same list', () => {
        const first = buildTestFileArgs(FILES, CWD);
        resolveSpy.mockClear();

        const second = buildTestFileArgs(FILES, CWD);

        expect(resolveSpy).not.toHaveBeenCalled();
        expect(second).toEqual(first);
    });

    it('recognises the same list in a different array', () => {
        const first = buildTestFileArgs(FILES, CWD);
        resolveSpy.mockClear();

        expect(buildTestFileArgs([...FILES], CWD)).toEqual(first);
        expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('gives each caller its own args array', () => {
        const first = buildTestFileArgs(FILES, CWD);
        first.args.push('/mutated-by-caller');
        const second = buildTestFileArgs(FILES, CWD);
        second.args.pop();

        expect(buildTestFileArgs(FILES, CWD).args).toEqual(ABSOLUTE);
    });

    it('does not let a caller changing its input list change what is remembered', () => {
        const list = [...FILES];
        buildTestFileArgs(list, CWD);
        list[0] = 'tests/changed.test.ts';

        expect(buildTestFileArgs(list, CWD).args[0]).toBe('/work/project/tests/changed.test.ts');
        expect(buildTestFileArgs(FILES, CWD).args).toEqual(ABSOLUTE);
    });

    it.each([
        ['a different cwd', FILES, '/other/project', MAX_TEST_FILE_ARGS_BYTES, FILES.map(file => path.resolve('/other/project', file))],
        ['a different budget', FILES, CWD, 1, FILES.map(file => `./${file}`)],
        ['a longer list', [...FILES, 'tests/d.test.ts'], CWD, MAX_TEST_FILE_ARGS_BYTES, [...ABSOLUTE, '/work/project/tests/d.test.ts']],
        ['a shorter list', FILES.slice(0, 2), CWD, MAX_TEST_FILE_ARGS_BYTES, ABSOLUTE.slice(0, 2)],
        ['a list differing in its last entry', [...FILES.slice(0, 2), 'tests/z.test.ts'], CWD, MAX_TEST_FILE_ARGS_BYTES, [...ABSOLUTE.slice(0, 2), '/work/project/tests/z.test.ts']],
        ['a list differing in its first entry', ['tests/z.test.ts', ...FILES.slice(1)], CWD, MAX_TEST_FILE_ARGS_BYTES, ['/work/project/tests/z.test.ts', ...ABSOLUTE.slice(1)]],
    ])('does the work again for %s', (_label, files, cwd, budget, expectedArgs) => {
        buildTestFileArgs(FILES, CWD);

        expect(buildTestFileArgs(files, cwd, budget).args).toEqual(expectedArgs);
    });
});
