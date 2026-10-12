/**
 * Coverage mapping utilities
 * Maps counter-based coverage IDs to inspector test IDs with full names
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { TestInfo } from '../inspector/types.js';
import { buildDiscoveryOrderIndex, sortDuplicateGroupByLineThenDiscovery } from '../utils/duplicate-suffix.js';
import { buildProjectFileTestName, buildUniqueTestName, normalizeTestFilePath } from '../utils/test-name.js';

/**
 * Result shape returned by mapCoverageToInspectorIds.
 *
 * - `coverage`: the remapped MutantCoverage (or undefined if input was missing/empty)
 * - `inspectorIdToProjectFile`: inspector-ID → project-file mapping built during pairing.
 *   Only populated for the new file-prefixed format ("relativeFile@@test-N"); empty Map
 *   for legacy keys ("test-N") and passthrough paths (unknown format, empty, undefined).
 * - `counterKeyToTestName`: raw counter key ("relativeFile@@test-N") → resolved full test
 *   name, for keys whose testInfo was successfully resolved. Always present (empty Map
 *   when not applicable), so callers (e.g. coverage-bleed warnings) can resolve a
 *   pre-remap counter key to a human-readable test name without redoing the pairing work.
 * - `rawKeyCount`: total number of coverage keys seen in `rawCoverage.perTest`
 *   before any resolution, in every format. 0 for missing/empty input. The
 *   preload records one key per test start, so the dry-run completeness gate
 *   (bun-test-runner.ts) requires this to equal the number of test starts.
 * - `orphanedKeyCount`: number of counter keys that could not be credited to any
 *   inspector test, and whose coverage is therefore missing from `coverage`: a key
 *   with no test start of its own, or one whose test start has no found event. The
 *   dry-run completeness gate fails the dry run when it is not 0. Always 0 for the
 *   unknown-format passthrough, whose keys the gate checks against the test ids instead.
 */
export interface CoverageMapResult {
    coverage:                 MutantCoverage | undefined
    inspectorIdToProjectFile: Map<number, string>
    counterKeyToTestName:     Map<string, string>
    rawKeyCount:              number
    orphanedKeyCount:         number
}

/**
 * Maps coverage counter keys (file-prefixed "file@@test-N" or legacy "test-N")
 * to full hierarchical test names, using per-file positional mapping for
 * deterministic results when Bun runs files in parallel.
 *
 * Also builds the inspector-ID → project-file mapping (from counter key prefixes) as a
 * side product of the pairing work, so callers do not need to run the pairing twice.
 *
 * @param rawCoverage - Coverage data with counter-based keys
 * @param executionOrder - Inspector test IDs in execution order
 * @param testHierarchy - Map of inspector ID to TestInfo
 * @param logger - Optional logger for diagnostic warnings
 * @returns CoverageMapResult with remapped coverage and inspector-to-project-file map
 */
export function mapCoverageToInspectorIds(
    rawCoverage: MutantCoverage | undefined | null,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn' | 'debug'>
): CoverageMapResult {
    // Handle empty or missing coverage - return as-is.
    // rawCoverage can be undefined/null at runtime even though the primary overload
    // accepts only MutantCoverage — callers may pass partially-initialised global data.
    // Stryker disable next-line ConditionalExpression: equivalent mutation - empty perTest is also caught by firstKey check below
    if(!rawCoverage?.perTest || Object.keys(rawCoverage.perTest).length === 0) {
        return {
            coverage:                 rawCoverage ?? undefined,
            inspectorIdToProjectFile: new Map(),
            counterKeyToTestName:     new Map(),
            rawKeyCount:              0,
            orphanedKeyCount:         0,
        };
    }

    const firstKey = Object.keys(rawCoverage.perTest)[0];

    // New format: "relativeFile@@test-N" (file-prefixed counter keys).
    // Use per-file positional mapping to eliminate cross-file counter collisions.
    // Stryker disable next-line Regex: anchors are defensive for pattern matching file-prefixed keys
    if(/@@test-\d+$/.test(firstKey)) {
        return mapFilePrefixedCounterKeys(rawCoverage, executionOrder, testHierarchy, logger);
    }

    // Legacy format: "test-N" (global counter keys, no file prefix).
    // Fall back to global positional mapping via executionOrder.
    // Stryker disable next-line Regex: anchors are defensive for pattern matching counter-based keys
    if(/^test-\d+$/.test(firstKey)) {
        const { coverage, orphanedKeyCount } = mapLegacyCounterKeys(rawCoverage, executionOrder, testHierarchy, logger);
        return {
            coverage,
            inspectorIdToProjectFile: new Map(),
            counterKeyToTestName:     new Map(),
            rawKeyCount:              Object.keys(rawCoverage.perTest).length,
            orphanedKeyCount,
        };
    }

    // Unknown format - assume already remapped and return unchanged.
    return {
        coverage:                 rawCoverage,
        inspectorIdToProjectFile: new Map(),
        counterKeyToTestName:     new Map(),
        rawKeyCount:              Object.keys(rawCoverage.perTest).length,
        orphanedKeyCount:         0,
    };
}

