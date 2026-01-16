import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import * as net from 'net';
import { getAvailablePort } from '../../src/utils/port';

describe('getAvailablePort', () => {
    let createServerSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Clear any previous spies
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- optional chaining on mock
        createServerSpy?.mockRestore?.();
    });

    afterEach(() => {
        // Clean up spy after each test
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- optional chaining on mock
        createServerSpy?.mockRestore?.();
    });

    it('returns a valid port number on success', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        const port = await getAvailablePort();

        expect(port).toBe(12345);
        expect(port).toBeGreaterThan(0);
        expect(typeof port).toBe('number');
        expect(mockServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
        expect(mockServer.address).toHaveBeenCalled();
        expect(mockServer.close).toHaveBeenCalled();
    });

    it('returns different valid port numbers', async () => {
        const testPort = 54321;
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

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

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
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
            close:   mock(() => {}),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow('Failed to get available port');
        await expect(getAvailablePort()).rejects.toThrow('EADDRINUSE');
        await expect(getAvailablePort()).rejects.toThrow(testError.message);
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
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
            close:   mock(() => {}),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow(`Failed to get available port: ${errorMessage}`);
    });

    it('rejects when server address returns null', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => null),
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
            close:   mock(() => {}),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow('Failed to get port: server address is invalid');
        await expect(getAvailablePort()).rejects.toThrow('server address is invalid');
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
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
            close:   mock(() => {}),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow('Failed to get port: server address is invalid');
        await expect(getAvailablePort()).rejects.toThrow('invalid');
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
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback(closeError);
            }),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow('Failed to close server');
        await expect(getAvailablePort()).rejects.toThrow('Failed to release socket');
        await expect(getAvailablePort()).rejects.toThrow(closeError.message);
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
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback(closeError);
            }),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow(`Failed to close server: ${errorMessage}`);
    });

    it('binds to 127.0.0.1 specifically', async () => {
        const mockServer = {
            on:     mock(() => mockServer),
            listen: mock((_port: number, _host: string, callback: () => void) => {
                callback();
                return mockServer;
            }),
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

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
            address: mock(() => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' })),
            close:   mock((callback: (err?: Error) => void) => {
                callback();
            }),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

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
                return { port: 12345, family: 'IPv4', address: '127.0.0.1' };
            }),
            close: mock((callback: (err?: Error) => void) => {
                callOrder.push('close');
                callback();
            }),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

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
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
            close:   mock(() => {}),
        };

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        await expect(getAvailablePort()).rejects.toThrow();

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

        createServerSpy = spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

        const port = await getAvailablePort();

        expect(port).toBe(expectedPort);
        expect(mockServer.address).toHaveBeenCalled();
    });
});
