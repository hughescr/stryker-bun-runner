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
 * `--config`/`-c` is not rejected either, provided it names a file: it selects
 * the source bunfig for the runner's sanitizer and is removed from the args
 * bun sees (`splitBunConfigArg`). Only a flag with no usable path is rejected.
 *
 * Every entry was checked against bun 1.4.2 (`bun test --help`) and, where the
 * reason below states an effect, measured with a real Stryker run on a fixture
 * project. Flags measured to leave scores and attribution unchanged
 * (`--only`, `--isolate`, `--randomize`/`--seed`, `--only-failures`, `--dots`,
 * `--reporter*`, `--hot`) are deliberately accepted (`--randomize`/`--seed`
 * apply to the dry run only: see {@link stripRandomizeArgs}). `--retry` and
 * `--rerun-each` do not corrupt attribution but are rejected anyway: they
 * re-run tests, which only costs time or repeats test names (see
 * {@link RETRY_REASON}, {@link RERUN_EACH_REASON}).
 */

/** A group of spellings of one rejected flag, with the reason it is rejected. */
export interface RejectedFlag {
    /** Long (`--x`) and short (`-x`) spellings. */
    flags:  readonly string[]
    /** Completes the sentence: `bun.bunArgs contains "<flag>", which <reason>. Remove it.` */
    reason: string
}

const BREAKS_ATTRIBUTION = 'breaks per-test coverage attribution';

/**
 * Why `retry` (`--retry`, `[test].retry`) is unusable. Starts with a verb so it
 * completes both `bun.bunArgs contains "<flag>", which <reason>` and
 * `<setting> was ignored: it <reason>`.
 */
export const RETRY_REASON = 're-runs failing tests, which repeats test names (so a killedBy test cannot be resolved to one test, and incremental mode re-runs them) and cannot improve mutation scores';

/** Why `rerunEach` (`--rerun-each`, `[test].rerunEach`) is unusable; same sentence shape as {@link RETRY_REASON}. */
export const RERUN_EACH_REASON = 'runs every test N times, which multiplies the cost of every mutant run and repeats test names, and cannot improve mutation scores';

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
    // Only spellings splitBunConfigArg could not use are left to reach this table.
    { flags: ['--config', '-c'], reason: 'has no usable path: write --config=<path>, --config <path> or -c <path> (the runner sanitizes that file and passes its own --config to bun)' },
    { flags: ['--retry'], reason: RETRY_REASON },
    { flags: ['--rerun-each'], reason: RERUN_EACH_REASON },
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

/** `bunArgs` with the bunfig flag removed, plus the path it named. */
export interface SplitBunConfigArg {
    /** Every arg except the consumed config flag(s), in their original order. */
    args:        string[]
    /** The user's source bunfig, exactly as written (relative paths are NOT resolved here); the last flag wins, as in bun. */
    configPath?: string
}

/** True for a token that can be the separate path value of `--config`/`-c`: present, non-empty and not itself a flag. */
function isConfigPathToken(token: string | undefined): boolean {
    return token !== undefined && token !== '' && !token.startsWith('-');
}

/**
 * Take the bunfig flag out of `bunArgs`.
 *
 * The runner passes its own sanitized `--config=<tmp>` to bun, so a user's
 * `--config` must not reach bun (the later flag would win and drop the
 * sanitizing). Instead its path becomes the SOURCE the runner sanitizes (and
 * reads `[test].root` from). Consumed spellings: `--config=<path>`,
 * `--config <path>` and `-c <path>`, where the path is non-empty and, for the
 * space-separated forms, does not start with `-`. Anything else that spells the
 * flag (`--config` alone, `--config=`, `-c=x`, `-cx`) is left in `args` for
 * {@link findUnsupportedBunArgs} to reject.
 *
 * @param bunArgs - The user's `bun.bunArgs`; not modified
 */
export function splitBunConfigArg(bunArgs: readonly string[]): SplitBunConfigArg {
    const args: string[] = [];
    let configPath: string | undefined;
    for(let i = 0; i < bunArgs.length; i++) {
        const arg = bunArgs[i];
        if(arg.startsWith('--config=') && arg.length > '--config='.length) {
            configPath = arg.slice('--config='.length);
        } else if((arg === '--config' || arg === '-c') && isConfigPathToken(bunArgs.at(i + 1))) {
            configPath = bunArgs[i + 1];
            i += 1;
        } else {
            args.push(arg);
        }
    }
    return { args, configPath };
}

/**
 * Find every token in `bunArgs` that spells a rejected flag. A flag's separate
 * value token (`--max-concurrency 5`, `-t pattern`) is not inspected: only the
 * flag itself is reported. A usable `--config`/`-c` is accepted (see
 * {@link splitBunConfigArg}); only an unusable spelling of it is reported.
 *
 * @returns Offending tokens in the order given, each reported once
 */
export function findUnsupportedBunArgs(bunArgs: readonly string[]): UnsupportedBunArg[] {
    const found: UnsupportedBunArg[] = [];
    const seen = new Set<string>();
    for(const arg of splitBunConfigArg(bunArgs).args) {
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
 * `bunArgs` without bun's test-order randomization flags, for mutant runs.
 *
 * `--randomize`, and `--seed` (which turns randomize on by itself), shuffle both
 * the order of test files and the order of tests within each file (measured on
 * bun 1.4.2). The dry run keeps them, so a suite with order dependencies still
 * shows up there. Mutant runs drop them: they run the test files in the
 * runner's cheapest-first order, so with bail the fastest killing test runs
 * first, and so a mutant's verdict does not depend on a random order. Removed:
 * `--randomize`, `--seed=<value>`, and a bare `--seed` together with the token
 * after it, which bun always reads as the seed. Like the bail flags (see
 * stripBailArgs in process-runner.ts), they are taken out rather than rejected,
 * because they are valid for the dry run.
 *
 * @param bunArgs - The user's `bun.bunArgs`; not modified
 * @returns The remaining args, in their original order
 */
export function stripRandomizeArgs(bunArgs: readonly string[]): string[] {
    const args: string[] = [];
    for(let i = 0; i < bunArgs.length; i++) {
        const arg = bunArgs[i];
        if(arg === '--seed') {
            i += 1;
        } else if(arg !== '--randomize' && !arg.startsWith('--seed=')) {
            args.push(arg);
        }
    }
    return args;
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