/**
 * Build the new perTest map, stripping mutants that are recorded in the static bucket.
 * Test entries left empty after stripping are dropped.
 */
function buildFilteredPerTest(
    perTestEntries: [string, Record<string, number>][],
    staticIds: Set<string>
): Record<string, Record<string, number>> {
    const newPerTest: Record<string, Record<string, number>> = {};
    for(const [testId, counts] of perTestEntries) {
        const filteredCounts: Record<string, number> = {};
        for(const [mutantId, hitCount] of Object.entries(counts)) {
            if(!staticIds.has(mutantId)) {
                filteredCounts[mutantId] = hitCount;
            }
        }
        // Only keep the test entry if it still has any mutants after filtering.
        if(Object.keys(filteredCounts).length > 0) {
            newPerTest[testId] = filteredCounts;
        }
    }
    return newPerTest;
}

/**
 * Enforce "static wins" attribution: strip from every perTest entry any
 * mutant ID that is already recorded in the static bucket.
 *
 * Module-level (top-level) code executes eagerly during preload — see
 * src/templates/coverage-preload.ts Section 3 (eager module imports) —
 * while no test is active (currentTestId is undefined), so the instrumenter
 * records module-init mutants deterministically into the raw static bucket
 * before any test runs. When tests later call into the same code, those
 * mutants can ALSO appear in perTest entries; static is the more
 * conservative claim ("run all tests for this mutant"), so it wins and the
 * perTest duplicates are stripped.
 *
 * Mutants that appear in multiple perTest entries WITHOUT a static record
 * are left untouched: multi-test coverage is the normal shape for shared
 * code paths, and preserving it is what lets Stryker plan targeted per-test
 * mutant runs and lets the incremental differ detect newly-added covering
 * tests.
 *
 * Degraded path: if a module's eager import throws during preload, the
 * preload catches the error and warns (see src/templates/coverage-preload.ts
 * Section 3) rather than crashing. That module's top-level code then runs
 * instead at the first *lazy* import of the module — i.e. while a test is
 * active — so its module-init mutants land in that single perTest entry
 * rather than in static. This matches the pre-change behavior: the removed
 * `count > 1` promotion rule never fired for single-entry mutants anyway,
 * so no protection is lost here — attribution for this rare case simply
 * isn't static.
 *
 * @param coverage - Fully-mapped MutantCoverage (perTest keys are test names)
 * @returns New MutantCoverage with static-covered mutants stripped from perTest
 */
function stabilizeCoverage(coverage: MutantCoverage): MutantCoverage {
    const staticIds = new Set(Object.keys(coverage.static));
    return {
        'static': coverage.static,
        perTest:  buildFilteredPerTest(Object.entries(coverage.perTest), staticIds),
    };
}

/**
 * Per-mutant hit totals exactly as Stryker core computes them
 * (mutants/test-coverage.js): the `static` count plus the count in every
 * perTest entry.
 */
function sumHitsByMutant(coverage: MutantCoverage): Map<string, number> {
    const totals = new Map<string, number>();
    for(const counts of [coverage.static, ...Object.values(coverage.perTest)]) {
        for(const [mutantId, count] of Object.entries(counts)) {
            totals.set(mutantId, (totals.get(mutantId) ?? 0) + count);
        }
    }
    return totals;
}

/**
 * Give every mutant in the mapped coverage back the hit total it had in the raw
 * coverage, without changing which buckets it appears in.
 *
 * Stryker gives each mutant run a hitLimit of 100 × the mutant's total hits.
 * Mapping changes attribution — "static wins" strips static mutants out of
 * perTest, and keys that cannot be paired with an inspector test are dropped —
 * and both would otherwise drop hits along with it. A static mutant hit once at
 * module load and 1000 times by tests would get a limit of 100, and its
 * full-suite mutant run would be stopped as a false Timeout. So each mapped
 * mutant's shortfall is added to one bucket that already holds it: `static`
 * when it is static, else the first perTest entry holding it. Mutants that no
 * longer appear anywhere are left out; adding them would invent coverage.
 *
 * @returns A copy; neither input is modified.
 * @throws Error when a mapped mutant is missing from the raw coverage or has more
 *         mapped hits than raw hits. Mapping only ever removes or merges hits, so
 *         either means the mapping itself is broken; carrying on would hand Stryker
 *         counts <= 0 or NaN, which its `count > 0` filter silently drops, losing a
 *         test's attribution. Failing loudly is preferred to that corruption.
 *
 * Exported for unit tests only.
 */
