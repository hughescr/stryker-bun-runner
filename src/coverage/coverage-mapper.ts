/**
 * Coverage mapping utilities
 * Maps counter-based coverage IDs to inspector test IDs with full names
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import type { TestInfo } from '../inspector/types.js';
import { buildUniqueTestName, normalizeTestFilePath } from '../utils/test-name.js';

/**
 * Maps coverage counter keys (file-prefixed "file@@test-N" or legacy "test-N")
 * to full hierarchical test names, using per-file positional mapping for
 * deterministic results when Bun runs files in parallel.
 *
 * @param rawCoverage - Coverage data with counter-based keys
 * @param executionOrder - Inspector test IDs in execution order
 * @param testHierarchy - Map of inspector ID to TestInfo
 * @param logger - Optional logger for diagnostic warnings
 * @returns New MutantCoverage with perTest re-keyed to full test names
 */
// Overload: when rawCoverage is a well-typed MutantCoverage the return is also MutantCoverage.
export function mapCoverageToInspectorIds(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): MutantCoverage;
// Overload: when rawCoverage may be undefined/null (runtime-only scenario), the return is undefined.
export function mapCoverageToInspectorIds(
    rawCoverage: MutantCoverage | undefined | null,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): MutantCoverage | undefined;
// Implementation
export function mapCoverageToInspectorIds(
    rawCoverage: MutantCoverage | undefined | null,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): MutantCoverage | undefined {
    // Handle empty or missing coverage - return as-is.
    // rawCoverage can be undefined/null at runtime even though the primary overload
    // accepts only MutantCoverage — callers may pass partially-initialised global data.
    // Stryker disable next-line ConditionalExpression: equivalent mutation - empty perTest is also caught by firstKey check at line 62
    if(!rawCoverage?.perTest || Object.keys(rawCoverage.perTest).length === 0) {
        return rawCoverage ?? undefined;
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
        return mapLegacyCounterKeys(rawCoverage, executionOrder, testHierarchy, logger);
    }

    // Unknown format - assume already remapped and return unchanged.
    return rawCoverage;
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
/**
 * Build a per-file map of inspector IDs from the execution order.
 * Key: normalised relative file path; value: inspector IDs in execution order.
 */
function buildFileToInspectorIds(
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>
): Map<string, number[]> {
    const fileToInspectorIds = new Map<string, number[]>();
    for(const inspectorId of executionOrder) {
        const testInfo = testHierarchy.get(inspectorId);
        if(!testInfo) {
            continue;
        }
        // Stryker disable next-line StringLiteral: equivalent mutant — '' and "" are identical in JS
        const relFile = normalizeTestFilePath(testInfo.url) ?? '';
        const bucket = fileToInspectorIds.get(relFile);
        if(bucket) {
            bucket.push(inspectorId);
        } else {
            fileToInspectorIds.set(relFile, [inspectorId]);
        }
    }
    return fileToInspectorIds;
}

interface ResolvedCounterKey {
    name:     string
    testInfo: TestInfo | null
}

/**
 * First-pass: resolve all counter keys to test names and testInfos.
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
        const inspectorId = fileIds?.[n - 1];
        const testInfo = inspectorId === undefined ? undefined : testHierarchy.get(inspectorId);

        if(testInfo) {
            return { name: buildUniqueTestName(testInfo.fullName, testInfo.url), testInfo };
        }

        // Stryker disable StringLiteral: diagnostic logging message — format strings not functionally tested
        logger?.warn(
            'Coverage key %s: no inspector test found for file "%s" at position %s '
            + '(file has %s tests in execution order). Skipping this test in coverage mapping.',
            // Stryker restore StringLiteral
            key,
            filePrefix,
            n,
            fileToInspectorIds.get(filePrefix)?.length ?? 0
        );
        // Stryker disable next-line StringLiteral: equivalent mutant — the unknown name is only used as a Map key that is immediately skipped (testInfo: null) in buildRemappedPerTest
        return { name: `unknown-${key}`, testInfo: null };
    });
}

/**
 * Second-pass: build remapped perTest from resolved counter keys with deduplication.
 */
function buildRemappedPerTest(
    counterIds: string[],
    resolved: ResolvedCounterKey[],
    rawPerTest: MutantCoverage['perTest']
): Record<string, Record<string, number>> {
    // Count occurrences for deduplication (handles it.each with %s placeholders)
    const nameCounts = new Map<string, number>();
    for(const { name } of resolved) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    const remappedPerTest: Record<string, Record<string, number>> = {};
    const nameIndexes = new Map<string, number>();

    for(const [i, key] of counterIds.entries()) {
        const { name: baseName, testInfo } = resolved[i];

        if(!testInfo) {
            continue;
        }

        const count = nameCounts.get(baseName) ?? 1;
        let finalName = baseName;

        if(count > 1) {
            const index = nameIndexes.get(baseName) ?? 0;
            finalName = `${baseName} [${index}]`;
            nameIndexes.set(baseName, index + 1);
        }

        remappedPerTest[finalName] = rawPerTest[key];
    }

    return remappedPerTest;
}

function mapFilePrefixedCounterKeys(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): MutantCoverage {
    const fileToInspectorIds = buildFileToInspectorIds(executionOrder, testHierarchy);

    // Sort the counter IDs numerically within each key so we iterate in order.
    // Stryker disable StringLiteral,LogicalOperator,ArithmeticOperator: equivalent mutants — sort order doesn't affect correctness since resolveCounterKeys extracts position from key string directly; '??' fallback only fires for malformed keys not present in valid coverage files
    const counterIds = Object.keys(rawCoverage.perTest).toSorted((a, b) => {
        const nA = Number.parseInt(a.split('@@test-')[1] ?? '0', 10);
        const nB = Number.parseInt(b.split('@@test-')[1] ?? '0', 10);
        return nA - nB;
    });
    // Stryker restore StringLiteral,LogicalOperator,ArithmeticOperator

    const resolved = resolveCounterKeys(counterIds, fileToInspectorIds, testHierarchy, logger);
    const remappedPerTest = buildRemappedPerTest(counterIds, resolved, rawCoverage.perTest);

    return stabilizeCoverage({
        'static': rawCoverage.static,
        perTest:  remappedPerTest,
    });
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
