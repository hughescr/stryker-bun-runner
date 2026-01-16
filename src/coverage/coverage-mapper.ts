/**
 * Coverage mapping utilities
 * Maps counter-based coverage IDs to inspector test IDs with full names
 */

import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { TestInfo } from '../inspector/types.js';

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

    // Map counter IDs to inspector full names
    const remappedPerTest: Record<string, Record<string, number>> = {};
    const maxIndex = Math.min(counterIds.length, executionOrder.length);

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

        // Use fullName from TestInfo as the new key
        remappedPerTest[testInfo.fullName] = rawCoverage.perTest[counterId];
    }

    // Return new coverage with remapped perTest and original static
    return {
        'static': rawCoverage.static,
        perTest:  remappedPerTest,
    };
}
