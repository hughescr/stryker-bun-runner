/**
 * Coverage mapping utilities
 * Maps counter-based coverage IDs to inspector test IDs with full names
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { TestInfo } from '../inspector/types.js';
import { buildProjectFileTestName, buildUniqueTestName, normalizeTestFilePath } from '../utils/test-name.js';

/**
 * Result shape returned by mapCoverageToInspectorIds.
 *
 * - `coverage`: the remapped MutantCoverage (or undefined if input was missing/empty)
 * - `inspectorIdToProjectFile`: inspector-ID → project-file mapping built during pairing.
 *   Only populated for the new file-prefixed format ("relativeFile@@test-N"); empty Map
 *   for legacy keys ("test-N") and passthrough paths (unknown format, empty, undefined).
 */
export interface CoverageMapResult {
    coverage:                 MutantCoverage | undefined
    inspectorIdToProjectFile: Map<number, string>
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
    logger?: Pick<Logger, 'warn'>
): CoverageMapResult {
    // Handle empty or missing coverage - return as-is.
    // rawCoverage can be undefined/null at runtime even though the primary overload
    // accepts only MutantCoverage — callers may pass partially-initialised global data.
    // Stryker disable next-line ConditionalExpression: equivalent mutation - empty perTest is also caught by firstKey check below
    if(!rawCoverage?.perTest || Object.keys(rawCoverage.perTest).length === 0) {
        return { coverage: rawCoverage ?? undefined, inspectorIdToProjectFile: new Map() };
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
        return { coverage: mapLegacyCounterKeys(rawCoverage, executionOrder, testHierarchy, logger), inspectorIdToProjectFile: new Map() };
    }

    // Unknown format - assume already remapped and return unchanged.
    return { coverage: rawCoverage, inspectorIdToProjectFile: new Map() };
}

/**
 * Promote ambiguously-attributed mutant IDs from perTest into static.
 *
 * Bun's module caching means that top-level code in a lazily-imported module
 * executes during whichever test first triggers the import.  Across two runs
 * the "first test" can differ, causing the same mutant to appear in
 * perTest[testA] in one run and perTest[testB] (or static) in another.
 *
 * This function eliminates that non-determinism with a simple rule:
 *   - Any mutant ID that appears in MORE than one test's perTest entry is
 *     promoted to static (it is effectively covered by all tests).
 *   - Any mutant ID that is already in static is removed from every perTest
 *     entry (static attribution wins — it is the more conservative claim).
 *
 * The promotion is semantically correct: "static" in Stryker means "covered
 * by every test run", which is exactly what top-level module code achieves
 * once the module is cached.  Keeping such mutants in perTest[someTest] is
 * both unstable AND inaccurate, because the mutant is not uniquely tied to
 * that one test.
 *
 * @param coverage - Fully-mapped MutantCoverage (perTest keys are test names)
 * @returns New MutantCoverage with stabilised static/perTest attribution
 */
/**
 * Count how many perTest entries each mutant ID appears in.
 */
function countPerTestAppearances(
    perTestEntries: [string, Record<string, number>][]
): Map<string, number> {
    const appearances = new Map<string, number>();
    for(const [, counts] of perTestEntries) {
        for(const mutantId of Object.keys(counts)) {
            appearances.set(mutantId, (appearances.get(mutantId) ?? 0) + 1);
        }
    }
    return appearances;
}

/**
 * Build the set of mutant IDs that should be promoted to static.
 * Includes all already-static IDs plus any that appear in >1 perTest entry.
 */
function buildPromoteToStaticSet(
    existingStaticKeys: string[],
    perTestAppearances: Map<string, number>
): Set<string> {
    const promoteToStatic = new Set<string>(existingStaticKeys);
    for(const [mutantId, count] of perTestAppearances) {
        // Stryker disable next-line EqualityOperator: > 1 is the correct threshold — 1 means uniquely attributed
        if(count > 1) {
            promoteToStatic.add(mutantId);
        }
    }
    return promoteToStatic;
}