export function restoreHitTotals(rawCoverage: MutantCoverage, mapped: MutantCoverage): MutantCoverage {
    const rawTotals = sumHitsByMutant(rawCoverage);
    const result: MutantCoverage = {
        'static': { ...mapped.static },
        perTest:  Object.fromEntries(Object.entries(mapped.perTest).map(([testId, counts]) => [testId, { ...counts }])),
    };
    // The first bucket holding each mutant, found in one pass over all of them: searching
    // the buckets once per mutant costs mutants × tests, which is minutes for a large suite.
    const firstHolder = new Map<string, Record<string, number>>();
    for(const counts of [result.static, ...Object.values(result.perTest)]) {
        for(const mutantId of Object.keys(counts)) {
            if(!firstHolder.has(mutantId)) {
                firstHolder.set(mutantId, counts);
            }
        }
    }
    for(const [mutantId, mappedTotal] of sumHitsByMutant(result)) {
        const bucket = firstHolder.get(mutantId)!;
        const rawTotal = rawTotals.get(mutantId);
        if(rawTotal === undefined) {
            throw new Error(`Internal invariant violated: mutant ${mutantId} has ${mappedTotal} mapped hits but no raw hits`);
        }
        const shortfall = rawTotal - mappedTotal;
        if(shortfall < 0) {
            throw new Error(`Internal invariant violated: mutant ${mutantId} has ${mappedTotal} mapped hits but only ${rawTotal} raw hits`);
        }
        bucket[mutantId] += shortfall;
    }
    return result;
}

/**
 * Split a file-prefixed counter key ("relativeFile@@test-N") into its file and
 * its 1-based position within that file.
 *
 * The key is split at its LAST "@@": the file may contain "@@" itself (a
 * directory such as `tests/x@@y/`), but the counter after the separator never
 * does. A key with no "@@" at all is all file, at position 0, and a counter
 * that is not a number is position 0 too, so such a key resolves to no test.
 */
export function splitCounterKey(key: string): { filePrefix: string, position: number } {
    const sepIdx = key.lastIndexOf('@@');
    if(sepIdx === -1) {
        return { filePrefix: key, position: 0 };
    }
    return {
        filePrefix: key.slice(0, sepIdx),
        position:   Number.parseInt(key.slice(sepIdx + '@@test-'.length), 10) || 0,
    };
}

/**
 * Map file-prefixed counter keys ("relativeFile@@test-N") to full test names.
 *
 * For each key we:
 *  1. Split at the last "@@" (see {@link splitCounterKey}) to get
 *     `[filePrefix, "test-N"]`.
 *  2. Find all inspector tests whose normalised URL matches `filePrefix`, in
 *     their execution order.
 *  3. Take the (N-1)th element as the test that produced coverage key N.
 *
 * This is deterministic because tests within a single file always execute in
 * the same order, and the per-file counter always starts at 1 for each file.
 */
interface KeyInspectorPair {
    filePrefix:  string
    inspectorId: number
}

/**
 * Pair each coverage counter key with the test start it was recorded for,
 * using global positional order: the preload's beforeEach records exactly one
 * key each time bun starts a test, so the Nth key belongs to the Nth
 * TestReporter.start.
 *
 * Every start is paired, whatever status the test ends with. Observed with
 * bun 1.3.7, 1.3.14 and 1.4.2: skipped and pending tests are never started
 * (and run no beforeEach), a retried test is started once per attempt (and
 * records one key per attempt), and a pending test that bun's include-pending
 * flag runs is started and records a key. When the counts differ, the pairs stop at the shorter
 * list; the dry-run completeness gate reports the difference.
 *
 * This is the shared core logic used by both mapFilePrefixedCounterKeys and
 * buildInspectorIdToProjectFile to avoid duplicating the @@ extraction.
 */
function pairKeysWithInspectorIds(
    globallyOrderedPerTestKeys: string[],
    executionOrder: number[]
): KeyInspectorPair[] {
    // Stryker disable next-line MethodExpression: Math.max produces the same end-to-end output — excess iterations get undefined inspector IDs which are already filtered out
    const pairCount = Math.min(globallyOrderedPerTestKeys.length, executionOrder.length);
    const pairs: KeyInspectorPair[] = [];

    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop → Timeout
    for(let i = 0; i < pairCount; i++) {
        const { filePrefix } = splitCounterKey(globallyOrderedPerTestKeys[i]);
        pairs.push({ filePrefix, inspectorId: executionOrder[i] });
    }

    return pairs;
}

/**
 * Build a map from inspector ID to project file path, using positional pairing.
 *
 * The project file is derived from the coverage counter key prefix (Bun.main),
 * which is always the user's test file — even when testInfo.url points to
 * node_modules (as happens with helpers like ESLint's RuleTester.run()).
 *
 * Tests bun never started (skipped ones) have no counter key and are not mapped here.
 *
 * @param globallyOrderedPerTestKeys - Coverage counter keys in global insertion order
 * @param executionOrder - Inspector test IDs in chronological start-event order
 * @returns Map from inspector ID to project file prefix
 */
