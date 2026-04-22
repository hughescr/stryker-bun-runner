/**
 * Testable logic extracted from coverage-preload.ts
 *
 * This file contains pure functions that can be tested independently
 * of the runtime environment. The actual preload script imports and
 * uses these functions.
 */

import { appendFileSync } from 'node:fs';
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { CoverageFileData } from './types.js';

export interface StrykerNamespace {
    mutantCoverage?: MutantCoverage
    currentTestId?:  string
    activeMutant?:   string
}

// ============================================================================
// Configuration
// ============================================================================

export interface PreloadConfig {
    syncPort?:     string
    coverageFile?: string
    activeMutant?: string
}

export function getPreloadConfig(): PreloadConfig {
    return {
        syncPort:     process.env.__STRYKER_SYNC_PORT__,
        coverageFile: process.env.__STRYKER_COVERAGE_FILE__,
        activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__,
    };
}

export function shouldCollectCoverage(config: PreloadConfig): boolean {
    return !config.activeMutant && !!config.coverageFile;
}

// ============================================================================
// Stryker Namespace Initialization
// ============================================================================

export function initializeStrykerNamespace(globalObj: Record<string, unknown>): StrykerNamespace {
    const g = globalObj as { __stryker__?: StrykerNamespace, __mutantCoverage__?: MutantCoverage };
    // Stryker disable next-line ObjectLiteral: structure verified by tests; line 61 fallback is only for existing __stryker__ without coverage
    g.__stryker__ ??= { mutantCoverage: { 'static': {}, perTest: {} } };
    const strykerGlobal = g.__stryker__;
    strykerGlobal.mutantCoverage ??= { 'static': {}, perTest: {} };
    g.__mutantCoverage__ = strykerGlobal.mutantCoverage;
    return strykerGlobal;
}

export function setActiveMutant(strykerNamespace: StrykerNamespace, activeMutant: string): void {
    strykerNamespace.activeMutant = activeMutant;
}

// ============================================================================
// Coverage Data Formatting
// ============================================================================

export function formatCoverageData(
    mutantCoverage: MutantCoverage | undefined,
    counterToName: Map<string, string>
): CoverageFileData {
    if(!mutantCoverage) {
        return { perTest: {}, 'static': [] };
    }

    const perTest: Record<string, string[]> = {};
    for(const [testId, coverage] of Object.entries(mutantCoverage.perTest ?? {})) {
        const actualName = counterToName.get(testId) ?? testId;
        perTest[actualName] = Object.keys(coverage);
    }

    const staticCoverage = Object.keys(mutantCoverage.static ?? {});

    return {
        perTest,
        'static': staticCoverage,
    };
}

// ============================================================================
// File Writing
// ============================================================================

export function writeCoverageToFile(coverageFile: string, data: CoverageFileData): void {
    // eslint-disable-next-line n/no-sync -- sync required in afterAll hook to ensure write completes before process exit
    appendFileSync(coverageFile, JSON.stringify(data) + '\n', 'utf-8');
}