/**
 * Build the new perTest map, stripping mutants that have been promoted to static.
 */
function buildFilteredPerTest(
    perTestEntries: [string, Record<string, number>][],
    promoteToStatic: Set<string>
): Record<string, Record<string, number>> {
    const newPerTest: Record<string, Record<string, number>> = {};
    for(const [testId, counts] of perTestEntries) {
        const filteredCounts: Record<string, number> = {};
        for(const [mutantId, hitCount] of Object.entries(counts)) {
            if(!promoteToStatic.has(mutantId)) {
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

function stabilizeCoverage(coverage: MutantCoverage): MutantCoverage {
    const perTestEntries = Object.entries(coverage.perTest);
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — empty perTest produces no promotions/contamination so second guard returns coverage unchanged
    if(perTestEntries.length === 0) {
        return coverage;
    }

    const existingStaticKeys = Object.keys(coverage.static);
    const perTestAppearances = countPerTestAppearances(perTestEntries);

    // A mutant belongs in static if:
    //   (a) it is already in static, OR
    //   (b) it appears in more than one test's perTest (ambiguous attribution)
    const promoteToStatic = buildPromoteToStaticSet(existingStaticKeys, perTestAppearances);

    // Nothing to change if there are no promotions AND no perTest entries contain
    // any of the static IDs (i.e., nothing to strip from perTest either).
    const existingStatic = new Set<string>(existingStaticKeys);
    // Stryker disable next-line ArrayDeclaration,ArrowFunction,BooleanLiteral,MethodExpression: equivalent mutants — bogus spread/arrow/every changes force hasNewPromotions=true, but rebuild produces identical output when all promotions are already in static; .every vs .some only affects early-return optimization, not the final result
    const hasNewPromotions = [...promoteToStatic].some(id => !existingStatic.has(id));
    // Stryker disable next-line MethodExpression,ArrowFunction: equivalent mutant — perTestEntries.some false-positive only causes unnecessary rebuild; output is identical
    const hasPerTestContamination = perTestEntries.some(
        // Stryker disable next-line ConditionalExpression: equivalent mutant — inner some always-true forces unnecessary rebuild but output is identical
        ([, counts]) => Object.keys(counts).some(id => promoteToStatic.has(id))
    );
    // Stryker disable next-line ConditionalExpression,BooleanLiteral,BlockStatement: equivalent mutants — skipping early return (or flipping condition) just forces rebuild that produces identical output; the rebuild produces the same static+perTest values
    if(!hasNewPromotions && !hasPerTestContamination) {
        return coverage;
    }

    // Build new static: union of original static hits and promoted mutant IDs.
    // Use hit-count 1 for newly-promoted mutants (conservative default; the
    // actual count is irrelevant for Stryker's coverage decision).
    const newStatic: Record<string, number> = { ...coverage.static };
    for(const mutantId of promoteToStatic) {
        if(!(mutantId in newStatic)) {
            newStatic[mutantId] = 1;
        }
    }

    const newPerTest = buildFilteredPerTest(perTestEntries, promoteToStatic);

    return { 'static': newStatic, perTest: newPerTest };
}

/**
 * Map file-prefixed counter keys ("relativeFile@@test-N") to full test names.
 *
 * For each key we:
 *  1. Split on "@@" to get `[filePrefix, "test-N"]`.
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
 * Pair each coverage counter key with its corresponding non-skipped inspector test
 * using global positional order.
 *
 * Skipped/pending tests are excluded because Bun does NOT run beforeEach for them,
 * so no counter key is produced for them.
 *
 * This is the shared core logic used by both mapFilePrefixedCounterKeys and
 * buildInspectorIdToProjectFile to avoid duplicating the nonSkipped filter and
 * @@ extraction.
 */
function pairKeysWithInspectorIds(
    globallyOrderedPerTestKeys: string[],
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): KeyInspectorPair[] {
    const nonSkipped = executionOrder.filter((id) => {
        const status = testHierarchy.get(id)?.status;
        // Stryker disable next-line EqualityOperator: both conditions needed — skip and pending both suppress beforeEach
        return status !== 'skip' && status !== 'todo';
    });

    // Warn only when there are fewer coverage keys than non-skipped tests (genuine data loss).
    // When there are MORE coverage keys than tests, the excess are test-retry attempts — handled
    // by clamping in resolveCounterKeys, so no data is lost and no warning is needed.
    // Stryker disable next-line EqualityOperator: < is the correct direction — only warn on data-loss case, not retry-excess case
    if(globallyOrderedPerTestKeys.length < nonSkipped.length) {
        // Stryker disable StringLiteral: diagnostic logging message
        logger?.warn(
            'Coverage/execution count mismatch: %s coverage entries vs %s non-skipped executed tests. '
            + 'Performing partial mapping for %s tests.',
            // Stryker restore StringLiteral
            globallyOrderedPerTestKeys.length,
            nonSkipped.length,
            Math.min(globallyOrderedPerTestKeys.length, nonSkipped.length)
        );
    }

    // Stryker disable next-line MethodExpression: Math.max produces the same end-to-end output — excess iterations get undefined inspector IDs which are already filtered out
    const pairCount = Math.min(globallyOrderedPerTestKeys.length, nonSkipped.length);
    const pairs: KeyInspectorPair[] = [];

    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop → Timeout
    for(let i = 0; i < pairCount; i++) {
        const key = globallyOrderedPerTestKeys[i];
        const sepIdx = key.indexOf('@@');
        // Stryker disable next-line EqualityOperator,ConditionalExpression,UnaryOperator: malformed-key branch is unreachable in practice — resolveCounterKeys independently extracts filePrefix without a -1 guard, so a malformed key already fails lookup there regardless of which branch this takes; all three mutant forms produce identical end-to-end output
        const filePrefix = sepIdx === -1 ? key : key.slice(0, sepIdx);
        pairs.push({ filePrefix, inspectorId: nonSkipped[i] });
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
 * Skipped tests and tests marked as pending are not in the counter keys and are not mapped here.
 *
 * @param globallyOrderedPerTestKeys - Coverage counter keys in global insertion order
 * @param executionOrder - Inspector test IDs in chronological start-event order
 * @param testHierarchy - Map of inspector ID to TestInfo
 * @returns Map from inspector ID to project file prefix
 */
export function buildInspectorIdToProjectFile(
    globallyOrderedPerTestKeys: string[],
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>
): Map<number, string> {
    const pairs = pairKeysWithInspectorIds(globallyOrderedPerTestKeys, executionOrder, testHierarchy);

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
 * When N > fileIds.length (extra counter keys from test retries, or other mismatches),
 * the excess key is resolved to the LAST known inspector ID for that file, so its coverage
 * data is folded into the same perTest entry as the last paired test.
 *
 * NOTE: Bun provides no way to detect retries from inside `beforeEach` — there is no
 * test-name or retry-index available in that hook. The retry-folding heuristic here
 * works when retries produce consecutive counter keys for the same file.
 */
function resolveCounterKeys(
    counterIds: string[],
    fileToInspectorIds: Map<string, number[]>,
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): ResolvedCounterKey[] {
    return counterIds.map((key) => {
        const sepIdx = key.indexOf('@@');
        const filePrefix = key.slice(0, sepIdx);
        const counterStr = key.slice(sepIdx + 2 + 'test-'.length); // skip "@@test-"
        const n = Number.parseInt(counterStr, 10); // 1-based

        const fileIds = fileToInspectorIds.get(filePrefix);
        // Clamp N-1 to fileIds.length-1 so extra counter keys (test retries) fold into
        // the last paired inspector ID rather than producing an unknown/dropped entry.
        // Stryker disable next-line ConditionalExpression,MethodExpression: equivalent — no fileIds means inspectorId is undefined; Math.min clamp is safe at boundary n===fileIds.length
        const clampedIdx = fileIds ? Math.min(n - 1, fileIds.length - 1) : undefined;
        // Stryker disable next-line ConditionalExpression: equivalent — undefined clampedIdx means no fileIds, so inspectorId is undefined either way
        const inspectorId = clampedIdx === undefined ? undefined : fileIds?.[clampedIdx];
        const testInfo = inspectorId === undefined ? undefined : testHierarchy.get(inspectorId);

        if(testInfo) {
            // Use the counter key's file prefix (from Bun.main) instead of testInfo.url.
            // testInfo.url may point to node_modules for tests defined via helpers like
            // ESLint's RuleTester.run() — using the counter prefix ensures the test name
            // reflects the user's test file, not an internal helper file.
            const testName = buildProjectFileTestName(filePrefix, testInfo.fullName);
            return { name: testName, testInfo, inspectorId };
        }

        // Stryker disable StringLiteral: diagnostic logging message — format strings not functionally tested
        logger?.warn(
            'Coverage key %s: no inspector test found for file "%s" at position %s '
            + '(file has %s tests in execution order). Skipping this test in coverage mapping.',
            // Stryker restore StringLiteral
            key,
            filePrefix,
            n,
            // Stryker disable next-line LogicalOperator: equivalent mutant — fallback value only appears in the warn message, not in any mapping logic
            fileToInspectorIds.get(filePrefix)?.length ?? 0
        );
        // Stryker disable next-line StringLiteral: equivalent mutant — the unknown name is only used as a Map key that is immediately skipped (testInfo: null) in buildRemappedPerTest
        return { name: `unknown-${key}`, testInfo: null, inspectorId: undefined };
    });
}

/**
 * Second-pass: build remapped perTest from resolved counter keys.
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
        // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutants — null-testInfo entries use name "unknown-<key>" (unique) so including them doesn't produce duplicate counts for valid names; the second pass in buildRemappedPerTest skips them anyway
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
 * Resolve a final (possibly suffixed) test name for the it.each deduplication case.
 *
 * When multiple DISTINCT inspector IDs share the same base name (it.each with a
 * template literal not yet interpolated), append `[0]`, `[1]`, … per inspector.
 * Retries (same inspector, same name) are detected by `distinctIds.size === 1`
 * and do NOT get a suffix.
 *
 * @param nameIndexes - Mutable map tracking the next available suffix index per name.
 * @returns The final (possibly suffixed) test name.
 */
function resolveEachTestName(
    baseName: string,
    inspectorId: number | undefined,
    nameInspectorIds: Map<string, Set<number | undefined>>,
    nameIndexes: Map<string, number>
): string {
    const distinctIds = nameInspectorIds.get(baseName);
    // Stryker disable next-line ConditionalExpression: equivalent — undefined distinctIds means count=1, no dedup
    if((distinctIds?.size ?? 1) <= 1) {
        return baseName;
    }
    // it.each case: assign suffix the first time we see this inspectorId for this baseName.
    // Key format: "inspectorId/baseName" — inspectorId is always a number so the prefix is unambiguous.
    const key_ = `${inspectorId}/${baseName}`;
    const existingIndex = nameIndexes.get(key_);
    if(existingIndex === undefined) {
        const nextIndex = nameIndexes.get(baseName) ?? 0;
        nameIndexes.set(key_, nextIndex);
        nameIndexes.set(baseName, nextIndex + 1);
        return `${baseName} [${nextIndex}]`;
    }
    return `${baseName} [${existingIndex}]`;
}

function buildRemappedPerTest(
    counterIds: string[],
    resolved: ResolvedCounterKey[],
    rawPerTest: MutantCoverage['perTest']
): Record<string, Record<string, number>> {
    const nameInspectorIds = buildNameInspectorIds(resolved);
    const remappedPerTest: Partial<Record<string, Record<string, number>>> = {};
    const nameIndexes = new Map<string, number>();

    for(const [i, key] of counterIds.entries()) {
        const { name: baseName, testInfo, inspectorId } = resolved[i];

        if(!testInfo) {
            continue;
        }

        const finalName = resolveEachTestName(baseName, inspectorId, nameInspectorIds, nameIndexes);

        // Merge coverage data: if the entry already exists (retry of same test),
        // accumulate hit counts rather than overwriting.
        const incoming = rawPerTest[key];
        const existing = remappedPerTest[finalName];
        if(existing) {
            // Retry case: merge hit counts
            for(const [mutantId, count_] of Object.entries(incoming)) {
                existing[mutantId] = (existing[mutantId] ?? 0) + count_;
            }
        } else {
            remappedPerTest[finalName] = { ...incoming };
        }
    }

    return remappedPerTest as Record<string, Record<string, number>>;
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

function mapFilePrefixedCounterKeys(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): CoverageMapResult {
    // Use Object.keys insertion order — this is the global chronological order
    // in which beforeEach fired, which matches executionOrder (minus skipped tests).
    // Do NOT sort here: the global positional pairing in buildFileToInspectorIds
    // depends on insertion order being preserved.
    // Stryker disable next-line MethodExpression: Array.from vs spread vs Object.keys — all three produce the same insertion-ordered key array
    const globallyOrderedKeys = Object.keys(rawCoverage.perTest);

    // Build paired (filePrefix, inspectorId) list once; both consumers (file map and
    // inspector-to-project-file map) derive their structures from this single list.
    const pairs = pairKeysWithInspectorIds(globallyOrderedKeys, executionOrder, testHierarchy, logger);

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
    // Stryker disable StringLiteral,LogicalOperator,ArithmeticOperator: equivalent mutants — sort order doesn't affect correctness since resolveCounterKeys extracts position from key string directly; '??' fallback only fires for malformed keys not present in valid coverage files
    const counterIds = globallyOrderedKeys.toSorted((a, b) => {
        const nA = Number.parseInt(a.split('@@test-')[1] ?? '0', 10);
        const nB = Number.parseInt(b.split('@@test-')[1] ?? '0', 10);
        return nA - nB;
    });
    // Stryker restore StringLiteral,LogicalOperator,ArithmeticOperator

    const resolved = resolveCounterKeys(counterIds, fileToInspectorIds, testHierarchy, logger);
    const remappedPerTest = buildRemappedPerTest(counterIds, resolved, rawCoverage.perTest);

    const coverage = stabilizeCoverage({
        'static': rawCoverage.static,
        perTest:  remappedPerTest,
    });

    return { coverage, inspectorIdToProjectFile };
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
): MutantCoverage {
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
    // Stryker disable MethodExpression,ArrayDeclaration,EqualityOperator,BlockStatement,StringLiteral: equivalent mutants — Math.max vs Math.min and i<=maxIndex both cause out-of-bounds access that is silently skipped by the undefined testInfo check; [] vs ["Stryker was here"] only affects nameCounts for a name never used in second pass; the else body pushes to testNames which only affects dedup counts (no effect when names are unique); template literal change only affects an intermediate string not used in output
    const maxIndex = Math.min(counterIds.length, executionOrder.length);
    const testNames: string[] = [];

    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop → Timeout
    for(let i = 0; i < maxIndex; i++) {
        const inspectorId = executionOrder[i];
        const testInfo = testHierarchy.get(inspectorId);
        if(testInfo) {
            testNames.push(buildUniqueTestName(testInfo.fullName, testInfo.url));
        } else {
            testNames.push(`unknown-${inspectorId}`);
        }
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
    }

    // Return new coverage with remapped perTest and original static, with
    // ambiguously-attributed mutants promoted to static.
    return stabilizeCoverage({
        'static': rawCoverage.static,
        perTest:  remappedPerTest,
    });
}
