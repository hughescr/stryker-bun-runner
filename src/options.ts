/**
 * Type definitions for plugin options
 */

import { StrykerOptions } from '@stryker-mutator/api/core';

/**
 * Configuration options specific to the Bun test runner
 */
export interface BunTestRunnerOptions {
  /**
   * Custom path to the bun binary
   * @default 'bun'
   */
  bunPath?: string;

  /**
   * Timeout per test in milliseconds
   * @default 10000
   */
  timeout?: number;

  /**
   * Timeout for inspector connection in ms
   * @default 5000
   */
  inspectorTimeout?: number;

  /**
   * Additional environment variables to pass to bun test
   */
  env?: Record<string, string>;

  /**
   * Additional bun test flags to pass
   * @example ['--bail', '--only']
   */
  bunArgs?: string[];
}

/**
 * Extended Stryker options with Bun-specific configuration
 */
export interface StrykerBunOptions extends StrykerOptions {
  /**
   * Bun test runner specific configuration
   */
  bun?: BunTestRunnerOptions;
}
