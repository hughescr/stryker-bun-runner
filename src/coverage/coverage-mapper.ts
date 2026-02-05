/**
 * Coverage mapping utilities
 * Maps counter-based coverage IDs to inspector test IDs with full names
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { TestInfo } from '../inspector/types.js';
import { buildUniqueTestName } from '../bun-test-runner.js';

/**
 * Maps coverage data from counter-based test IDs (test-1, test-2, ...) to inspector test IDs
 * with full hierarchical names.
 *
 * The coverage collection system uses counter-based IDs (test-1, test-2) in execution order.
 * This function maps those IDs to stable inspector test IDs using the full test name hierarchy
 * (e.g., "Suite > Nested > Test name") which enables Stryker's incremental mode.
 *
 * @param rawCoverage - Coverage data with counter-based test IDs (test-1, test-2, ...)
 * @param executionOrder - Array of inspector test IDs in execution order
 * @param testHierarchy - Map of inspector test ID to TestInfo with full names
 * @returns New MutantCoverage with re-keyed perTest using inspector fullName, same static coverage
 *
 * @example
 * ```typescript
 * const rawCoverage = {
 *   static: { '1': 1 },
 *   perTest: {
 *     'test-1': { '2': 1, '3': 1 },
 *     'test-2': { '4': 1 }
 *   }
 * };
 * const executionOrder = [42, 43]; // Inspector IDs in execution order
 * const testHierarchy = new Map([
 *   [42, { id: 42, name: 'test1', fullName: 'Suite > test1', type: 'test' }],
 *   [43, { id: 43, name: 'test2', fullName: 'Suite > test2', type: 'test' }]
 * ]);
 *
 * const mapped = mapCoverageToInspectorIds(rawCoverage, executionOrder, testHierarchy);
 * // Returns:
 * // {
 * //   static: { '1': 1 },
 * //   perTest: {
 * //     'Suite > test1': { '2': 1, '3': 1 },
 * //     'Suite > test2': { '4': 1 }
 * //   }
 * // }
 * ```
 */
export function mapCoverageToInspectorIds(
    rawCoverage: MutantCoverage,
    executionOrder: number[],
    testHierarchy: Map<number, TestInfo>
): MutantCoverage {
    // Handle empty coverage - return as-is
    // Stryker disable next-line ConditionalExpression: equivalent mutation - empty perTest is also caught by firstKey check at line 62
    if(!rawCoverage?.perTest || Object.keys(rawCoverage.perTest).length === 0) {
        return rawCoverage;
    }

    // Check if coverage keys are counter-based (test-1, test-2, ...)
    // If not, assume they're already in the correct format and return unchanged
    const firstKey = Object.keys(rawCoverage.perTest)[0];
    // Stryker disable next-line Regex: anchors are defensive for pattern matching counter-based keys
    if(!/^test-\d+$/.exec(firstKey)) {
        return rawCoverage;
    }

    // Extract and sort counter-based test IDs numerically (test-1, test-2, ...)
    const counterIds = Object.keys(rawCoverage.perTest).sort(
        (a, b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1])
    );

    // Handle count mismatch - log warning and do partial mapping
    if(counterIds.length !== executionOrder.length) {
        // Stryker disable next-line all: Logging statement
        // eslint-disable-next-line no-console -- intentional warning for debug purposes
        console.warn(
            `Coverage/execution count mismatch: ${counterIds.length} coverage entries vs ${executionOrder.length} executed tests. `
            + `Performing partial mapping for ${Math.min(counterIds.length, executionOrder.length)} tests.`
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
            // eslint-disable-next-line no-console -- intentional warning for debug purposes
            console.warn(
                `Missing test info for inspector ID ${inspectorId} (counter ID: ${counterId}). Skipping this test in coverage mapping.`
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

    // Return new coverage with remapped perTest and original static
    return {
        'static': rawCoverage.static,
        perTest:  remappedPerTest,
    };
}