export function buildInspectorIdToProjectFile(
    globallyOrderedPerTestKeys: string[],
    executionOrder: number[]
): Map<number, string> {
    const pairs = pairKeysWithInspectorIds(globallyOrderedPerTestKeys, executionOrder);

    const inspectorIdToProjectFile = new Map<number, string>();
    for(const { filePrefix, inspectorId } of pairs) {
        inspectorIdToProjectFile.set(inspectorId, filePrefix);
    }

    return inspectorIdToProjectFile;
}

interface ResolvedCounterKey {
    name:        string
    testInfo:    TestInfo | null
    inspectorId: number | undefined
}

/**
 * First-pass: resolve all counter keys to test names and testInfos.
 *
 * Key N of a file belongs to the Nth test start paired with that file. A key
 * with no such start (more keys than starts) resolves to no test: it is never
 * folded into a neighbouring test, which would credit that test with coverage
 * it did not produce. Retries need no folding: bun starts a retried test once
 * per attempt, so each attempt's key pairs with its own start of the same id.
 */
function resolveCounterKeys(
    counterIds: string[],
    fileToInspectorIds: Map<string, number[]>,
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn' | 'debug'>
): ResolvedCounterKey[] {
    return counterIds.map((key) => {
        const { filePrefix, position: n } = splitCounterKey(key); // n is 1-based

        const inspectorId = fileToInspectorIds.get(filePrefix)?.[n - 1];
        const testInfo = inspectorId === undefined ? undefined : testHierarchy.get(inspectorId);

        if(testInfo) {
            // Use the counter key's file prefix (from Bun.main) instead of testInfo.url.
            // testInfo.url may point to node_modules for tests defined via helpers like
            // ESLint's RuleTester.run() — using the counter prefix ensures the test name
            // reflects the user's test file, not an internal helper file.
            const testName = buildProjectFileTestName(filePrefix, testInfo.fullName);
            return { name: testName, testInfo, inspectorId };
        }

        // Per-key detail is debug (not warn): a whole-file drop produces one of these
        // PER KEY (potentially thousands, observed under CI runner contention when the
        // inspector event stream is truncated), so the
        // default-visible signal is the single aggregate warn in mapFilePrefixedCounterKeys;
        // this stays available at debug level for anyone diagnosing a specific key.
        // Stryker disable StringLiteral: diagnostic logging message — format strings not functionally tested
        logger?.debug(
            'Coverage key %s: no inspector test found for file "%s" at position %s '
            + '(file has %s tests in execution order). Skipping this test in coverage mapping.',
            // Stryker restore StringLiteral
            key,
            filePrefix,
            n,
            // Stryker disable next-line LogicalOperator: equivalent mutant — fallback value only appears in the debug message, not in any mapping logic
            fileToInspectorIds.get(filePrefix)?.length ?? 0
        );
        // Stryker disable next-line StringLiteral: equivalent mutant — the unknown name is only used as a Map key that is immediately skipped (testInfo: null) in buildMappedCoverage
        return { name: `unknown-${key}`, testInfo: null, inspectorId: undefined };
    });
}

/**
 * How the second pass ({@link buildMappedCoverage}) names the tests of resolved counter keys.
 *
 * Two distinct deduplication cases:
 *  1. Retries: multiple counter keys resolved to the SAME inspectorId (same test ran
 *     multiple times). Coverage data is MERGED (union) into a single perTest entry.
 *     No suffix is appended — the entry represents all attempts of that test.
 *
 *  2. it.each (same name, different inspectorIds): multiple counter keys resolved to
 *     DIFFERENT inspectorIds that happen to share the same fullName (e.g. template
 *     literal not yet interpolated). These get [0], [1], … suffixes as before.
 */
/**
 * First pass: count how many DISTINCT inspectorIds share each base name.
 * Entries with the same inspectorId are retries and do NOT count as duplicates.
 */
function buildNameInspectorIds(resolved: ResolvedCounterKey[]): Map<string, Set<number | undefined>> {
    const nameInspectorIds = new Map<string, Set<number | undefined>>();
    for(const { name, inspectorId, testInfo } of resolved) {
        // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutants — null-testInfo entries use name "unknown-<key>" (unique) so including them doesn't produce duplicate counts for valid names; the second pass in buildMappedCoverage skips them anyway
        if(!testInfo) {
            continue;
        }
        let ids = nameInspectorIds.get(name);
        if(!ids) {
            ids = new Set();
            nameInspectorIds.set(name, ids);
        }
        ids.add(inspectorId);
    }
    return nameInspectorIds;
}

/**
 * Precompute the final ' [N]' suffix for every (inspectorId, baseName) pair
 * across all duplicate-named groups, using the SAME (source line ascending,
 * then discovery order) tie-break as bun-test-runner.ts's v2 registry dedup
 * (buildTestsFromInspector) — see src/utils/duplicate-suffix.ts's doc comment
 * for why this specific key is what makes the two call sites agree
 * regardless of bun's per-run execution-order shuffle.
 *
 * @returns Map from `"${inspectorId}/${baseName}"` to its 0-based suffix index.
 */
