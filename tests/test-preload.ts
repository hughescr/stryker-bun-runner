/**
 * Test preload file - runs before any test imports
 * Sets up module mocks using Bun's mock.module() API
 */

import * as actualChildProcess from 'node:child_process';
import * as actualFs from 'node:fs/promises';
import * as actualNet from 'node:net';
import { mock } from 'bun:test';
import * as actualPortUtils from '../src/utils/port.js';
import * as actualProcessGroup from '../src/utils/process-group.js';

// CRITICAL: Capture functions as local variables BEFORE mock.module()
// ESM namespace objects have live bindings, so after mock.module() the namespace
// properties would point to the mocks, causing infinite recursion
const originalReadFile = actualFs.readFile;
const originalWriteFile = actualFs.writeFile;
const originalRename = actualFs.rename;
const originalMkdir = actualFs.mkdir;
const originalUnlink = actualFs.unlink;
const originalReaddir = actualFs.readdir;
const originalCreateServer = actualNet.createServer;
const originalSpawn = actualChildProcess.spawn;
const originalGetAvailablePort = actualPortUtils.getAvailablePort;
const originalKillProcessGroup = actualProcessGroup.killProcessGroup;

// Create controllable mock functions for node:fs/promises
// These start as pass-through implementations - unit tests configure them with mockResolvedValue/mockRejectedValue
// Integration tests will use the real fs functions automatically
export const mockReadFile = mock((...args: Parameters<typeof actualFs.readFile>) =>
    originalReadFile(...args));
export const mockWriteFile = mock((...args: Parameters<typeof actualFs.writeFile>) =>
    originalWriteFile(...args));
export const mockRename = mock((...args: Parameters<typeof actualFs.rename>) =>
    originalRename(...args));
export const mockMkdir = mock((...args: Parameters<typeof actualFs.mkdir>) =>
    originalMkdir(...args));
export const mockUnlink = mock((...args: Parameters<typeof actualFs.unlink>) =>
    originalUnlink(...args));
export const mockReaddir = mock((...args: Parameters<typeof actualFs.readdir>) =>
    originalReaddir(...args));

// Create controllable mock function for net.createServer
// Used by getAvailablePort() to find free ports
export const mockCreateServer = mock((...args: Parameters<typeof actualNet.createServer>) =>
    originalCreateServer(...args));

// Create controllable mock function for child_process.spawn
// Used by process-runner to spawn bun test processes
export const mockSpawn = mock((...args: Parameters<typeof actualChildProcess.spawn>) =>
    originalSpawn(...args));

// Create controllable mock function for getAvailablePort
// Used by BunTestRunner to get inspector and sync server ports
export const mockGetAvailablePort = mock((...args: Parameters<typeof actualPortUtils.getAvailablePort>) =>
    originalGetAvailablePort(...args));

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
export const mockKillProcessGroup = mock((_pid: number, _signal: NodeJS.Signals): boolean => false);

/**
 * The unmocked killProcessGroup, for integration tests that spawn real
 * processes and need the real group signal. Captured before mock.module() so
 * it is not itself the mock.
 */
export const realKillProcessGroup = originalKillProcessGroup;

/**
 * Reset all fs mocks to their default pass-through implementations.
 * Call this in afterEach() instead of mockClear() to ensure clean state between tests.
 * mockClear() only clears call history; mockReset() clears implementation too.
 * This function restores the pass-through behavior after reset.
 */
export function resetFsMocks(): void {
    mockReadFile.mockReset();
    mockReadFile.mockImplementation((...args: Parameters<typeof actualFs.readFile>) =>
        originalReadFile(...args));

    mockWriteFile.mockReset();
    mockWriteFile.mockImplementation((...args: Parameters<typeof actualFs.writeFile>) =>
        originalWriteFile(...args));

    mockRename.mockReset();
    mockRename.mockImplementation((...args: Parameters<typeof actualFs.rename>) =>
        originalRename(...args));

    mockMkdir.mockReset();
    mockMkdir.mockImplementation((...args: Parameters<typeof actualFs.mkdir>) =>
        originalMkdir(...args));

    mockUnlink.mockReset();
    mockUnlink.mockImplementation((...args: Parameters<typeof actualFs.unlink>) =>
        originalUnlink(...args));

    mockReaddir.mockReset();
    mockReaddir.mockImplementation((...args: Parameters<typeof actualFs.readdir>) =>
        originalReaddir(...args));
}

/**
 * Reset net mocks to their default pass-through implementations.
 */
export function resetNetMocks(): void {
    mockCreateServer.mockReset();
    mockCreateServer.mockImplementation((...args: Parameters<typeof actualNet.createServer>) =>
        originalCreateServer(...args));
}

/**
 * Reset child_process mocks to their default pass-through implementations.
 */
export function resetChildProcessMocks(): void {
    mockSpawn.mockReset();
    mockSpawn.mockImplementation((...args: Parameters<typeof actualChildProcess.spawn>) =>
        originalSpawn(...args));
}

/**
 * Reset port utility mocks to their default pass-through implementations.
 */
export function resetPortMocks(): void {
    mockGetAvailablePort.mockReset();
    mockGetAvailablePort.mockImplementation((...args: Parameters<typeof actualPortUtils.getAvailablePort>) =>
        originalGetAvailablePort(...args));
}

/**
 * Reset the process-group mock to its inert default (see mockKillProcessGroup
 * for why the default is inert rather than pass-through).
 */
export function resetProcessGroupMocks(): void {
    mockKillProcessGroup.mockReset();
    mockKillProcessGroup.mockImplementation((_pid: number, _signal: NodeJS.Signals): boolean => false);
}

/**
 * Reset all mocks to their default pass-through implementations.
 */
export function resetAllMocks(): void {
    resetFsMocks();
    resetNetMocks();
    resetChildProcessMocks();
    resetPortMocks();
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

// Mock the net module for createServer
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('net', () => ({
    ...actualNet,
    createServer: mockCreateServer,
}));

// Mock the child_process module for spawn
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('node:child_process', () => ({
    ...actualChildProcess,
    spawn: mockSpawn,
}));

// Mock the port utilities module for getAvailablePort
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('../src/utils/port.js', () => ({
    ...actualPortUtils,
    getAvailablePort: mockGetAvailablePort,
}));

// Mock the process-group module so no test can signal a real process group
// with a mock child's fabricated pid — see mockKillProcessGroup.
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('../src/utils/process-group.js', () => ({
    ...actualProcessGroup,
    killProcessGroup: mockKillProcessGroup,
}));

// NOTE: No global afterEach here - each test file is responsible for its own cleanup
// Tests should call resetAllMocks() in their own afterEach hooks
// This follows the pattern from isambard where tests manage their own cleanup
