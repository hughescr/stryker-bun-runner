import type * as net from 'node:net';
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { getAvailablePort } from '../../src/utils/port';
import { mockCreateServer, resetNetMocks } from '../test-preload.js';

describe('getAvailablePort', () => {
    beforeEach(() => {
        // Clear call history before each test
        mockCreateServer.mockClear();
    });

    afterEach(() => {
        // Reset net mocks to prevent leakage to other tests
        resetNetMocks();
    });

    it('returns a valid port number on success', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const port = await getAvailablePort();

        expect(port).toBe(12_345);
        expect(port).toBeGreaterThan(0);
        expect(typeof port).toBe('number');
        expect(mockServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
        expect(mockServer.address).toHaveBeenCalled();
        expect(mockServer.close).toHaveBeenCalled();
    });

    it('returns different valid port numbers', async () => {
        const testPort = 54_321;
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: testPort, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const port = await getAvailablePort();

        expect(port).toBe(testPort);
        expect(port).toBeGreaterThan(0);
    });

    it('rejects when server emits error event', async () => {
        const testError = new Error('EADDRINUSE: address already in use');
        const mockServer = {
            on: mock((event: string, handler: (err: Error) => void) => {
                if(event === 'error') {
                    // Trigger error handler immediately
                    setImmediate(() => handler(testError));
                }
                return mockServer;
            }),
            listen:  mock(() => mockServer),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),

            close: mock(() => {}),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain('Failed to get available port');
        expect((caughtError as Error).message).toContain('EADDRINUSE');
        expect((caughtError as Error).message).toContain(testError.message);
    });

    it('rejects with specific error message format when server errors', async () => {
        const errorMessage = 'Permission denied';
        const testError = new Error(errorMessage);
        const mockServer = {
            on: mock((event: string, handler: (err: Error) => void) => {
                if(event === 'error') {
                    setImmediate(() => handler(testError));
                }
                return mockServer;
            }),
            listen:  mock(() => mockServer),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),

            close: mock(() => {}),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain(`Failed to get available port: ${errorMessage}`);
    });

    it('rejects when server address returns null', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => null),

            close: mock(() => {}),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError1 = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError1).toBeInstanceOf(Error);
        expect((caughtError1 as Error).message).toContain('Failed to get port: server address is invalid');
        expect((caughtError1 as Error).message).toContain('server address is invalid');
        expect(mockServer.close).toHaveBeenCalled();
    });

    it('rejects when server address returns a string', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => '/tmp/socket.sock'),

            close: mock(() => {}),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError2 = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError2).toBeInstanceOf(Error);
        expect((caughtError2 as Error).message).toContain('Failed to get port: server address is invalid');
        expect((caughtError2 as Error).message).toContain('invalid');
        expect(mockServer.close).toHaveBeenCalled();
    });

    it('rejects when server close callback receives an error', async () => {
        const closeError = new Error('Failed to release socket');
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback(closeError);
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError3 = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError3).toBeInstanceOf(Error);
        expect((caughtError3 as Error).message).toContain('Failed to close server');
        expect((caughtError3 as Error).message).toContain('Failed to release socket');
        expect((caughtError3 as Error).message).toContain(closeError.message);
    });

    it('rejects with specific error message format when close fails', async () => {
        const errorMessage = 'Socket already closed';
        const closeError = new Error(errorMessage);
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback(closeError);
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError4 = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError4).toBeInstanceOf(Error);
        expect((caughtError4 as Error).message).toContain(`Failed to close server: ${errorMessage}`);
    });

    it('binds to 127.0.0.1 specifically', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        await getAvailablePort();

        expect(mockServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));

        // Verify the host parameter is exactly '127.0.0.1'
        const listenCalls = mockServer.listen.mock.calls;
        expect(listenCalls[0][1]).toBe('127.0.0.1');
    });

    it('requests port 0 from the OS', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12_345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        await getAvailablePort();

        expect(mockServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));

        // Verify port parameter is exactly 0
        const listenCalls = mockServer.listen.mock.calls;
        expect(listenCalls[0][0]).toBe(0);
    });

    it('registers error handler before listening', async () => {
        const callOrder: string[] = [];

        const mockServer = {
            on: mock((event: string) => {
                callOrder.push(`on:${event}`);
                return mockServer;
            }),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callOrder.push('listen');
                callback();
                return mockServer;
            }),
            address: mock(() => {
                callOrder.push('address');
                return { port: 12_345, family: 'IPv4', address: '127.0.0.1' };
            }),
            close: mock((callback: (err?: Error) => void) => {
                callOrder.push('close');
                callback();
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        await getAvailablePort();

        // Error handler should be registered before listen is called
        const errorHandlerIndex = callOrder.indexOf('on:error');
        const listenIndex = callOrder.indexOf('listen');

        expect(errorHandlerIndex).toBeGreaterThanOrEqual(0);
        expect(listenIndex).toBeGreaterThanOrEqual(0);
        expect(errorHandlerIndex).toBeLessThan(listenIndex);
    });

    it('closes server before rejecting on invalid address', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => null),

            close: mock(() => {}),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const caughtError5 = await getAvailablePort().catch((e: unknown) => e);
        expect(caughtError5).toBeInstanceOf(Error);

        // Verify close was called before rejection
        expect(mockServer.close).toHaveBeenCalled();
    });

    it('extracts port from address object', async () => {
        const expectedPort = 9999;
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({
                port:    expectedPort,
                family:  'IPv4',
                address: '127.0.0.1'
            })),
            close: mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        mockCreateServer.mockReturnValue(mockServer as unknown as net.Server);

        const port = await getAvailablePort();

        expect(port).toBe(expectedPort);
        expect(mockServer.address).toHaveBeenCalled();
    });
});