function buildDuplicateNameIndex(
    nameInspectorIds: Map<string, Set<number | undefined>>,
    testHierarchy: Map<number, TestInfo>
): Map<string, number> {
    const discoveryOrderIndex = buildDiscoveryOrderIndex(testHierarchy.keys());
    const indexByKey = new Map<string, number>();

    for(const [baseName, ids] of nameInspectorIds) {
        // No special case for single-id groups: they get index 0, which resolveEachTestName never
        // reads (it returns the bare name when a base name has at most one distinct inspector id).
        // Stryker disable next-line ConditionalExpression: only the always-true variant is
        // equivalent — ids only ever holds defined numbers here. buildNameInspectorIds only calls
        // `ids.add(inspectorId)` after its own `if(!testInfo) continue` guard, and
        // resolveCounterKeys only ever produces a truthy testInfo when inspectorId is a defined
        // number (testInfo is explicitly set to undefined whenever inspectorId is undefined, and
        // testHierarchy.get(inspectorId) is only called when inspectorId is defined) — so
        // `id !== undefined` mutated to `true` filters out exactly as many (zero) elements as the
        // real predicate. The always-false variant is NOT equivalent — it would empty every
        // `group`, wrongly collapsing all duplicate-name groups into "no suffix needed" — but is
        // already killed by 'should handle deduplication for tests with same name from same file
        // (it.each)' and the SOURCE LINE / discovery-order suffix tests below it.
        const group = [...ids].filter((id): id is number => id !== undefined);
        const sorted = sortDuplicateGroupByLineThenDiscovery(
            group,
            id => testHierarchy.get(id)?.line,
            id => id,
            discoveryOrderIndex
        );
        for(const [i, id] of sorted.entries()) {
            indexByKey.set(`${id}/${baseName}`, i);
        }
    }

    return indexByKey;
}

/**
 * Resolve a final (possibly suffixed) test name for the it.each deduplication case.
 *
 * When multiple DISTINCT inspector IDs share the same base name (it.each with a
 * template literal not yet interpolated), append `[0]`, `[1]`, … per inspector,
 * assigned by {@link buildDuplicateNameIndex} — a pure lookup, no mutable state.
 * Retries (same inspector, same name) are detected by `distinctIds.size === 1`
 * and do NOT get a suffix.
 *
 * @returns The final (possibly suffixed) test name.
 */
function resolveEachTestName(
    baseName: string,
    inspectorId: number | undefined,
    nameInspectorIds: Map<string, Set<number | undefined>>,
    duplicateNameIndex: Map<string, number>
): string {
    const distinctIds = nameInspectorIds.get(baseName);
    // Stryker disable next-line ConditionalExpression: equivalent — undefined distinctIds means count=1, no dedup
    if((distinctIds?.size ?? 1) <= 1) {
        return baseName;
    }
    // Key format: "inspectorId/baseName" — inspectorId is always a number so the prefix is unambiguous.
    const key_ = `${inspectorId}/${baseName}`;
    // Stryker disable next-line LogicalOperator: equivalent — a key absent from duplicateNameIndex only happens for an inspectorId not in testHierarchy, which cannot occur here (resolveCounterKeys already filtered testInfo:null entries out before this is called); the ?? 0 fallback is unreachable in practice
    const index = duplicateNameIndex.get(key_) ?? 0;
    return `${baseName} [${index}]`;
}

/**
 * The mapped coverage of file-prefixed counter keys, built in one pass over the
 * raw hits. It is exactly
 * `restoreHitTotals(raw, stabilizeCoverage({ static: raw.static, perTest: remapped }))`,
 * where `remapped` credits each resolved key's hits to its final test name
 * (merging the attempts of a retried test), without building and copying those
 * three intermediate results: on a 2,000-test suite they cost the dry run about
 * 150 ms, mostly in allocation and garbage collection.
 *
 * - A resolved key's hit on a mutant that is in `static` goes to `static`
 *   ("static wins", with the hits kept for the mutant's hitLimit); any other
 *   hit goes to the key's test.
 * - A test left with no mutant is left out.
 * - An orphaned key's hits (a key resolved to no test) go to the first bucket
 *   that holds the mutant: `static`, else the first test, in order, that does.
 *   A mutant no bucket holds is left out, since adding it would invent coverage.
 *
 * So every mutant keeps its raw hit total wherever it still appears, as
 * {@link restoreHitTotals} guarantees. The raw coverage is not modified, but the
 * result shares per-test records with it.
 */
