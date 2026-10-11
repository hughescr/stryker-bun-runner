/**
 * Unit tests for utils/sync-server
 * Tests WebSocket synchronization server using mock injection
 * (tests/00-integration/sync-server-socket-integration.test.ts runs it on a real socket)
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

/**
 * Captures the handler registered via `client.on(event, handler)` for the
 * given event name, so tests can trigger it directly — mirrors the
 * `closeHandler` capture pattern already used below for the 'close' event.
 */
function captureHandler(client: MockClient, event: string): (...args: unknown[]) => void {
    let captured: (...args: unknown[]) => void = () => {};
    client.on = mock((evt: string, handler: (...args: unknown[]) => void) => {
        if(evt === event) {
            captured = handler;
        }
    });
    return (...args: unknown[]) => captured(...args);
}

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
    address:           ReturnType<typeof mock>
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
        listen: mock((_port: number, _host: string, callback: () => void) => {
            setImmediate(callback);
        }),
        // The port the OS assigned for listen(0, ...).
        address: mock(() => ({ address: '127.0.0.1', family: 'IPv4', port: 41_234 })),
        close:   mock((callback?: () => void) => {
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

    const createServer = () => {
        return new SyncServer({
            createHttpServer:     mockHttpServerFactory as never,
            WebSocketServerClass: mockWssClass as never,
            webSocketOpenState:   1,
        });
    };

    describe('port', () => {
        it('is the port the server is listening on, once started', async () => {
            const server = createServer();
            await server.start();

            expect(server.port).toBe(41_234);
        });

        it('throws before the server has started, rather than handing out a port nobody listens on', () => {
            expect(() => createServer().port).toThrow('the sync server is not listening yet');
        });
    });

    describe('token', () => {
        /** Start `server` and return whether the verifyClient it hands the WebSocketServer accepts each upgrade URL. */
        async function verifierOf(server: SyncServer): Promise<(url: string | undefined) => boolean> {
            await server.start();
            const [options] = mockWssClass.mock.calls[0] as [{ verifyClient: (info: { req: { url?: string } }) => boolean }];
            return url => options.verifyClient({ req: { url } });
        }

        it('is 32 random hex characters, different for every server', () => {
            const first = createServer().token;
            const second = createServer().token;

            expect(first).toMatch(/^[\da-f]{32}$/);
            expect(second).toMatch(/^[\da-f]{32}$/);
            expect(first).not.toBe(second);
        });

        it('accepts an upgrade to /sync/<its token>', async () => {
            const server = createServer();
            const accepts = await verifierOf(server);
            expect(accepts(`/sync/${server.token}`)).toBe(true);
        });

        it('refuses an upgrade carrying another token of the same length, as another run\'s child would', async () => {
            const server = createServer();
            const accepts = await verifierOf(server);
            const other = server.token.replace(/^./, c => (c === '0' ? '1' : '0'));
            expect(accepts(`/sync/${other}`)).toBe(false);
        });

        it('refuses an upgrade with no token, or with anything around it', async () => {
            const server = createServer();
            const accepts = await verifierOf(server);
            const token = server.token;
            for(const url of ['/sync', '/sync/', `/sync/${token}x`, `/sync/${token}?a=1`, `/x/sync/${token}`, `/sync/${token.slice(1)}`, undefined]) {
                expect(accepts(url)).toBe(false);
            }
        });

        it('leaves the path to verifyClient, so ws does not accept /sync without a token', async () => {
            await createServer().start();
            const [options] = mockWssClass.mock.calls[0] as [{ path?: string }];
            expect(options.path).toBeUndefined();
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
                server:       mockHttpServer,
                verifyClient: expect.any(Function),
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

        it('listens on port 0, so the OS picks a port that is free when it binds', async () => {
            // A port probed free in advance and released again can be taken by another
            // process before the server binds it.
            const server = createServer();
            await server.start();
            expect(mockHttpServer.listen).toHaveBeenCalledWith(0, expect.any(String), expect.any(Function));
        });

        it('binds loopback only (127.0.0.1), never all interfaces', async () => {
            const server = createServer();
            await server.start();
            expect(mockHttpServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
        });

        it('resolves when listen completes', async () => {
            const server = createServer();
            await server.start();
        });

        it('rejects when server emits error', async () => {
            const errorServer = createMockHttpServer();
            errorServer.listen = mock((_port: number, _host: string, _callback: () => void) => {
                // Don't call callback - let error happen first
            });
            const errorFactory = mock(() => errorServer);

            const server = new SyncServer({
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

        it('rejects with the very error a synchronous setup step throws', async () => {
            const thrown = new RangeError('port out of range');
            mockHttpServer.listen = mock(() => {
                throw thrown;
            });

            const startError = await createServer().start().catch((e: unknown) => e);

            expect(startError).toBe(thrown);
        });

        it('rejects with an Error carrying the text when a synchronous setup step throws a non-Error', async () => {
            const throwingFactory = mock(() => {
                // The case under test: a non-Error throw.
                throw 'no server for you';
            });
            const server = new SyncServer({
                createHttpServer:     throwingFactory,
                WebSocketServerClass: mockWssClass as never,
                webSocketOpenState:   1,
            });

            const startError = await server.start().catch((e: unknown) => e);

            expect(startError).toBeInstanceOf(Error);
            expect((startError as Error).message).toBe('no server for you');
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

    describe('drain handshake', () => {
        it('registers message handler on client (drain-request listener)', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient();
            mockWss.triggerConnection(client);

            expect(client.on).toHaveBeenCalledWith('message', expect.any(Function));
        });

        it('holds a drain-request that arrives before any handler is registered, without replying', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            expect(() => messageHandler(Buffer.from('drain-request'))).not.toThrow();
            await Promise.resolve();
            await Promise.resolve();
            expect(client.send).not.toHaveBeenCalled();
        });

        it('serves a drain-request that arrived before the handler as soon as the handler is registered', async () => {
            // The child can send drain-request before the runner has registered its
            // handler (a slow TestReporter.enable round trip). Dropping it left the
            // child waiting for a 'drained' that never came.
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);
            messageHandler(Buffer.from('drain-request'));

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);
            expect(drainHandler).toHaveBeenCalledTimes(1);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.send).toHaveBeenCalledWith('drained');
        });

        it('serves every client queued before registration with a single handler invocation', async () => {
            const server = createServer();
            await server.start();

            const first = createMockClient(1);
            const firstMessage = captureHandler(first, 'message');
            mockWss.triggerConnection(first);
            const second = createMockClient(1);
            const secondMessage = captureHandler(second, 'message');
            mockWss.triggerConnection(second);
            firstMessage(Buffer.from('drain-request'));
            secondMessage(Buffer.from('drain-request'));

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);
            expect(first.send).toHaveBeenCalledWith('drained');
            expect(second.send).toHaveBeenCalledWith('drained');
        });

        it('serves a queued request only once, even when the handler is registered again', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);
            messageHandler(Buffer.from('drain-request'));

            server.setDrainHandler(mock(() => Promise.resolve()));
            const laterHandler = mock(() => Promise.resolve());
            server.setDrainHandler(laterHandler);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(laterHandler).not.toHaveBeenCalled();
            expect(client.send).toHaveBeenCalledTimes(1);
        });

        it('queues a client once however often it repeats drain-request before the handler exists', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);
            messageHandler(Buffer.from('drain-request'));
            messageHandler(Buffer.from('drain-request'));
            messageHandler(Buffer.from('drain-request'));

            server.setDrainHandler(mock(() => Promise.resolve()));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.send.mock.calls).toEqual([['drained']]);
        });

        it('drops a queued client when it closes, so the handler is not even invoked for it', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const handlers = new Map<string, (...args: unknown[]) => void>();
            client.on = mock((event: string, handler: (...args: unknown[]) => void) => {
                handlers.set(event, handler);
            });
            mockWss.triggerConnection(client);
            handlers.get('message')?.(Buffer.from('drain-request'));
            handlers.get('close')?.();

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).not.toHaveBeenCalled();
            expect(client.send).not.toHaveBeenCalled();
        });

        it('keeps other queued clients when one of them closes', async () => {
            const server = createServer();
            await server.start();

            const leaving = createMockClient(1);
            const leavingHandlers = new Map<string, (...args: unknown[]) => void>();
            leaving.on = mock((event: string, handler: (...args: unknown[]) => void) => {
                leavingHandlers.set(event, handler);
            });
            mockWss.triggerConnection(leaving);
            const staying = createMockClient(1);
            const stayingMessage = captureHandler(staying, 'message');
            mockWss.triggerConnection(staying);
            leavingHandlers.get('message')?.(Buffer.from('drain-request'));
            stayingMessage(Buffer.from('drain-request'));
            leavingHandlers.get('close')?.();

            server.setDrainHandler(mock(() => Promise.resolve()));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(staying.send).toHaveBeenCalledWith('drained');
            expect(leaving.send).not.toHaveBeenCalled();
        });

        it('does not invoke a handler on registration when no request is queued, including on re-registration', async () => {
            const server = createServer();
            await server.start();

            const firstHandler = mock(() => Promise.resolve());
            const secondHandler = mock(() => Promise.resolve());
            server.setDrainHandler(firstHandler);
            server.setDrainHandler(secondHandler);
            await Promise.resolve();

            expect(firstHandler).not.toHaveBeenCalled();
            expect(secondHandler).not.toHaveBeenCalled();
        });

        it('does not reply drained to a queued client that closed before the handler was registered', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);
            messageHandler(Buffer.from('drain-request'));
            client.readyState = 3; // CLOSED

            server.setDrainHandler(mock(() => Promise.resolve()));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.send).not.toHaveBeenCalled();
        });

        it('forgets queued drain-requests on close, so a reused server never serves a client of the previous run', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);
            messageHandler(Buffer.from('drain-request'));

            await server.close();
            await server.start();
            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).not.toHaveBeenCalled();
            expect(client.send).not.toHaveBeenCalledWith('drained');
        });

        it('ignores messages other than drain-request', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);

            messageHandler(Buffer.from('something-else'));
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).not.toHaveBeenCalled();
        });

        it('invokes the drain handler and replies drained on resolve', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);

            messageHandler(Buffer.from('drain-request'));
            // Flush microtasks so the async IIFE inside handleDrainRequest settles.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);
            expect(client.send).toHaveBeenCalledWith('drained');
        });

        it('recognizes drain-request delivered as an ArrayBuffer payload', async () => {
            // Exercises rawDataToString's ArrayBuffer branch specifically — a plain
            // Buffer (used elsewhere in this file) would never take this path, since
            // Buffer.isBuffer() is true for Buffers but not for a bare ArrayBuffer.
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);

            const arrayBuffer = Uint8Array.from(Buffer.from('drain-request')).buffer;
            messageHandler(arrayBuffer);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);
            expect(client.send).toHaveBeenCalledWith('drained');
        });

        it('recognizes drain-request delivered as a fragmented Buffer[] payload', async () => {
            // Exercises rawDataToString's Buffer[] branch specifically — 'ws' delivers
            // a fragmented message this way; Buffer.concat must reassemble it correctly
            // before the 'drain-request' string comparison.
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);

            const fragments = [Buffer.from('drain-'), Buffer.from('request')];
            messageHandler(fragments);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);
            expect(client.send).toHaveBeenCalledWith('drained');
        });

        it('does not reply when the drain handler rejects', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.reject(new Error('inspector round-trip timed out')));
            server.setDrainHandler(drainHandler);

            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);
            expect(client.send).not.toHaveBeenCalledWith('drained');
        });

        it('does not throw when replying drained on a client that errors on send', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);
            client.send = mock(() => {
                throw new Error('Send failed');
            });

            server.setDrainHandler(mock(() => Promise.resolve()));

            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.send).toHaveBeenCalledWith('drained');
        });

        it('does not reply drained to a client that is no longer in OPEN state', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            server.setDrainHandler(mock(() => {
                // Simulate the client disconnecting while the drain handler is in flight.
                client.readyState = 3; // CLOSED
                return Promise.resolve();
            }));

            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.send).not.toHaveBeenCalledWith('drained');
        });

        it('shares the same in-flight promise across re-entrant drain-request messages', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            let resolveDrain: () => void = () => {};
            const drainHandler = mock(() => new Promise<void>((resolve) => {
                resolveDrain = resolve;
            }));
            server.setDrainHandler(drainHandler);

            // Two 'drain-request' messages arrive before the handler has resolved.
            messageHandler(Buffer.from('drain-request'));
            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);

            resolveDrain();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(client.send).toHaveBeenCalledWith('drained');
        });

        it('does not re-invoke the drain handler for a repeat request after a prior one resolved (until close() resets state)', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);

            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(drainHandler).toHaveBeenCalledTimes(1);

            // NOTE: without a close() in between, drainInFlight is only reset by
            // close() — see 'resets drain handler/in-flight state on close' below.
            // A second request while no NEW in-flight promise has been created
            // reuses the (already-resolved) prior one rather than re-invoking.
            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();
            await Promise.resolve();

            expect(drainHandler).toHaveBeenCalledTimes(1);
        });

        it('resets drain handler and in-flight state on close, so a reused server does not auto-reply on the next request', async () => {
            const server = createServer();
            await server.start();

            const client = createMockClient(1);
            const messageHandler = captureHandler(client, 'message');
            mockWss.triggerConnection(client);

            const drainHandler = mock(() => Promise.resolve());
            server.setDrainHandler(drainHandler);

            messageHandler(Buffer.from('drain-request'));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(drainHandler).toHaveBeenCalledTimes(1);

            await server.close();
            await server.start();

            const freshClient = createMockClient(1);
            const freshMessageHandler = captureHandler(freshClient, 'message');
            mockWss.triggerConnection(freshClient);

            // No handler registered on the fresh server instance state — a
            // drain-request must not throw and must not reply.
            expect(() => freshMessageHandler(Buffer.from('drain-request'))).not.toThrow();
            await Promise.resolve();
            expect(freshClient.send).not.toHaveBeenCalledWith('drained');
            expect(drainHandler).toHaveBeenCalledTimes(1);
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

describe('preload sync dial address', () => {
    it('dials the literal loopback address the server binds (127.0.0.1), not "localhost"', async () => {
        // The preload dials through awaitRunnerReady in preload-logic; the template itself dials nothing.
        const template = await Bun.file(new URL('../../src/templates/coverage-preload.ts', import.meta.url)).text();
        const preloadLogic = await Bun.file(new URL('../../src/coverage/preload-logic.ts', import.meta.url)).text();
        expect(template).not.toContain('ws://');
        expect(preloadLogic).not.toContain('ws://localhost:');
        expect(preloadLogic.match(/ws:\/\/127\.0\.0\.1:\$\{syncPort\}\/sync/g)).toHaveLength(1);
    });
});
