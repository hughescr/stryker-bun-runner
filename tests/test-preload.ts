/**
 * Test preload file - runs before any test imports
 * Sets up module mocks using Bun's mock.module() API
 */

import * as actualChildProcess from 'node:child_process';
import * as actualFs from 'node:fs/promises';
import { afterEach, mock } from 'bun:test';
import * as actualProcessGroup from '../src/utils/process-group.js';
// Fails any test (or file) that leaves state behind; see the file for the policy.
import { failOnTestLeaks, registerSharedMocks } from './leak-guard.js';
// Fails any test that waits on the real clock; see the file for the policy.
import { failOnRealWaits } from './real-clock-guard.js';

// CRITICAL: Capture functions as local variables BEFORE mock.module()
// ESM namespace objects have live bindings, so after mock.module() the namespace
// properties would point to the mocks, causing infinite recursion
const originalReadFile = actualFs.readFile;
const originalWriteFile = actualFs.writeFile;
const originalRename = actualFs.rename;
const originalMkdir = actualFs.mkdir;
const originalUnlink = actualFs.unlink;
const originalReaddir = actualFs.readdir;
const originalSpawn = actualChildProcess.spawn;
const originalKillProcessGroup = actualProcessGroup.killProcessGroup;

// The default implementations, kept as single function objects so a reset puts
// back the very function each mock started with: tests/leak-guard.ts compares
// a mock's implementation before and after every test by identity.
const passThroughReadFile = (...args: Parameters<typeof actualFs.readFile>) => originalReadFile(...args);
const passThroughWriteFile = (...args: Parameters<typeof actualFs.writeFile>) => originalWriteFile(...args);
const passThroughRename = (...args: Parameters<typeof actualFs.rename>) => originalRename(...args);
const passThroughMkdir = (...args: Parameters<typeof actualFs.mkdir>) => originalMkdir(...args);
const passThroughUnlink = (...args: Parameters<typeof actualFs.unlink>) => originalUnlink(...args);
const passThroughReaddir = (...args: Parameters<typeof actualFs.readdir>) => originalReaddir(...args);
const passThroughSpawn = (...args: Parameters<typeof actualChildProcess.spawn>) => originalSpawn(...args);
const inertKillProcessGroup = (_pid: number, _signal: NodeJS.Signals): boolean => false;

// Create controllable mock functions for node:fs/promises
// These start as pass-through implementations - unit tests configure them with mockResolvedValue/mockRejectedValue
// Integration tests will use the real fs functions automatically
export const mockReadFile = mock(passThroughReadFile);
export const mockWriteFile = mock(passThroughWriteFile);
export const mockRename = mock(passThroughRename);
export const mockMkdir = mock(passThroughMkdir);
export const mockUnlink = mock(passThroughUnlink);
export const mockReaddir = mock(passThroughReaddir);

// Create controllable mock function for child_process.spawn
// Used by process-runner to spawn bun test processes
export const mockSpawn = mock(passThroughSpawn);

/**
 * The unmocked child_process.spawn, for tests that need genuine child
 * processes (see process-group.test.ts). Spawning through this instead of the
 * mocked `node:child_process` keeps those calls out of mockSpawn's shared call
 * history, which every other file asserts on. Captured before mock.module() so
 * it is not itself the mock.
 */
export const realSpawn = originalSpawn;

/**
 * Mock for killProcessGroup.
 *
 * Unlike every other mock in this file, its default is INERT rather than
 * pass-through, and deliberately so: the real implementation signals a whole
 * process group via a negative pid. Mock children carry fabricated pids (12345
 * and friends), and a real group with that id may well exist on the machine
 * running the tests — a pass-through default would let a routine unit test
 * signal unrelated processes. Returning false also exercises the caller's
 * fallback path, which is the behaviour unit tests actually assert on.
 *
 * The real implementation is re-exported as {@link realKillProcessGroup} so an
 * integration test working with genuine child processes can opt back into it.
 */
export const mockKillProcessGroup = mock(inertKillProcessGroup);

/**
 * The unmocked killProcessGroup, for integration tests that spawn real
 * processes and need the real group signal. Captured before mock.module() so
 * it is not itself the mock.
 */
export const realKillProcessGroup = originalKillProcessGroup;

/**
 * Put every fs mock back to its default pass-through implementation, with no
 * recorded calls. Call it in the afterEach (or afterAll) of the test (or file)
 * that configured or called the mocks: mockClear() only clears call history,
 * mockReset() clears the implementation too, and this restores the
 * pass-through behaviour after the reset.
 */
export function resetFsMocks(): void {
    mockReadFile.mockReset();
    mockReadFile.mockImplementation(passThroughReadFile);

    mockWriteFile.mockReset();
    mockWriteFile.mockImplementation(passThroughWriteFile);

    mockRename.mockReset();
    mockRename.mockImplementation(passThroughRename);

    mockMkdir.mockReset();
    mockMkdir.mockImplementation(passThroughMkdir);

    mockUnlink.mockReset();
    mockUnlink.mockImplementation(passThroughUnlink);

    mockReaddir.mockReset();
    mockReaddir.mockImplementation(passThroughReaddir);
}

/**
 * Reset child_process mocks to their default pass-through implementations.
 */
export function resetChildProcessMocks(): void {
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(passThroughSpawn);
}

/**
 * Reset the process-group mock to its inert default (see mockKillProcessGroup
 * for why the default is inert rather than pass-through).
 */
export function resetProcessGroupMocks(): void {
    mockKillProcessGroup.mockReset();
    mockKillProcessGroup.mockImplementation(inertKillProcessGroup);
}

/**
 * Reset all mocks to their default pass-through implementations.
 */
export function resetAllMocks(): void {
    resetFsMocks();
    resetChildProcessMocks();
    resetProcessGroupMocks();
}

// Mock the entire node:fs/promises module
// This intercepts ALL imports of node:fs/promises before any test code runs
// We spread the actual module to get all real exports, then override specific functions with our mocks
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('node:fs/promises', () => ({
    ...actualFs,
    readFile:  mockReadFile,
    writeFile: mockWriteFile,
    rename:    mockRename,
    mkdir:     mockMkdir,
    unlink:    mockUnlink,
    readdir:   mockReaddir,
}));

// Mock the child_process module for spawn
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('node:child_process', () => ({
    ...actualChildProcess,
    spawn: mockSpawn,
}));

// Mock the process-group module so no test can signal a real process group
// with a mock child's fabricated pid — see mockKillProcessGroup.
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('../src/utils/process-group.js', () => ({
    ...actualProcessGroup,
    killProcessGroup: mockKillProcessGroup,
}));

// Every test leaves these as it found them: no calls recorded, the default implementation.
registerSharedMocks({
    mockReadFile, mockWriteFile, mockRename, mockMkdir, mockUnlink, mockReaddir, mockSpawn, mockKillProcessGroup,
});

// The guards' end-of-test checks, in one hook: bun stops running afterEach hooks
// at the first one that throws, so separate hooks would let one guard's failure
// skip the other's check (and leave its state to fail the next test). Every
// check runs; their reports are combined into one failure.
afterEach(() => {
    const failures: string[] = [];
    for(const check of [failOnRealWaits, failOnTestLeaks]) {
        try {
            check();
        } catch (error) {
            failures.push((error as Error).message);
        }
    }
    if(failures.length > 0) {
        throw new Error(failures.join('\n\n'));
    }
});

// There is no global reset of the mocks above: the test (or file) that configures
// or calls them cleans up after itself, and tests/leak-guard.ts fails any that
// does not.
