/**
 * Unit tests for utils/sync-server
 * Tests WebSocket synchronization server using mock injection
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SyncServer } from '../../src/utils/sync-server';

// Mock WebSocket client
interface MockClient {
    readyState: number
    send:       ReturnType<typeof mock>
    close:      ReturnType<typeof mock>
    on:         ReturnType<typeof mock>
}

const createMockClient = (readyState = 1): MockClient => ({
    readyState,

    send: mock(() => {}),

    close: mock(() => {}),

    on: mock(() => {}),
});

// Mock WebSocketServer
interface MockWss {
    on:                ReturnType<typeof mock>
    close:             ReturnType<typeof mock>
    triggerConnection: (client: MockClient) => void
}

const createMockWss = (): MockWss => {
    const handlers = new Map<string, (arg: unknown) => void>();
    return {
        on: mock((event: string, handler: (arg: unknown) => void) => {
            handlers.set(event, handler);
        }),

        close: mock((callback?: () => void) => {
            if(!callback) {
                return;
            }
            callback();
        }),
        triggerConnection(client: MockClient) {
            const handler = handlers.get('connection');
            if(handler) {
                handler(client);
            }
        },
    };
};

// Mock HTTP Server
interface MockHttpServer {
    on:                ReturnType<typeof mock>
    listen:            ReturnType<typeof mock>
    close:             ReturnType<typeof mock>
    triggerError:      (err: Error) => void
    getRequestHandler: () => ((req: { url?: string }, res: { writeHead: (code: number) => void, end: (msg: string) => void }) => void) | null
}

const createMockHttpServer = (): MockHttpServer => {
    const handlers = new Map<string, (arg: unknown) => void>();
    let requestHandler: ((req: { url?: string }, res: { writeHead: (code: number) => void, end: (msg: string) => void }) => void) | null = null;

    const mockServer: MockHttpServer = {
        on: mock((event: string, handler: (arg: unknown) => void) => {
            handlers.set(event, handler);
        }),
        listen: mock((_port: number, callback: () => void) => {
            setImmediate(callback);
        }),
        close: mock((callback?: () => void) => {
            if(!callback) {
                return;
            }
            callback();
        }),
        triggerError(err: Error) {
            const handler = handlers.get('error');
            if(handler) {
                handler(err);
            }
        },
        getRequestHandler() {
            return requestHandler;
        },
    };

    // Store the setter function on the mockServer object for factory to call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock object extension
    (mockServer as any)._setRequestHandler = (handler: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type cast for mock
        requestHandler = handler as any;
    };

    return mockServer;
};

describe('SyncServer', () => {
    let mockHttpServer: MockHttpServer;
    let mockWss: MockWss;
    let mockWssClass: ReturnType<typeof mock>;
    let mockHttpServerFactory: ReturnType<typeof mock>;

    beforeEach(() => {
        mockHttpServer = createMockHttpServer();
        mockWss = createMockWss();
        mockHttpServerFactory = mock((handler: unknown) => {
            // Capture the request handler that's passed to createHttpServer
            const mockServerWithSetter = mockHttpServer as MockHttpServer & {
                _setRequestHandler: (handler: unknown) => void
            };
            mockServerWithSetter._setRequestHandler(handler);
            return mockHttpServer;
        });
        mockWssClass = mock(() => mockWss);
    });

    const createServer = (port = 8080) => {
        return new SyncServer({
            port,
            createHttpServer:     mockHttpServerFactory as never,
            WebSocketServerClass: mockWssClass as never,
            webSocketOpenState:   1,
        });
    };

    describe('constructor', () => {
        it('stores the port', () => {
            const server = createServer(9000);
            expect(server).toBeDefined();
        });
    });

    describe('HTTP request handler', () => {
        it('returns 404 for non-/sync paths', async () => {
            const server = createServer();
            await server.start();

            const requestHandler = mockHttpServer.getRequestHandler();
            expect(requestHandler).toBeDefined();

            const mockRes = {

                writeHead: mock(() => {}),

                end: mock(() => {}),
            };

            requestHandler!({ url: '/other-path' }, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404);
            expect(mockRes.end).toHaveBeenCalledWith('Not found');
        });

        it('returns 400 for /sync path (failed WS upgrade)', async () => {
            const server = createServer();
            await server.start();

            const requestHandler = mockHttpServer.getRequestHandler();
            expect(requestHandler).toBeDefined();

            const mockRes = {

                writeHead: mock(() => {}),

                end: mock(() => {}),
            };

            requestHandler!({ url: '/sync' }, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400);
            expect(mockRes.end).toHaveBeenCalledWith('WebSocket upgrade failed');
        });

        it('handles undefined url as non-/sync', async () => {
            const server = createServer();
            await server.start();

            const requestHandler = mockHttpServer.getRequestHandler();
            expect(requestHandler).toBeDefined();

            const mockRes = {

                writeHead: mock(() => {}),

                end: mock(() => {}),
            };

            requestHandler!({}, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404);
            expect(mockRes.end).toHaveBeenCalledWith('Not found');
        });
    });

    describe('start', () => {
        it('creates HTTP server', async () => {
            const server = createServer();
            await server.start();
            expect(mockHttpServerFactory).toHaveBeenCalled();
        });

        it('creates WebSocketServer with correct options', async () => {
            const server = createServer();
            await server.start();
            expect(mockWssClass).toHaveBeenCalledWith({
                server: mockHttpServer,
                path:   '/sync',
            });
        });

        it('registers connection handler on WSS', async () => {
            const server = createServer();
            await server.start();
            expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function));
        });

        it('registers error handler on HTTP server', async () => {
            const server = createServer();
            await server.start();
            expect(mockHttpServer.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        it('starts listening on specified port', async () => {
            const server = createServer(3000);
            await server.start();
            expect(mockHttpServer.listen).toHaveBeenCalledWith(3000, expect.any(Function));
        });

        it('resolves when listen completes', async () => {
            const server = createServer();
            await server.start();
        });

        it('rejects when server emits error', async () => {
            const errorServer = createMockHttpServer();
            errorServer.listen = mock((_port: number, _callback: () => void) => {
                // Don't call callback - let error happen first
            });
            const errorFactory = mock(() => errorServer);

            const server = new SyncServer({
                port:                 8080,
                createHttpServer:     errorFactory as never,
                WebSocketServerClass: mockWssClass as never,
                webSocketOpenState:   1,
            });

            const startPromise = server.start();
            errorServer.triggerError(new Error('EADDRINUSE'));

            const startError = await startPromise.catch((e: unknown) => e);
            expect(startError).toBeInstanceOf(Error);
            expect((startError as Error).message).toContain('EADDRINUSE');
        });
    });

    describe('client connections', () => {
        it('tracks connected clients', async () => {
            const server = createServer();
            await server.start();

            expect(server.clientCount).toBe(0);

            const client = createMockClient();
            mockWss.triggerConnection(client);

            expect(server.clientCount).toBe(1);
        });

        it('does not send ready to a client that connects before signalReady is called', async () => {
            // Verifies that readyLatched starts as false: a client connecting while the
            // latch is unset must not receive 'ready' until signalReady() is called.
            const server = createServer();
            await server.start();

            const earlyClient = createMockClient(1);
            mockWss.triggerConnection(earlyClient);

            // signalReady has NOT been called — latch is false — no 'ready' yet
            expect(earlyClient.send).not.toHaveBeenCalled();
        });

        it('registers close handler on client', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient();
            mockWss.triggerConnection(client);

            expect(client.on).toHaveBeenCalledWith('close', expect.any(Function));
        });

        it('registers message handler on client', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient();
            mockWss.triggerConnection(client);

            expect(client.on).toHaveBeenCalledWith('message', expect.any(Function));
        });

        it('removes client on close', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient();

            let closeHandler: () => void = () => {};
            client.on = mock((event: string, handler: () => void) => {
                if(event === 'close') {
                    closeHandler = handler;
                }
            });

            mockWss.triggerConnection(client);
            expect(server.clientCount).toBe(1);

            closeHandler();
            expect(server.clientCount).toBe(0);
        });

        it('handles multiple clients', async () => {
            const server = createServer();
            await server.start();

            mockWss.triggerConnection(createMockClient());
            mockWss.triggerConnection(createMockClient());
            mockWss.triggerConnection(createMockClient());

            expect(server.clientCount).toBe(3);
        });
    });

    describe('signalReady', () => {
        it('sends ready to connected clients', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            mockWss.triggerConnection(client);

            server.signalReady();

            expect(client.send).toHaveBeenCalledWith('ready');
        });

        it('sends to all connected clients', async () => {
            const server = createServer();
            await server.start();

            const client1 = createMockClient(1);
            const client2 = createMockClient(1);
            mockWss.triggerConnection(client1);
            mockWss.triggerConnection(client2);

            server.signalReady();

            expect(client1.send).toHaveBeenCalledWith('ready');
            expect(client2.send).toHaveBeenCalledWith('ready');
        });

        it('skips clients not in OPEN state', async () => {
            const server = createServer();
            await server.start();

            const openClient = createMockClient(1);
            const closedClient = createMockClient(3); // CLOSED state
            mockWss.triggerConnection(openClient);
            mockWss.triggerConnection(closedClient);

            server.signalReady();

            expect(openClient.send).toHaveBeenCalledWith('ready');
            expect(closedClient.send).not.toHaveBeenCalled();
        });

        it('handles no connected clients', async () => {
            const server = createServer();
            await server.start();

            expect(() => server.signalReady()).not.toThrow();
        });

        it('ignores send errors', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            client.send = mock(() => {
                throw new Error('Send failed');
            });
            mockWss.triggerConnection(client);

            expect(() => server.signalReady()).not.toThrow();
        });

        it('delivers ready to a client that connects after signalReady (late-connection latch)', async () => {
            // This is the race scenario: runner calls signalReady() before the preload's
            // WebSocket handshake completes and lands in this.clients. Without the latch
            // the 'ready' message is sent to zero clients and the preload stalls for 500ms.
            const server = createServer();
            await server.start();

            // Signal ready before any client is connected
            server.signalReady();

            // Now a client connects late (after signalReady)
            const lateClient = createMockClient(1); // readyState OPEN
            mockWss.triggerConnection(lateClient);

            // The connection handler must immediately send 'ready' to the late client
            expect(lateClient.send).toHaveBeenCalledWith('ready');
        });

        it('does not send ready to a late-connecting client in non-OPEN state', async () => {
            const server = createServer();
            await server.start();

            server.signalReady();

            // Client that connects but is not yet in OPEN state (edge case)
            const connectingClient = createMockClient(0); // readyState CONNECTING
            mockWss.triggerConnection(connectingClient);

            expect(connectingClient.send).not.toHaveBeenCalled();
        });

        it('ignores send errors for late-connecting clients', async () => {
            const server = createServer();
            await server.start();

            server.signalReady();

            const lateClient = createMockClient(1);
            lateClient.send = mock(() => {
                throw new Error('Send failed');
            });

            expect(() => mockWss.triggerConnection(lateClient)).not.toThrow();
        });

        it('is idempotent: multiple signalReady calls do not error', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            mockWss.triggerConnection(client);

            expect(() => {
                server.signalReady();
                server.signalReady();
            }).not.toThrow();
        });
    });

    describe('readyLatched reset on close', () => {
        it('resets the latch so a reused server does not send ready on first connection', async () => {
            const server = createServer();
            await server.start();

            // Signal ready and then close — this should reset the latch
            server.signalReady();
            await server.close();

            // Restart the server
            await server.start();

            // A client connecting after restart must NOT get a spurious 'ready'
            const freshClient = createMockClient(1);
            mockWss.triggerConnection(freshClient);

            expect(freshClient.send).not.toHaveBeenCalled();
        });
    });

    describe('close', () => {
        it('closes all client connections', async () => {
            const server = createServer();
            await server.start();

            const client1 = createMockClient();
            const client2 = createMockClient();
            mockWss.triggerConnection(client1);
            mockWss.triggerConnection(client2);

            await server.close();

            expect(client1.close).toHaveBeenCalled();
            expect(client2.close).toHaveBeenCalled();
        });

        it('ignores client close errors', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient();
            client.close = mock(() => {
                throw new Error('Already closed');
            });
            mockWss.triggerConnection(client);

            await server.close();
        });

        it('clears client count', async () => {
            const server = createServer();
            await server.start();

            mockWss.triggerConnection(createMockClient());
            expect(server.clientCount).toBe(1);

            await server.close();
            expect(server.clientCount).toBe(0);
        });

        it('closes WebSocketServer', async () => {
            const server = createServer();
            await server.start();

            await server.close();

            expect(mockWss.close).toHaveBeenCalled();
        });

        it('closes HTTP server', async () => {
            const server = createServer();
            await server.start();

            await server.close();

            expect(mockHttpServer.close).toHaveBeenCalled();
        });

        it('is safe to call multiple times', async () => {
            const server = createServer();
            await server.start();

            await server.close();
            await server.close();
        });

        it('is safe to call before start', async () => {
            const server = createServer();
            await server.close();
        });
    });

    describe('clientCount', () => {
        it('returns number of connected clients', async () => {
            const server = createServer();
            await server.start();

            expect(server.clientCount).toBe(0);

            mockWss.triggerConnection(createMockClient());
            expect(server.clientCount).toBe(1);

            mockWss.triggerConnection(createMockClient());
            expect(server.clientCount).toBe(2);
        });
    });
});
