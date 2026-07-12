/**
 * Coverage module
 * Exports coverage collection and management functionality
 */

export type { PerTestCoverageData, LateHitEntry, CoverageFileData } from './types.js';
export { type PreloadOptions, resolveEagerModulesFromGlobs, generatePreloadScript, cleanupPreloadScript } from './preload-generator.js';
export { collectCoverage, collectLateHits, cleanupCoverageFile } from './collector.js';
export { type CoverageMapResult, mapCoverageToInspectorIds, buildInspectorIdToProjectFile } from './coverage-mapper.js';