function buildMappedCoverage(
    counterIds: string[],
    resolved: ResolvedCounterKey[],
    rawCoverage: MutantCoverage,
    testHierarchy: Map<number, TestInfo>
): MutantCoverage {
    const nameInspectorIds = buildNameInspectorIds(resolved);
    const duplicateNameIndex = buildDuplicateNameIndex(nameInspectorIds, testHierarchy);
    const staticCounts: Record<string, number> = { ...rawCoverage.static };
    const staticIds = new Set(Object.keys(staticCounts));
    const creditedByName = new Map<string, Record<string, number>>();
    // The records built here, which may be written to. A test credited with exactly one
    // key's hits, none of them static (most tests), shares that key's raw record instead
    // of copying it hit by hit; a shared record is copied before anything is added to it.
    const owned = new Set<Record<string, number>>();
    const orphaned: Record<string, number>[] = [];

    for(const [i, key] of counterIds.entries()) {
        const incoming = rawCoverage.perTest[key] ?? {};
        const { name: baseName, testInfo, inspectorId } = resolved[i];
        if(!testInfo) {
            orphaned.push(incoming);
            continue;
        }
        const finalName = resolveEachTestName(baseName, inspectorId, nameInspectorIds, duplicateNameIndex);
        const credited = creditedByName.get(finalName);
        if(!credited && !holdsAny(incoming, staticIds)) {
            creditedByName.set(finalName, incoming);
            continue;
        }
        let writable = credited;
        if(!writable || !owned.has(writable)) {
            writable = { ...credited };
            owned.add(writable);
            creditedByName.set(finalName, writable);
        }
        creditHits(incoming, writable, staticIds, staticCounts);
    }

    const perTest = nonEmptyTests(creditedByName, orphaned.length > 0 ? owned : undefined);
    if(orphaned.length > 0) {
        creditOrphanedHits(orphaned, staticCounts, perTest);
    }
    return { 'static': staticCounts, perTest };
}

/** Add one key's hits to its test, or to `static` for a static mutant ("static wins"). See {@link buildMappedCoverage}. */
function creditHits(
    incoming: Record<string, number>,
    credited: Record<string, number>,
    staticIds: ReadonlySet<string>,
    staticCounts: Record<string, number>
): void {
    for(const mutantId of Object.keys(incoming)) {
        const hits = incoming[mutantId];
        if(staticIds.has(mutantId)) {
            staticCounts[mutantId] += hits;
        } else {
            // Retries merge: each attempt's hits add to the same test.
            credited[mutantId] = (credited[mutantId] ?? 0) + hits;
        }
    }
}

/**
 * The tests credited with any mutant, in the order they were first credited. With
 * `owned` (when more hits are still to be added), each record not in it — one shared
 * with the raw coverage — is copied, so the raw coverage is never written to.
 */
function nonEmptyTests(
    creditedByName: ReadonlyMap<string, Record<string, number>>,
    owned: ReadonlySet<Record<string, number>> | undefined
): Record<string, Record<string, number>> {
    const perTest: Record<string, Record<string, number>> = {};
    for(const [name, counts] of creditedByName) {
        if(Object.keys(counts).length > 0) {
            perTest[name] = owned && !owned.has(counts) ? { ...counts } : counts;
        }
    }
    return perTest;
}

/** Whether `counts` holds any of `mutantIds`. */
function holdsAny(counts: Record<string, number>, mutantIds: ReadonlySet<string>): boolean {
    for(const mutantId of Object.keys(counts)) {
        if(mutantIds.has(mutantId)) {
            return true;
        }
    }
    return false;
}

/**
 * Add orphaned keys' hits to the first bucket holding each mutant: `static`, else
 * the first test in `perTest` order. See {@link buildMappedCoverage}.
 */
function creditOrphanedHits(
    orphaned: readonly Record<string, number>[],
    staticCounts: Record<string, number>,
    perTest: Record<string, Record<string, number>>
): void {
    const firstHolder = new Map<string, Record<string, number>>();
    for(const counts of [staticCounts, ...Object.values(perTest)]) {
        for(const mutantId of Object.keys(counts)) {
            if(!firstHolder.has(mutantId)) {
                firstHolder.set(mutantId, counts);
            }
        }
    }
    for(const counts of orphaned) {
        for(const mutantId of Object.keys(counts)) {
            const holder = firstHolder.get(mutantId);
            if(holder) {
                holder[mutantId] += counts[mutantId];
            }
        }
    }
}

/**
 * Defensive interior-gap check: warn when a coverage key is cross-paired with an inspector
 * from a different file, which indicates a positional misalignment due to an interior gap
 * (e.g. beforeAll failure aborting tests after their inspector start events already fired).
 *
 * We skip inspectors with no URL or with node_modules URLs (e.g. RuleTester) because
 * those tests legitimately pair with keys from a different file — that is the expected case.
 */
