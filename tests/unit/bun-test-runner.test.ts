/**
 * Unit tests for BunTestRunner
 * Integration-level tests for the main TestRunner implementation
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { BunTestRunner } from '../../src/bun-test-runner.js';
import { DryRunStatus, MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import type { Logger } from '@stryker-mutator/api/logging';
import type { StrykerOptions } from '@stryker-mutator/api/core';
import * as processRunner from '../../src/process-runner.js';
import * as coverageCollector from '../../src/coverage/collector.js';
import * as preloadGenerator from '../../src/coverage/preload-generator.js';

describe('BunTestRunner', () => {
  let mockLogger: Logger;
  let mockRunBunTests: ReturnType<typeof mock>;
  let mockCollectCoverage: ReturnType<typeof mock>;
  let mockCleanupCoverageFile: ReturnType<typeof mock>;
  let mockGeneratePreloadScript: ReturnType<typeof mock>;
  let mockCleanupPreloadScript: ReturnType<typeof mock>;

  beforeEach(() => {
    // Create mock logger
    mockLogger = {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
      trace: mock(),
      fatal: mock(),
      isTraceEnabled: mock().mockReturnValue(false),
      isDebugEnabled: mock().mockReturnValue(true),
      isInfoEnabled: mock().mockReturnValue(true),
      isWarnEnabled: mock().mockReturnValue(true),
      isErrorEnabled: mock().mockReturnValue(true),
      isFatalEnabled: mock().mockReturnValue(true),
    };

    // Mock process runner
    mockRunBunTests = mock();
    spyOn(processRunner, 'runBunTests').mockImplementation(mockRunBunTests);

    // Mock coverage collector
    mockCollectCoverage = mock();
    mockCleanupCoverageFile = mock();
    spyOn(coverageCollector, 'collectCoverage').mockImplementation(mockCollectCoverage);
    spyOn(coverageCollector, 'cleanupCoverageFile').mockImplementation(mockCleanupCoverageFile);

    // Mock preload generator
    mockGeneratePreloadScript = mock();
    mockCleanupPreloadScript = mock();
    spyOn(preloadGenerator, 'generatePreloadScript').mockImplementation(mockGeneratePreloadScript);
    spyOn(preloadGenerator, 'cleanupPreloadScript').mockImplementation(mockCleanupPreloadScript);

    // Default mock implementations
    mockCleanupCoverageFile.mockResolvedValue(undefined);
    mockCleanupPreloadScript.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

      expect(runner).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('BunTestRunner initialized'),
        expect.objectContaining({
          bunPath: 'bun',
          timeout: 10000,
        })
      );
    });

    it('should use custom bunPath from options', () => {
      new BunTestRunner(mockLogger, {
        bun: {
          bunPath: '/custom/bun',
        },
      } as unknown as StrykerOptions);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          bunPath: '/custom/bun',
        })
      );
    });

    it('should use custom timeout from options', () => {
      new BunTestRunner(mockLogger, {
        bun: {
          timeout: 20000,
        },
      } as unknown as StrykerOptions);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeout: 20000,
        })
      );
    });

    it('should accept custom environment variables', () => {
      new BunTestRunner(mockLogger, {
        bun: {
          env: {
            CUSTOM_VAR: 'value',
          },
        },
      } as unknown as StrykerOptions);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          env: { CUSTOM_VAR: 'value' },
        })
      );
    });

    it('should accept custom bunArgs', () => {
      new BunTestRunner(mockLogger, {
        bun: {
          bunArgs: ['--only', '--verbose'],
        },
      } as unknown as StrykerOptions);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          bunArgs: ['--only', '--verbose'],
        })
      );
    });
  });

  describe('capabilities', () => {
    it('should return correct capabilities', () => {
      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

      const capabilities = runner.capabilities();

      expect(capabilities).toEqual({
        reloadEnvironment: true,
      });
    });
  });

  describe('init', () => {
    it('should validate bun installation', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: 'bun version 1.0.0',
        stderr: '',
        timedOut: false,
      });
      mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

      await runner.init();

      expect(mockRunBunTests).toHaveBeenCalledWith(
        expect.objectContaining({
          bunPath: 'bun',
          bunArgs: ['--version'],
          timeout: 5000,
        })
      );
    });

    it('should throw error if bun validation fails', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 1,
        stdout: 'command not found',
        stderr: 'bun: command not found',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

      await expect(runner.init()).rejects.toThrow('Failed to execute bun');
    });

    it('should generate preload script', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: 'bun version 1.0.0',
        stderr: '',
        timedOut: false,
      });
      mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

      await runner.init();

      expect(mockGeneratePreloadScript).toHaveBeenCalledWith(
        expect.objectContaining({
          tempDir: expect.stringContaining('stryker-bun-runner'),
        })
      );
    });
  });

  describe('dryRun', () => {
    beforeEach(async () => {
      // Mock for init validation
      mockRunBunTests.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'bun version 1.0.0',
        stderr: '',
        timedOut: false,
      });
      mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
    });

    it('should run tests with coverage', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.12ms]

 1 pass
`,
        stderr: '',
        timedOut: false,
      });
      mockCollectCoverage.mockResolvedValue({
        perTest: {
          'should pass': { '1': 1, '2': 1 },
        },
        static: { '3': 1 },
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.dryRun();

      expect(result.status).toBe(DryRunStatus.Complete);
      expect(result).toHaveProperty('tests');
      expect(result).toHaveProperty('mutantCoverage');
    });

    it('should return timeout status on timeout', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.dryRun();

      expect(result.status).toBe(DryRunStatus.Timeout);
    });

    it('should return error status on process failure', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Fatal error',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.dryRun();

      expect(result.status).toBe(DryRunStatus.Error);
      expect(result).toHaveProperty('errorMessage');
    });

    it('should map test results correctly', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: `
bun test v1.1.0

tests/example.test.ts:
✓ passing test [0.12ms]
✗ failing test [0.05ms]
  error: Test failed
⏭ skipped test

 1 pass
 1 fail
 1 skip
`,
        stderr: '',
        timedOut: false,
      });
      mockCollectCoverage.mockResolvedValue(undefined);

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.dryRun();

      expect(result.status).toBe(DryRunStatus.Complete);
      if (result.status === DryRunStatus.Complete) {
        expect(result.tests).toHaveLength(3);
        expect(result.tests[0].name).toBe('passing test');
        expect(result.tests[0].status).toBe(TestStatus.Success);
        expect(result.tests[0].timeSpentMs).toBe(0.12);

        expect(result.tests[1].name).toBe('failing test');
        expect(result.tests[1].status).toBe(TestStatus.Failed);
        expect(result.tests[1].timeSpentMs).toBe(0.05);

        expect(result.tests[2].name).toBe('skipped test');
        expect(result.tests[2].status).toBe(TestStatus.Skipped);
      }
    });

    it('should cleanup coverage file after reading', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: '✓ test [0.12ms]\n 1 pass',
        stderr: '',
        timedOut: false,
      });
      mockCollectCoverage.mockResolvedValue(undefined);

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.dryRun();

      expect(mockCleanupCoverageFile).toHaveBeenCalled();
    });
  });

  describe('mutantRun', () => {
    beforeEach(async () => {
      // Mock for init validation
      mockRunBunTests.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'bun version 1.0.0',
        stderr: '',
        timedOut: false,
      });
      mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
    });

    it('should return killed status when tests fail', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 1,
        stdout: `
bun test v1.1.0

tests/example.test.ts:
✗ should catch mutant [0.05ms]
  error: Expected 2 but received 3

 0 pass
 1 fail
`,
        stderr: '',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: ['should catch mutant'],
        sandboxFileName: 'sandbox',
      } as any);

      expect(result.status).toBe(MutantRunStatus.Killed);
      if (result.status === MutantRunStatus.Killed) {
        expect(result.killedBy).toHaveLength(1);
        expect(result.killedBy[0]).toBe('should catch mutant');
        expect(result.nrOfTests).toBe(1);
      }
    });

    it('should return survived status when all tests pass', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: `
bun test v1.1.0

tests/example.test.ts:
✓ should pass [0.05ms]

 1 pass
`,
        stderr: '',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: [],
        sandboxFileName: 'sandbox',
      } as any);

      expect(result.status).toBe(MutantRunStatus.Survived);
      if (result.status === MutantRunStatus.Survived) {
        expect(result.nrOfTests).toBe(1);
      }
    });

    it('should return timeout status on timeout', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: [],
        sandboxFileName: 'sandbox',
      } as any);

      expect(result.status).toBe(MutantRunStatus.Timeout);
    });

    it('should return error status on process failure', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Fatal error',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      const result = await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: [],
        sandboxFileName: 'sandbox',
      } as any);

      expect(result.status).toBe(MutantRunStatus.Error);
    });

    it('should use testFilter to create test name pattern', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: '✓ test [0.05ms]\n 1 pass',
        stderr: '',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: ['test 1', 'test 2'],
        sandboxFileName: 'sandbox',
      } as any);

      expect(mockRunBunTests).toHaveBeenCalledWith(
        expect.objectContaining({
          testNamePattern: expect.stringContaining('test 1'),
        })
      );
    });

    it('should set activeMutant in environment', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: '✓ test [0.05ms]\n 1 pass',
        stderr: '',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.mutantRun({
        activeMutant: { id: '42' } as any,
        testFilter: [],
        sandboxFileName: 'sandbox',
      } as any);

      expect(mockRunBunTests).toHaveBeenCalledWith(
        expect.objectContaining({
          activeMutant: '42',
        })
      );
    });

    it('should enable bail for mutant runs', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: '✓ test [0.05ms]\n 1 pass',
        stderr: '',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: [],
        sandboxFileName: 'sandbox',
      } as any);

      expect(mockRunBunTests).toHaveBeenCalledWith(
        expect.objectContaining({
          bail: true,
        })
      );
    });

    it('should escape regex special characters in test names', async () => {
      mockRunBunTests.mockResolvedValue({
        exitCode: 0,
        stdout: '✓ test [0.05ms]\n 1 pass',
        stderr: '',
        timedOut: false,
      });

      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.mutantRun({
        activeMutant: { id: '1' } as any,
        testFilter: ['test (with) [special] chars'],
        sandboxFileName: 'sandbox',
      } as any);

      // Get the last call (not the init call)
      const lastCallIndex = mockRunBunTests.mock.calls.length - 1;
      const call = mockRunBunTests.mock.calls[lastCallIndex][0];
      expect(call.testNamePattern).toBeDefined();
      expect(call.testNamePattern).toMatch(/\\\(/);
      expect(call.testNamePattern).toMatch(/\\\[/);
    });
  });

  describe('dispose', () => {
    beforeEach(async () => {
      // Mock for init validation
      mockRunBunTests.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'bun version 1.0.0',
        stderr: '',
        timedOut: false,
      });
      mockGeneratePreloadScript.mockResolvedValue('/tmp/preload.ts');
    });

    it('should cleanup preload script', async () => {
      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.dispose();

      expect(mockCleanupPreloadScript).toHaveBeenCalled();
    });

    it('should cleanup coverage file', async () => {
      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);
      await runner.init();

      await runner.dispose();

      expect(mockCleanupCoverageFile).toHaveBeenCalled();
    });

    it('should handle dispose without init', async () => {
      const runner = new BunTestRunner(mockLogger, {} as unknown as StrykerOptions);

      // Should not throw
      await expect(runner.dispose()).resolves.toBeUndefined();
    });
  });
});
