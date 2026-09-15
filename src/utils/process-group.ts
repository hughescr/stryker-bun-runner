/**
 * Process-group signalling.
 *
 * Lives in its own module (rather than inline in process-runner) for one
 * reason: signalling a process GROUP is destructive in a way that signalling a
 * single known child is not. A negative PID reaches every process in the group,
 * so a unit test that accidentally ran the real implementation against a mock
 * child's fabricated pid would signal whatever unrelated processes happen to
 * occupy that group on the developer's machine. Keeping it behind a module
 * boundary lets tests/test-preload.ts replace it with an inert default, so
 * that mistake is impossible by construction rather than by discipline.
 */

/**
 * Send `signal` to the entire process group led by `pid`.
 *
 * `bun test` children are spawned with `detached: true`, which makes each one
 * the leader of a fresh process group. Signalling the group (negative pid) is
 * therefore the only way to reach processes the test suite itself spawned:
 * `ChildProcess.kill()` signals the direct child alone, so any grandchild
 * survives, is reparented to PID 1, and keeps running unattended.
 *
 * Returns true when the signal was delivered, false when it could not be —
 * the group is already gone (ESRCH), the caller lacks permission (EPERM), or
 * the platform has no process groups. Callers are expected to fall back to
 * signalling the direct child on false, so behaviour never regresses below
 * what a plain `ChildProcess.kill()` would have achieved.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
    try {
        // Stryker disable next-line UnaryOperator: dropping the negation signals the single child instead of the group — exactly the leak this function exists to close; covered by 'signals the process group with a negative pid'
        process.kill(-pid, signal);
        return true;
    } catch{
        // ESRCH (group already exited) is the common, expected case: the child
        // may have exited between the close-check and the signal. EPERM and
        // ENOSYS are treated the same way — report failure and let the caller
        // fall back rather than turning a best-effort cleanup into a throw.
        return false;
    }
}
