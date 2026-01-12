/**
 * Reader for bunfig.toml configuration
 * Detects JUnit reporter configuration for Stryker incremental mode support
 */

import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

export interface BunfigTestReporter {
  junit?: string;  // Path to JUnit output file
}

export interface BunfigConfig {
  test?: {
    reporter?: BunfigTestReporter;
  };
}

/**
 * Read and parse bunfig.toml from the given directory
 * @param cwd - Directory containing bunfig.toml
 * @returns Parsed config or undefined if file doesn't exist or is invalid
 */
export async function readBunfig(cwd: string): Promise<BunfigConfig | undefined> {
  const bunfigPath = join(cwd, 'bunfig.toml');

  // Check if file exists
  if (!existsSync(bunfigPath)) {
    return undefined;
  }

  try {
    // Read file content
    const content = await Bun.file(bunfigPath).text();

    // Parse TOML using Bun's built-in parser
    const parsed = Bun.TOML.parse(content);

    // Return parsed config (TypeScript will infer the structure)
    return parsed as BunfigConfig;
  } catch {
    // Handle parse errors gracefully
    return undefined;
  }
}

/**
 * Extract JUnit output path from bunfig config
 * @param bunfig - Parsed bunfig config
 * @param cwd - Current working directory for resolving relative paths
 * @returns Absolute path to JUnit output file, or undefined if not configured
 */
export function getJunitOutputPath(bunfig: BunfigConfig | undefined, cwd: string): string | undefined {
  // Check if config and junit path exist
  const junitPath = bunfig?.test?.reporter?.junit;
  if (!junitPath) {
    return undefined;
  }

  // If path is already absolute, return as-is
  if (isAbsolute(junitPath)) {
    return junitPath;
  }

  // Resolve relative path relative to cwd
  return resolve(cwd, junitPath);
}
