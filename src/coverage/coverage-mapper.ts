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
export function mapCoverageToInspectorIds(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): MutantCoverage {
    // Handle empty coverage - return as-is
    // Stryker disable next-line ConditionalExpression: equivalent mutation - empty perTest is also caught by firstKey check at line 62
    if(!rawCoverage?.perTest || Object.keys(rawCoverage.perTest).length === 0) {
        return rawCoverage;
    }

    const firstKey = Object.keys(rawCoverage.perTest)[0];

    // New format: "relativeFile@@test-N" (file-prefixed counter keys).
    // Use per-file positional mapping to eliminate cross-file counter collisions.
    // Stryker disable next-line Regex: anchors are defensive for pattern matching file-prefixed keys
    if(/@@test-\d+$/.exec(firstKey)) {
        return mapFilePrefixedCounterKeys(rawCoverage, executionOrder, testHierarchy, logger);
    }

    // Legacy format: "test-N" (global counter keys, no file prefix).
    // Fall back to global positional mapping via executionOrder.
    // Stryker disable next-line Regex: anchors are defensive for pattern matching counter-based keys
    if(/^test-\d+$/.exec(firstKey)) {
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
function stabilizeCoverage(coverage: MutantCoverage): MutantCoverage {
    const perTestEntries = Object.entries(coverage.perTest ?? {});
    if(perTestEntries.length === 0) {
        return coverage;
    }

    // Count how many perTest entries each mutant ID appears in.
    const perTestAppearances = new Map<string, number>();
    for(const [, counts] of perTestEntries) {
        for(const mutantId of Object.keys(counts)) {
            perTestAppearances.set(mutantId, (perTestAppearances.get(mutantId) ?? 0) + 1);
        }
    }

    // A mutant belongs in static if:
    //   (a) it is already in static, OR
    //   (b) it appears in more than one test's perTest (ambiguous attribution)
    const promoteToStatic = new Set<string>(Object.keys(coverage.static ?? {}));
    for(const [mutantId, count] of perTestAppearances) {
        // Stryker disable next-line EqualityOperator: > 1 is the correct threshold — 1 means uniquely attributed
        if(count > 1) {
            promoteToStatic.add(mutantId);
        }
    }

    // Nothing to change if there are no promotions AND no perTest entries contain
    // any of the static IDs (i.e., nothing to strip from perTest either).
    const existingStatic = new Set<string>(Object.keys(coverage.static ?? {}));
    const hasNewPromotions = [...promoteToStatic].some(id => !existingStatic.has(id));
    const hasPerTestContamination = perTestEntries.some(
        ([, counts]) => Object.keys(counts).some(id => promoteToStatic.has(id))
    );
    if(!hasNewPromotions && !hasPerTestContamination) {
        return coverage;
    }

    // Build new static: union of original static hits and promoted mutant IDs.
    // Use hit-count 1 for newly-promoted mutants (conservative default; the
    // actual count is irrelevant for Stryker's coverage decision).
    const newStatic: Record<string, number> = { ...(coverage.static ?? {}) };
    for(const mutantId of promoteToStatic) {
        if(!(mutantId in newStatic)) {
            newStatic[mutantId] = 1;
        }
    }

    // Build new perTest: strip any mutant ID that is now in static.
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
function mapFilePrefixedCounterKeys(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>,
    logger?: Pick<Logger, 'warn'>
): MutantCoverage {
    // Pre-build a per-file ordered list of inspector IDs to avoid repeated filtering.
    // Key: normalised relative file path; value: inspector IDs in execution order.
    const fileToInspectorIds = new Map<string, number[]>();
    for(const inspectorId of executionOrder) {
        const testInfo = testHierarchy.get(inspectorId);
        if(!testInfo) {
            continue;
        }
        const relFile = normalizeTestFilePath(testInfo.url) ?? '';
        const bucket = fileToInspectorIds.get(relFile);
        if(bucket) {
            bucket.push(inspectorId);
        } else {
            fileToInspectorIds.set(relFile, [inspectorId]);
        }
    }

    // Sort the counter IDs numerically within each key so we iterate in order.
    const counterIds = Object.keys(rawCoverage.perTest).sort((a, b) => {
        const nA = parseInt(a.split('@@test-')[1] ?? '0', 10);
        const nB = parseInt(b.split('@@test-')[1] ?? '0', 10);
        return nA - nB;
    });

    // First pass: resolve test names for all keys to build the deduplication map.
    const testNames: string[] = [];
    const resolvedInfos: (TestInfo | null)[] = [];

    for(const key of counterIds) {
        const sepIdx = key.indexOf('@@');
        const filePrefix = key.slice(0, sepIdx);
        const counterStr = key.slice(sepIdx + 2 + 'test-'.length); // skip "@@test-"
        const n = parseInt(counterStr, 10); // 1-based

        const fileIds = fileToInspectorIds.get(filePrefix);
        const inspectorId = fileIds?.[n - 1];
        const testInfo = inspectorId !== undefined ? testHierarchy.get(inspectorId) : undefined;

        if(testInfo) {
            testNames.push(buildUniqueTestName(testInfo.fullName, testInfo.url));
            resolvedInfos.push(testInfo);
        } else {
            // Stryker disable next-line all: Logging statement
            logger?.warn(
                'Coverage key %s: no inspector test found for file "%s" at position %s '
                + '(file has %s tests in execution order). Skipping this test in coverage mapping.',
                key,
                filePrefix,
                n,
                fileToInspectorIds.get(filePrefix)?.length ?? 0
            );
            testNames.push(`unknown-${key}`);
            resolvedInfos.push(null);
        }
    }

    // Count occurrences for deduplication (handles it.each with %s placeholders)
    const nameCounts = new Map<string, number>();
    for(const name of testNames) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    // Second pass: build remappedPerTest with deduplicated names
    const remappedPerTest: Record<string, Record<string, number>> = {};
    const nameIndexes = new Map<string, number>();

    for(let i = 0; i < counterIds.length; i++) {
        const key = counterIds[i];
        const testInfo = resolvedInfos[i];

        if(!testInfo) {
            continue;
        }

        const baseName = testNames[i];
        const count = nameCounts.get(baseName) ?? 1;
        let finalName = baseName;

        if(count > 1) {
            const index = nameIndexes.get(baseName) ?? 0;
            finalName = `${baseName} [${index}]`;
            nameIndexes.set(baseName, index + 1);
        }

        remappedPerTest[finalName] = rawCoverage.perTest[key];
    }

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
    const counterIds = Object.keys(rawCoverage.perTest).sort(
        (a, b) => parseInt(a.split('-')[1], 10) - parseInt(b.split('-')[1], 10)
    );

    // Handle count mismatch - log warning and do partial mapping
    if(counterIds.length !== executionOrder.length) {
        // Stryker disable next-line all: Logging statement
        logger?.warn(
            'Coverage/execution count mismatch: %s coverage entries vs %s executed tests. '
            + 'Performing partial mapping for %s tests.',
            counterIds.length,
            executionOrder.length,
            Math.min(counterIds.length, executionOrder.length)
        );
    }

    // First pass: build unique names and count occurrences (same logic as buildTestsFromInspector)
    const maxIndex = Math.min(counterIds.length, executionOrder.length);
    const testNames: string[] = [];

    for(let i = 0; i < maxIndex; i++) {
        const inspectorId = executionOrder[i];
        const testInfo = testHierarchy.get(inspectorId);
        if(testInfo) {
            testNames.push(buildUniqueTestName(testInfo.fullName, testInfo.url));
        } else {
            testNames.push(`unknown-${inspectorId}`);
        }
    }

    // Count occurrences for deduplication (handles it.each with %s placeholders)
    const nameCounts = new Map<string, number>();
    for(const name of testNames) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    // Second pass: map coverage with deduplicated names
    const remappedPerTest: Record<string, Record<string, number>> = {};
    const nameIndexes = new Map<string, number>();

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