function warnInteriorGapIfPresent(
    pairs: KeyInspectorPair[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): void {
    const warnedFiles = new Set<string>();
    for(const { filePrefix, inspectorId } of pairs) {
        const testUrl = testHierarchy.get(inspectorId)?.url;
        // Skip when no URL or when it's a helper file (node_modules / no sandbox path)
        if(!testUrl) {
            continue;
        }
        const inspectorFile = normalizeTestFilePath(testUrl);
        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — undefined inspectorFile or node_modules skip avoids false-positive on RuleTester-style tests
        if(!inspectorFile || testUrl.includes('node_modules')) {
            continue;
        }
        // Stryker disable next-line EqualityOperator: !== is correct — mismatched files signal cross-file pairing
        if(filePrefix !== inspectorFile && !warnedFiles.has(filePrefix)) {
            warnedFiles.add(filePrefix);
            // Stryker disable StringLiteral: diagnostic logging message
            logger?.warn(
                'Interior coverage gap detected for "%s": coverage key paired with inspector test from "%s". '
                + 'Some tests may have been aborted mid-run (e.g. beforeAll failure). Coverage mapping may be inaccurate.',
                // Stryker restore StringLiteral
                filePrefix,
                inspectorFile
            );
        }
    }
}

/**
 * Aggregate orphan reporting: a key is "orphaned" when resolveCounterKeys could
 * not credit it to any inspector test (testInfo: null) — its file was dropped
 * from the inspector stream, or it has no test start of its own. Per-key detail
 * is logger.debug (see resolveCounterKeys) — this single aggregate logger.warn
 * is the default-visible signal.
 *
 * @returns The orphaned key count, for the caller to feed into the dry-run
 *   completeness gate (bun-test-runner.ts), which fails the dry run when it is not 0.
 */
function reportOrphanedKeys(
    resolved:   readonly ResolvedCounterKey[],
    counterIds: readonly string[],
    logger?:    Pick<Logger, 'warn'>
): number {
    const orphanedIndexes: number[] = [];
    for(const [i, r] of resolved.entries()) {
        if(!r.testInfo) {
            orphanedIndexes.push(i);
        }
    }
    const orphanedKeyCount = orphanedIndexes.length;
    if(orphanedKeyCount > 0) {
        const orphanedFiles = new Set<string>();
        for(const i of orphanedIndexes) {
            orphanedFiles.add(splitCounterKey(counterIds[i]).filePrefix);
        }
        // Stryker disable StringLiteral: diagnostic logging message
        logger?.warn(
            '%s of %s coverage key(s) across %s file(s) could not be paired with any inspector test '
            + '(orphaned — see per-key detail at debug level). This can indicate the Bun inspector '
            + 'stream was truncated mid-run.',
            // Stryker restore StringLiteral
            orphanedKeyCount,
            counterIds.length,
            orphanedFiles.size
        );
    }
    return orphanedKeyCount;
}

function mapFilePrefixedCounterKeys(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn' | 'debug'>
): CoverageMapResult {
    // Use Object.keys insertion order — this is the global chronological order
    // in which beforeEach fired, which matches executionOrder (one start per attempt).
    // Do NOT sort here: the global positional pairing in buildFileToInspectorIds
    // depends on insertion order being preserved.
    // Stryker disable next-line MethodExpression: Array.from vs spread vs Object.keys — all three produce the same insertion-ordered key array
    const globallyOrderedKeys = Object.keys(rawCoverage.perTest);

    // Build paired (filePrefix, inspectorId) list once; both consumers (file map and
    // inspector-to-project-file map) derive their structures from this single list.
    const pairs = pairKeysWithInspectorIds(globallyOrderedKeys, executionOrder);

    // Build per-file inspector-ID list (used by resolveCounterKeys).
    const fileToInspectorIds = new Map<string, number[]>();
    // Build inspector-ID → project-file map (returned for use by bun-test-runner).
    const inspectorIdToProjectFile = new Map<number, string>();
    for(const { filePrefix, inspectorId } of pairs) {
        const bucket = fileToInspectorIds.get(filePrefix);
        if(bucket) {
            bucket.push(inspectorId);
        } else {
            fileToInspectorIds.set(filePrefix, [inspectorId]);
        }
        inspectorIdToProjectFile.set(inspectorId, filePrefix);
    }

    // Defensive interior-gap check: detect cross-file pairing not caught by global count.
    // Stryker disable next-line EqualityOperator: == is correct — we only run interior-gap check when totals match (no retry excess)
    if(globallyOrderedKeys.length === pairs.length) {
        warnInteriorGapIfPresent(pairs, testHierarchy, logger);
    }

    // Sort the counter IDs numerically within each file for resolveCounterKeys.
    // resolveCounterKeys extracts position N from "file@@test-N" and uses
    // fileIds[N-1] to look up the inspector ID.  The global positional pairing
    // already placed them in per-file order, so N-1 always lands on the correct inspector ID.
    // Stryker disable next-line ArithmeticOperator: equivalent mutant — sort order doesn't affect correctness since resolveCounterKeys extracts position from key string directly
    const counterIds = globallyOrderedKeys.toSorted((a, b) => splitCounterKey(a).position - splitCounterKey(b).position);

    const resolved = resolveCounterKeys(counterIds, fileToInspectorIds, testHierarchy, logger);

    // Raw counter key -> resolved full test name, for keys whose testInfo resolved.
    // Lets callers (e.g. coverage-bleed warnings) resolve a pre-remap counter key
    // to a human-readable name without redoing the pairing/resolution work.
    const counterKeyToTestName = new Map<string, string>();
    for(const [i, key] of counterIds.entries()) {
        if(resolved[i].testInfo) {
            counterKeyToTestName.set(key, resolved[i].name);
        }
    }

    // Aggregate orphan reporting — see reportOrphanedKeys' doc comment. The count
    // feeds the dry-run completeness gate (bun-test-runner.ts).
    const orphanedKeyCount = reportOrphanedKeys(resolved, counterIds, logger);

    const coverage = buildMappedCoverage(counterIds, resolved, rawCoverage, testHierarchy);

    return {
        coverage,
        inspectorIdToProjectFile,
        counterKeyToTestName,
        rawKeyCount: counterIds.length,
        orphanedKeyCount,
    };
}

/**
 * Legacy: maps global counter keys ("test-N") to full test names using
 * positional correspondence with executionOrder.
 *
 * Kept for backward compatibility with coverage files produced by older
 * versions of the preload script.
 */
function mapLegacyCounterKeys(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): { coverage: MutantCoverage, orphanedKeyCount: number } {
    // Extract and sort counter-based test IDs numerically (test-1, test-2, ...)
    // Stryker disable StringLiteral: equivalent mutants — '??' fallback only fires for malformed keys; valid legacy keys always have 'test-N' format so split('-')[1] is never undefined
    const counterIds = Object.keys(rawCoverage.perTest).toSorted(
        (a, b) => Number.parseInt(a.split('-')[1] ?? '0', 10) - Number.parseInt(b.split('-')[1] ?? '0', 10)
    );
    // Stryker restore StringLiteral

    // Handle count mismatch - log warning and do partial mapping
    if(counterIds.length !== executionOrder.length) {
        // Stryker disable StringLiteral: diagnostic logging message format strings
        logger?.warn(
            'Coverage/execution count mismatch: %s coverage entries vs %s executed tests. '
            + 'Performing partial mapping for %s tests.',
            // Stryker restore StringLiteral
            counterIds.length,
            executionOrder.length,
            Math.min(counterIds.length, executionOrder.length)
        );
    }

    // First pass: build unique names and count occurrences (same logic as buildTestsFromInspector)
    // Stryker disable MethodExpression,ArrayDeclaration,EqualityOperator,BlockStatement,StringLiteral: equivalent mutants — Math.max vs Math.min and i<=maxIndex both cause out-of-bounds access that is silently skipped by the undefined testInfo check; [] vs ["Stryker was here"] only affects nameCounts for a name never used in second pass
    const maxIndex = Math.min(counterIds.length, executionOrder.length);
    const testNames: string[] = [];

    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop → Timeout
    for(let i = 0; i < maxIndex; i++) {
        const inspectorId = executionOrder[i];
        const testInfo = testHierarchy.get(inspectorId);
        if(testInfo) {
            testNames.push(buildUniqueTestName(testInfo.fullName, testInfo.url));
        }
        // A slot without test info contributes no name: the second pass skips it, and a
        // placeholder name here could collide with a real test titled the same.
    }
    // Stryker restore MethodExpression,ArrayDeclaration,EqualityOperator,BlockStatement,StringLiteral

    // Count occurrences for deduplication (handles it.each with %s placeholders)
    const nameCounts = new Map<string, number>();
    for(const name of testNames) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    // Second pass: map coverage with deduplicated names
    const remappedPerTest: Record<string, Record<string, number>> = {};
    const nameIndexes = new Map<string, number>();
    let creditedKeyCount = 0;

    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop → Timeout
    for(let i = 0; i < maxIndex; i++) {
        const counterId = counterIds[i];
        const inspectorId = executionOrder[i];
        const testInfo = testHierarchy.get(inspectorId);

        // Handle missing test info - skip with warning
        if(!testInfo) {
            // Stryker disable next-line all: Logging statement
            logger?.warn(
                'Missing test info for inspector ID %s (counter ID: %s). Skipping this test in coverage mapping.',
                inspectorId,
                counterId
            );
            continue;
        }

        // Build unique test name, applying deduplication suffix if needed
        const baseName = buildUniqueTestName(testInfo.fullName, testInfo.url);
        const count = nameCounts.get(baseName) ?? 1;
        let finalName = baseName;

        if(count > 1) {
            const index = nameIndexes.get(baseName) ?? 0;
            finalName = `${baseName} [${index}]`;
            nameIndexes.set(baseName, index + 1);
        }

        remappedPerTest[finalName] = rawCoverage.perTest[counterId];
        creditedKeyCount++;
    }

    // Return new coverage with remapped perTest and original static, with
    // static-covered mutants stripped from perTest (static wins), and every
    // mutant's raw hit total kept for Stryker's hitLimit. Every key not credited
    // above (no test start, or a start with no found event) is orphaned.
    return {
        coverage: restoreHitTotals(rawCoverage, stabilizeCoverage({
            'static': rawCoverage.static,
            perTest:  remappedPerTest,
        })),
        orphanedKeyCount: counterIds.length - creditedKeyCount,
    };
}
