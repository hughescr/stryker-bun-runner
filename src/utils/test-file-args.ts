/**
 * The test-file arguments handed to `bun test`, within a byte budget.
 *
 * `bun test` takes a positional argument that starts with `/`, `./` or `../` as
 * a path (that file or directory, run in the order given) and any other as a
 * substring filter (measured on bun 1.4.2), so every entry is spelled as a path.
 * Absolute paths are the safest spelling, but they are the longest, and a
 * full-suite run on a big project lists every test file: the kernel limits argv
 * plus the environment in bytes (macOS: 1 MiB; each entry also costs a pointer),
 * and spawning past it fails with E2BIG. So the list has a budget, and past it
 * the entries shrink to their `./`-relative spelling, which is a path to bun too.
 */

import path from 'node:path';

/**
 * The most bytes of argv the test-file entries may take.
 *
 * Chosen so the whole command line stays far from the limits: with the
 * `--test-name-pattern` at its own cap (100,000 bytes, see
 * MAX_TEST_NAME_PATTERN_LENGTH) and a typical environment of a few KiB (a
 * heavy CI one is below ~64 KiB) the total stays under about 300 KiB, under a
 * third of macOS's 1 MiB and a seventh of the usual Linux 2 MiB.
 */
export const MAX_TEST_FILE_ARGS_BYTES = 131_072;

/** A NUL terminator plus a 64-bit pointer: what one argv entry costs beyond its UTF-8 bytes. */
const ENTRY_OVERHEAD_BYTES = 1 + 8;

export interface TestFileArgs {
    /** The entries to append to the `bun test` command line, in the order given. */
    args:  string[]
    /** `absolute` when the absolute spellings fit the budget, else `relative`. */
    form:  'absolute' | 'relative'
    /** Bytes the entries take in `form`. */
    bytes: number
    /** Whether `bytes` is within the budget. A list that does not fit even `relative` still gets its `relative` entries. */
    fits:  boolean
}

const bytesOf = (args: readonly string[]): number => args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + ENTRY_OVERHEAD_BYTES, 0);

/** `absolute` as a path relative to `cwd` that bun reads as a path, or `absolute` itself when that is not shorter. */
function shortestSpelling(absolute: string, cwd: string): string {
    const relative = path.relative(cwd, absolute);
    // The cwd itself ('') and its parent ('..') have no spelling bun clearly reads as a path.
    if(relative === '' || relative === '..') {
        return absolute;
    }
    const spelled = relative.startsWith(`..${path.sep}`) ? relative : `.${path.sep}${relative}`;
    return spelled.length < absolute.length ? spelled : absolute;
}

/**
 * Spell `files` as `bun test` path arguments, resolved against `cwd`.
 *
 * @param files - Test files or directories, absolute or relative to `cwd`
 * @param cwd - The directory the child runs in
 * @param budget - Bytes the entries may take
 */
export function buildTestFileArgs(files: readonly string[], cwd: string = process.cwd(), budget: number = MAX_TEST_FILE_ARGS_BYTES): TestFileArgs {
    const absolute = files.map(file => path.resolve(cwd, file));
    const absoluteBytes = bytesOf(absolute);
    if(absoluteBytes <= budget) {
        return { args: absolute, form: 'absolute', bytes: absoluteBytes, fits: true };
    }
    const relative = absolute.map(file => shortestSpelling(file, cwd));
    const relativeBytes = bytesOf(relative);
    return { args: relative, form: 'relative', bytes: relativeBytes, fits: relativeBytes <= budget };
}
