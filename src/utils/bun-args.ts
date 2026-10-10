/**
 * Validation of user-supplied `bun.bunArgs`.
 *
 * The runner owns several parts of the `bun test` command line: sequential
 * execution (`--max-concurrency=1` plus the coverage preload), the per-mutant
 * `--test-name-pattern`, the sanitized `--config`, the inspector endpoint, bail
 * and the file list. User args are appended AFTER the runner's own, so a flag
 * that fights one of those either overrides it (last flag wins in bun) or
 * changes what runs, and the run then silently attributes coverage to the wrong
 * tests or scores mutants wrongly. Failing loudly beats corrupt scores, so
 * those flags are rejected at init rather than passed through.
 *
 * Bail flags are NOT listed here: they are stripped silently by
 * `stripBailArgs` in process-runner.ts (the documented behaviour).
 *
 * Every entry was checked against bun 1.4.2 (`bun test --help`) and, where the
 * reason below states an effect, measured with a real Stryker run on a fixture
 * project. Flags measured to leave scores and attribution unchanged
 * (`--only`, `--isolate`, `--randomize`/`--seed`, `--rerun-each`, `--retry`,
 * `--only-failures`, `--dots`, `--reporter*`, `--hot`) are deliberately
 * accepted.
 */

/** A group of spellings of one rejected flag, with the reason it is rejected. */
export interface RejectedFlag {
    /** Long (`--x`) and short (`-x`) spellings. */
    flags:  readonly string[]
    /** Completes the sentence: `bun.bunArgs contains "<flag>", which <reason>. Remove it.` */
    reason: string
}

const BREAKS_ATTRIBUTION = 'breaks per-test coverage attribution';

export const REJECTED_BUN_FLAGS: readonly RejectedFlag[] = [
    { flags: ['--concurrent'], reason: BREAKS_ATTRIBUTION },
    { flags: ['--max-concurrency'], reason: `overrides the runner's forced --max-concurrency=1, which ${BREAKS_ATTRIBUTION}` },
    { flags: ['--parallel', '--test-worker'], reason: `runs test files in separate worker processes, which ${BREAKS_ATTRIBUTION}` },
    { flags: ['--shard'], reason: 'runs only a subset of the test files, so coverage and test selection are incomplete' },
    { flags: ['--changed'], reason: 'runs only a subset of the test files, so coverage and test selection are incomplete' },
    { flags: ['--test-name-pattern', '-t'], reason: 'overrides the --test-name-pattern the runner builds for each mutant and breaks test selection' },
    { flags: ['--update-snapshots', '-u'], reason: 'rewrites snapshots to match the mutated output, so snapshot tests can never fail and mutants falsely survive' },
    { flags: ['--pass-with-no-tests'], reason: 'turns a test selection that matched nothing into exit code 0, so such mutants are falsely scored as survived' },
    { flags: ['--watch'], reason: 'never exits, so every run would time out' },
    { flags: ['--coverage', '--coverage-reporter', '--coverage-dir'], reason: "re-enables bun's own coverage, which the runner turns off; it slows every run and skews timeouts" },
    { flags: ['--config', '-c'], reason: 'replaces the sanitized bunfig the runner generates (coverage and onlyFailures off, paths made absolute)' },
    { flags: ['--cwd'], reason: 'moves bun out of the Stryker sandbox, so tests run against the unmutated project and every mutant goes uncovered' },
    { flags: ['--inspect', '--inspect-wait', '--inspect-brk'], reason: 'conflicts with the inspector endpoint the runner uses to track tests' },
];

/** A user arg that was rejected, with why. */
export interface UnsupportedBunArg {
    /** The offending token exactly as the user wrote it. */
    arg:    string
    reason: string
}

/**
 * True when `arg` is `flag` in any spelling bun accepts for it:
 * bare (`--x`, with its value in the NEXT token), `--x=value`, or — for short
 * flags — the attached form (`-xvalue`).
 */
function matchesFlag(arg: string, flag: string): boolean {
    if(arg === flag) {
        return true;
    }
    if(flag.startsWith('--')) {
        return arg.startsWith(`${flag}=`);
    }
    // Short flag: bun also accepts the value attached (`-tfoo`, `-t=foo`). A
    // `--long` token can never start with a single-dash short flag, so no guard is needed.
    return arg.startsWith(flag);
}

/**
 * Find every token in `bunArgs` that spells a rejected flag. A flag's separate
 * value token (`--max-concurrency 5`, `-t pattern`) is not inspected: only the
 * flag itself is reported.
 *
 * @returns Offending tokens in the order given, each reported once
 */
export function findUnsupportedBunArgs(bunArgs: readonly string[]): UnsupportedBunArg[] {
    const found: UnsupportedBunArg[] = [];
    const seen = new Set<string>();
    for(const arg of bunArgs) {
        if(seen.has(arg)) {
            continue;
        }
        const rejected = REJECTED_BUN_FLAGS.find(r => r.flags.some(flag => matchesFlag(arg, flag)));
        if(rejected) {
            seen.add(arg);
            found.push({ arg, reason: rejected.reason });
        }
    }
    return found;
}

/**
 * Throw when `bunArgs` contains a flag the runner cannot support.
 *
 * @throws Error naming each offending flag and why it is rejected
 */
export function assertSupportedBunArgs(bunArgs: readonly string[] | undefined): void {
    if(!bunArgs) {
        return;
    }
    const found = findUnsupportedBunArgs(bunArgs);
    if(found.length === 0) {
        return;
    }
    if(found.length === 1) {
        throw new Error(`stryker-bun-runner: bun.bunArgs contains "${found[0].arg}", which ${found[0].reason}. Remove it.`);
    }
    const list = found.map(f => `"${f.arg}" (${f.reason})`).join('; ');
    throw new Error(`stryker-bun-runner: bun.bunArgs contains unsupported flags: ${list}. Remove them.`);
}
