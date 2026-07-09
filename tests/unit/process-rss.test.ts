/**
 * Unit tests for the cross-platform child-process RSS probe
 */

import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getProcessRssBytes, parsePsRssOutput, parseVmRss } from '../../src/utils/process-rss.js';
import { mockReadFile, mockSpawn, resetAllMocks } from '../test-preload.js';

interface MockChildProcess extends Partial<ChildProcess> {
    stdoutHandler?: (data: Buffer) => void
    closeHandler?:  (code: number | null) => void
    errorHandler?:  (error: Error) => void
}

/**
 * `process.platform` is a plain data property on Node/Bun (writable and
 * configurable), so Object.defineProperty + restore is the portable way to
 * fake it per test — bun:test's spyOn does not support Jest's 3-arg
 * accessor-spy form for a plain data property like this one.
 */
let originalPlatformDescriptor: PropertyDescriptor;

function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform(): void {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
}

describe('parseVmRss', () => {
    it('parses a VmRSS line in kB and converts to bytes', () => {
        const status = 'Name:\tbun\nVmRSS:\t   12345 kB\nVmSize:\t 99999 kB\n';
        expect(parseVmRss(status)).toBe(12_345 * 1024);
    });

    it('returns null when VmRSS line is absent', () => {
        const status = 'Name:\tbun\nVmSize:\t 99999 kB\n';
        expect(parseVmRss(status)).toBeNull();
    });

    it('only matches VmRSS at the start of a line (anchored, not a mid-line substring)', () => {
        // "PrefixVmRSS:" on the first line must NOT match — only the real,
        // properly-anchored VmRSS line on the second line should.
        const status = 'PrefixVmRSS:\t 999 kB\nVmRSS:\t 123 kB\n';
        expect(parseVmRss(status)).toBe(123 * 1024);
    });

    it('does not match a line with trailing content after kB (anchored to end of line)', () => {
        const status = 'VmRSS:\t   999 kBish\n';
        expect(parseVmRss(status)).toBeNull();
    });

    it('matches when there is more than one whitespace character between the number and kB', () => {
        const status = 'VmRSS:\t 4096  kB\n';
        expect(parseVmRss(status)).toBe(4096 * 1024);
    });
});

describe('parsePsRssOutput', () => {
    it('parses a numeric ps -o rss= value in kB and converts to bytes', () => {
        expect(parsePsRssOutput('  54321  \n')).toBe(54_321 * 1024);
    });

    it('returns null for empty ps output', () => {
        expect(parsePsRssOutput('   \n')).toBeNull();
    });

    it('returns null for non-numeric ps output', () => {
        expect(parsePsRssOutput('not-a-number')).toBeNull();
    });
});

describe('getProcessRssBytes', () => {
    beforeEach(() => {
        originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    });

    afterEach(() => {
        resetAllMocks();
        restorePlatform();
    });

    describe('on linux', () => {
        beforeEach(() => {
            setPlatform('linux');
        });

        it('reads /proc/<pid>/status and returns parsed RSS in bytes', async () => {
            mockReadFile.mockImplementation(() => Promise.resolve('VmRSS:\t 2048 kB\n'));

            const result = await getProcessRssBytes(4242);

            expect(result).toBe(2048 * 1024);
            expect(mockReadFile).toHaveBeenCalledWith('/proc/4242/status', 'utf8');
        });

        it('returns null when the status file cannot be read (process exited)', async () => {
            mockReadFile.mockImplementation(() => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));

            const result = await getProcessRssBytes(4242);

            expect(result).toBeNull();
        });

        it('returns null when the status file has no VmRSS line', async () => {
            mockReadFile.mockImplementation(() => Promise.resolve('Name:\tbun\n'));

            const result = await getProcessRssBytes(4242);

            expect(result).toBeNull();
        });
    });

    describe('on darwin (ps fallback)', () => {
        let mockChildProcess: MockChildProcess;

        beforeEach(() => {
            setPlatform('darwin');

            /* eslint-disable @typescript-eslint/no-explicit-any -- mock child process with any-typed properties */
            mockChildProcess = {
                stdout: {
                    on: mock((event: string, handler: (data: Buffer) => void) => {
                        if(event === 'data') {
                            mockChildProcess.stdoutHandler = handler;
                        }
                    }),
                } as any,
                on: mock((event: string, handler: (...args: any[]) => void) => {
                    if(event === 'close') {
                        mockChildProcess.closeHandler = handler;
                    } else if(event === 'error') {
                        mockChildProcess.errorHandler = handler;
                    }
                    return mockChildProcess as ChildProcess;
                }) as any,
            };
            /* eslint-enable @typescript-eslint/no-explicit-any -- re-enable after mock setup */

            mockSpawn.mockImplementation(() => mockChildProcess as ChildProcess);
        });

        it('spawns ps -o rss= -p <pid> and parses stdout as bytes', async () => {
            const resultPromise = getProcessRssBytes(777);

            await Promise.resolve();
            mockChildProcess.stdoutHandler?.(Buffer.from('  8192\n'));
            mockChildProcess.closeHandler?.(0);

            const result = await resultPromise;

            expect(result).toBe(8192 * 1024);
            expect(mockSpawn).toHaveBeenCalledWith('ps', ['-o', 'rss=', '-p', '777'], expect.objectContaining({
                stdio: ['ignore', 'pipe', 'ignore'],
            }));
        });

        it('returns null when ps exits with a non-zero code (e.g. pid no longer exists)', async () => {
            const resultPromise = getProcessRssBytes(777);

            await Promise.resolve();
            mockChildProcess.stdoutHandler?.(Buffer.from('8192\n'));
            mockChildProcess.closeHandler?.(1);

            const result = await resultPromise;

            expect(result).toBeNull();
        });

        it('returns null when the ps process errors (e.g. binary not found)', async () => {
            const resultPromise = getProcessRssBytes(777);

            await Promise.resolve();
            mockChildProcess.errorHandler?.(new Error('ENOENT: no such file or directory'));

            const result = await resultPromise;

            expect(result).toBeNull();
        });

        it('returns null when spawn itself throws synchronously', async () => {
            mockSpawn.mockImplementation(() => {
                throw new Error('spawn failed');
            });

            const result = await getProcessRssBytes(777);

            expect(result).toBeNull();
        });
    });
});
