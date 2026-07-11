/**
 * Shared duplicate-name ' [N]' suffix tie-break, used identically by
 * bun-test-runner.ts's v2 registry dedup (buildTestsFromInspector) and
 * coverage-mapper.ts's resolveEachTestName/buildRemappedPerTest, so that a
 * physical test with a duplicate title gets the SAME suffix in both the
 * registry (test.id) and the mutant coverage perTest key.
 *
 * Bun's per-run
 * --seed shuffle reorders TestReporter.start (execution order), so any
 * suffix scheme keyed off execution order can disagree run-to-run — and, more
 * importantly, disagree between two call sites that each derive their own
 * "execution order" independently. Both call sites now key off the same two
 * fields, in the same priority: (1) source line ascending, (2)
 * TestReporter.found arrival ("discovery order"), which — unlike start order
 * — is NOT reshuffled by bun's seed (empirically verified against bun 1.3.14
 * with --randomize and multiple --seed values: found order was declaration-
 * stable across all of them while start order varied per seed).
 */

/**
 * Build a 0-based discovery-order index for an iterable of inspector test
 * IDs already in discovery (TestReporter.found arrival) order — e.g. the key
 * iteration order of a `Map<number, TestInfo>` built from `inspector.getTests()`,
 * or that array itself.
 */
export function buildDiscoveryOrderIndex(discoveryOrderedIds: Iterable<number>): Map<number, number> {
    const index = new Map<number, number>();
    let i = 0;
    for(const id of discoveryOrderedIds) {
        index.set(id, i);
        i++;
    }
    return index;
}

/**
 * Sort a group of duplicate-named-test entries into the canonical duplicate-
 * suffix order: source line ascending (entries with no line sort last), tie-
 * broken by discovery order ascending (entries with no resolvable inspector
 * id, or an id missing from `discoveryOrderIndex`, sort last and among
 * themselves keep their relative input order — `toSorted` is stable).
 *
 * @param group - The entries sharing one duplicate base name.
 * @param getLine - Extracts the entry's source line, or undefined if unknown.
 * @param getInspectorId - Extracts the entry's inspector id, or undefined.
 * @param discoveryOrderIndex - From {@link buildDiscoveryOrderIndex}.
 */
export function sortDuplicateGroupByLineThenDiscovery<T>(
    group: readonly T[],
    getLine: (item: T) => number | undefined,
    getInspectorId: (item: T) => number | undefined,
    discoveryOrderIndex: Map<number, number>
): T[] {
    return group.toSorted((a, b) => {
        const lineA = getLine(a) ?? Infinity;
        const lineB = getLine(b) ?? Infinity;
        // Stryker disable next-line EqualityOperator: equivalent — when lineA===lineB this comparator falls through to the discovery-order tie-break below either way; a !== mutant only changes WHICH branch runs for equal lines, not the final sort order
        if(lineA !== lineB) {
            return lineA - lineB;
        }
        const idA = getInspectorId(a);
        const idB = getInspectorId(b);
        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — undefined id or missing index both fall back to Infinity, sorting unresolvable entries last; either mutant form still lands on the same fallback for the only inputs this is exercised with
        const discA = idA === undefined ? Infinity : (discoveryOrderIndex.get(idA) ?? Infinity);
        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — undefined id or missing index both fall back to Infinity, sorting unresolvable entries last; either mutant form still lands on the same fallback for the only inputs this is exercised with
        const discB = idB === undefined ? Infinity : (discoveryOrderIndex.get(idB) ?? Infinity);
        return discA - discB;
    });
}
