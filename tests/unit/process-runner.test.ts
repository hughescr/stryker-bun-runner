/**
 * Unit tests for process-runner
 * Tests the Bun process spawning and management utilities
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { runBunTests } from '../../src/process-runner.js';
import type { ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';

describe('runBunTests', () => {
  let mockSpawn: ReturnType<typeof mock>;
  let mockChildProcess: Partial<ChildProcess>;

  beforeEach(() => {
    // Create a mock child process
    mockChildProcess = {
      stdout: {
        on: mock((event: string, handler: (data: Buffer) => void) => {
          // Store handler for later invocation
          if (event === 'data') {
            (mockChildProcess as any).stdoutHandler = handler;
          }
        }),
      } as any,
      stderr: {
        on: mock((event: string, handler: (data: Buffer) => void) => {
          // Store handler for later invocation
          if (event === 'data') {
            (mockChildProcess as any).stderrHandler = handler;
          }
        }),
      } as any,
      on: mock((event: string, handler: (code?: number | null) => void) => {
        // Store handlers for later invocation
        if (event === 'close') {
          (mockChildProcess as any).closeHandler = handler;
        } else if (event === 'error') {
          (mockChildProcess as any).errorHandler = handler;
        }
        return mockChildProcess as ChildProcess;
      }),
      kill: mock(() => true),
    };

    // Mock spawn to return our mock child process
    mockSpawn = mock(() => mockChildProcess as ChildProcess);
    spyOn(childProcess, 'spawn').mockImplementation(mockSpawn);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('successful test runs', () => {
    it('should spawn bun test with correct arguments', async () => {
      // Start the async operation
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
      });

      // Wait a tick for spawn to be called
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate successful test run
      (mockChildProcess as any).stdoutHandler?.(Buffer.from('test output'));
      (mockChildProcess as any).closeHandler?.(0);

      const result = await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'bun',
        ['test'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it('should collect stdout output', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
      });

      // Simulate test output
      (mockChildProcess as any).stdoutHandler?.(Buffer.from('line 1\n'));
      (mockChildProcess as any).stdoutHandler?.(Buffer.from('line 2\n'));
      (mockChildProcess as any).closeHandler?.(0);

      const result = await resultPromise;

      expect(result.stdout).toBe('line 1\nline 2\n');
      expect(result.stderr).toBe('');
    });

    it('should collect stderr output', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
      });

      // Simulate error output
      (mockChildProcess as any).stderrHandler?.(Buffer.from('warning: test warning\n'));
      (mockChildProcess as any).closeHandler?.(0);

      const result = await resultPromise;

      expect(result.stderr).toBe('warning: test warning\n');
    });

    it('should collect both stdout and stderr', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
      });

      // Simulate mixed output
      (mockChildProcess as any).stdoutHandler?.(Buffer.from('stdout line\n'));
      (mockChildProcess as any).stderrHandler?.(Buffer.from('stderr line\n'));
      (mockChildProcess as any).closeHandler?.(0);

      const result = await resultPromise;

      expect(result.stdout).toBe('stdout line\n');
      expect(result.stderr).toBe('stderr line\n');
    });
  });

  describe('failed test runs', () => {
    it('should handle non-zero exit codes', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
      });

      // Simulate test failure
      (mockChildProcess as any).stdoutHandler?.(Buffer.from('test failed\n'));
      (mockChildProcess as any).closeHandler?.(1);

      const result = await resultPromise;

      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
    });

    it('should handle process errors', async () => {
      const resultPromise = runBunTests({
        bunPath: 'invalid-bun-path',
        timeout: 5000,
      });

      // Simulate process error
      const error = new Error('ENOENT: no such file or directory');
      (mockChildProcess as any).errorHandler?.(error);

      const result = await resultPromise;

      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('ENOENT: no such file or directory');
    });
  });

  describe('timeout handling', () => {
    it('should timeout and kill process after timeout period', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 100, // Short timeout for testing
      });

      // Wait for timeout to trigger
      await new Promise(resolve => setTimeout(resolve, 150));

      // Simulate process close after kill
      (mockChildProcess as any).closeHandler?.(null);

      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should not timeout if process completes in time', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
      });

      // Complete quickly
      (mockChildProcess as any).closeHandler?.(0);

      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expect(mockChildProcess.kill).not.toHaveBeenCalled();
    });
  });

  describe('environment variable handling', () => {
    it('should pass custom environment variables', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        env: {
          CUSTOM_VAR: 'custom_value',
          ANOTHER_VAR: 'another_value',
        },
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOptions = spawnCall[2];
      expect(spawnOptions.env).toMatchObject({
        CUSTOM_VAR: 'custom_value',
        ANOTHER_VAR: 'another_value',
      });
    });

    it('should set __STRYKER_ACTIVE_MUTANT__ when activeMutant is provided', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        activeMutant: '42',
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOptions = spawnCall[2];
      expect(spawnOptions.env.__STRYKER_ACTIVE_MUTANT__).toBe('42');
    });

    it('should set __STRYKER_COVERAGE_FILE__ when coverageFile is provided', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        coverageFile: '/tmp/coverage.json',
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOptions = spawnCall[2];
      expect(spawnOptions.env.__STRYKER_COVERAGE_FILE__).toBe('/tmp/coverage.json');
    });
  });

  describe('test filtering and options', () => {
    it('should add --test-name-pattern when testNamePattern is provided', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        testNamePattern: 'should.*add',
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1];
      expect(args).toContain('--test-name-pattern');
      expect(args).toContain('should.*add');
    });

    it('should add --bail flag when bail is true', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        bail: true,
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1];
      expect(args).toContain('--bail');
    });

    it('should add --preload flag when preloadScript is provided', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        preloadScript: '/tmp/preload.ts',
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1];
      expect(args).toContain('--preload');
      expect(args).toContain('/tmp/preload.ts');
    });

    it('should add custom bunArgs', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        bunArgs: ['--only', '--verbose'],
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1];
      expect(args).toContain('--only');
      expect(args).toContain('--verbose');
    });

    it('should combine all options correctly', async () => {
      const resultPromise = runBunTests({
        bunPath: '/custom/bun',
        timeout: 5000,
        testNamePattern: 'myTest',
        bail: true,
        preloadScript: '/tmp/preload.ts',
        bunArgs: ['--verbose'],
        activeMutant: '123',
        coverageFile: '/tmp/coverage.json',
        env: { CUSTOM: 'value' },
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const [bunPath, args, options] = spawnCall;

      expect(bunPath).toBe('/custom/bun');
      expect(args).toEqual([
        'test',
        '--preload',
        '/tmp/preload.ts',
        '--test-name-pattern',
        'myTest',
        '--bail',
        '--verbose',
      ]);
      expect(options.env.__STRYKER_ACTIVE_MUTANT__).toBe('123');
      expect(options.env.__STRYKER_COVERAGE_FILE__).toBe('/tmp/coverage.json');
      expect(options.env.CUSTOM).toBe('value');
    });
  });

  describe('argument ordering', () => {
    it('should maintain correct argument order', async () => {
      const resultPromise = runBunTests({
        bunPath: 'bun',
        timeout: 5000,
        preloadScript: '/tmp/preload.ts',
        testNamePattern: 'test',
        bail: true,
        bunArgs: ['--only'],
      });

      (mockChildProcess as any).closeHandler?.(0);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1];

      // Verify order: test, preload, test-name-pattern, bail, then custom args
      expect(args[0]).toBe('test');
      expect(args[1]).toBe('--preload');
      expect(args[2]).toBe('/tmp/preload.ts');
      expect(args[3]).toBe('--test-name-pattern');
      expect(args[4]).toBe('test');
      expect(args[5]).toBe('--bail');
      expect(args[6]).toBe('--only');
    });
  });
});
