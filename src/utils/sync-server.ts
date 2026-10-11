/**
 * WebSocket synchronization server
 * Used to coordinate inspector connection with test execution
 */

import { createServer, type Server as HTTPServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

/**
 * Decode a 'ws' message payload as UTF-8 text. RawData is a union of
 * Buffer | ArrayBuffer | Buffer[] (the last for fragmented messages) — calling
 * `.toString()` directly on the union risks the default Object stringification
 * ('[object ArrayBuffer]') for the ArrayBuffer case, so each case is decoded
 * explicitly instead.
 */
function rawDataToString(data: RawData): string {
    if(Array.isArray(data)) {
        return Buffer.concat(data).toString('utf8');
    }
    return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

export interface SyncServerOptions {
    /**
   * Optional HTTP server factory for dependency injection (testing)
   * @default createServer
   */
    createHttpServer?: typeof createServer

    /**
   * Optional WebSocketServer class for dependency injection (testing)
   * @default WebSocketServer
   */
    WebSocketServerClass?: typeof WebSocketServer

    /**
   * Optional WebSocket OPEN state constant for dependency injection (testing)
   * @default WebSocket.OPEN
   */
    webSocketOpenState?: number
}

/**
 * Simple WebSocket synchronization server
 * Allows preload script to wait for "ready" signal before proceeding with tests
 */
export class SyncServer {
    private httpServer:                    HTTPServer | null = null;
    private wss:                           WebSocketServer | null = null;
    private clients = new Set<WebSocket>();
    private readyLatched =                 false;
    private listeningPort:                 number | undefined;
    private readonly createHttpServer:     typeof createServer;
    private readonly WebSocketServerClass: typeof WebSocketServer;
    private readonly webSocketOpenState:   number;

    /**
   * Optional callback registered via {@link setDrainHandler}, invoked when a
   * client sends the string 'drain-request'. This is the mechanism that
   * proves the inspector WebSocket stream has been fully drained before the
   * test child process is allowed to exit — without it, the child could
   * exit before the parent has processed the last inspector events under
   * CPU contention, truncating the stream.
   */
    private drainHandler: (() => Promise<void>) | null = null;

    /**
   * The in-flight promise from the current/most-recent drain handler
   * invocation. Shared across re-entrant 'drain-request' messages so a
   * retried request never re-invokes the handler — see
   * {@link handleDrainRequest}.
   */
    private drainInFlight: Promise<void> | null = null;

    /**
   * Clients whose 'drain-request' arrived before {@link setDrainHandler} was
   * called. They are served as soon as a handler is registered: dropping such a
   * request would leave the child waiting for a 'drained' that never comes.
   * A Set, so a client that repeats its request is queued once; a client that
   * closes is removed, since there is no one left to answer.
   */
    private pendingDrainClients = new Set<WebSocket>();

    constructor(options: SyncServerOptions = {}) {
        this.createHttpServer = options.createHttpServer ?? createServer;
        this.WebSocketServerClass = options.WebSocketServerClass ?? WebSocketServer;
        this.webSocketOpenState = options.webSocketOpenState ?? WebSocket.OPEN;
    }

    /**
   * The loopback port the server is listening on, which the OS chose when
   * {@link start} bound it. Throws before then: there is no port to hand out.
   */
    get port(): number {
        if(this.listeningPort === undefined) {
            throw new Error('the sync server is not listening yet');
        }
        return this.listeningPort;
    }

    /**
   * Start the WebSocket server on a free loopback port; see {@link port}.
   */
    async start(): Promise<void> {
        // Stryker disable next-line BlockStatement: removing Promise body means resolve() never called → start() never resolves → Timeout
        return new Promise((resolve, reject) => {
            // Stryker disable next-line BlockStatement: removing try body means httpServer/wss never created and resolve() never called → start() never resolves → Timeout
            try {
                // Create HTTP server to handle WebSocket upgrades and 404s
                this.httpServer = this.createHttpServer((req, res) => {
                    if(req.url === '/sync') {
                        // WebSocket upgrade requests should be handled by ws
                        res.writeHead(400);
                        res.end('WebSocket upgrade failed');
                    } else {
                        // Non-WebSocket requests get 404
                        res.writeHead(404);
                        res.end('Not found');
                    }
                });

                // Create WebSocket server attached to HTTP server
                this.wss = new this.WebSocketServerClass({
                    server: this.httpServer,
                    path:   '/sync',
                });

                // Track client connections
                this.wss.on('connection', (ws) => {
                    this.clients.add(ws);

                    // If ready was already signalled before this client connected,
                    // deliver the latch immediately so the preload doesn't stall.
                    if(this.readyLatched && ws.readyState === this.webSocketOpenState) {
                        try {
                            ws.send('ready');
                        } catch{
                            // Ignore send errors - client may have disconnected
                        }
                    }

                    ws.on('close', () => {
                        this.clients.delete(ws);
                        this.pendingDrainClients.delete(ws);
                    });

                    // Only one inbound message type is understood: 'drain-request' (see
                    // setDrainHandler / handleDrainRequest). Anything else is ignored —
                    // this remains otherwise a one-way (server-to-client) signal server.
                    ws.on('message', (data) => {
                        if(rawDataToString(data) === 'drain-request') {
                            this.handleDrainRequest(ws);
                        }
                    });
                });

                // Handle server errors
                this.httpServer.on('error', reject);

                // Start listening. Bind to loopback only (never all interfaces): the
                // sync channel is a local control signal and must not be reachable from
                // other hosts. 127.0.0.1 matches the inspector (--inspect=127.0.0.1:0),
                // and the preload dials the same literal address. Port 0: the OS picks a
                // port that is free as it binds; a port probed free beforehand and
                // released could be taken by another process first. {@link port} reads
                // back what was bound, for the child's environment.
                const httpServer = this.httpServer;
                // Stryker disable next-line BlockStatement: removing listen callback body means resolve() never called → start() never resolves → Timeout
                httpServer.listen(0, '127.0.0.1', () => {
                    this.listeningPort = (httpServer.address() as AddressInfo).port;
                    resolve();
                });
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
   * Signal all connected clients that they can proceed.
   * After this call the ready state is latched: any client that connects
   * later will receive the 'ready' message immediately upon connection.
   */
    signalReady(): void {
        this.readyLatched = true;
        for(const client of this.clients) {
            try {
                if(client.readyState === this.webSocketOpenState) {
                    client.send('ready');
                }
            } catch{
                // Ignore send errors - client may have disconnected
            }
        }
    }

    /**
   * Register the async callback that proves the inspector stream has
   * drained. This handshake exists so the test child process is only
   * allowed to exit once the parent has confirmed it has fully processed
   * every inspector event, preventing a truncation/data-loss race where the
   * child exits first under CPU contention. When a connected client sends
   * the string 'drain-request', the handler is invoked; once its returned
   * promise resolves, the string 'drained' is sent back on that same client
   * socket. If the handler rejects (including a caller-imposed timeout
   * inside the handler itself), nothing is sent back — the preload's own
   * bounded wait is the fallback, so a broken/slow handler degrades to
   * today's behavior rather than hanging.
   *
   * A 'drain-request' that arrived before this call was queued, not dropped,
   * and is served here.
   */
    setDrainHandler(handler: () => Promise<void>): void {
        this.drainHandler = handler;
        const pending = this.pendingDrainClients;
        this.pendingDrainClients = new Set();
        for(const ws of pending) {
            this.handleDrainRequest(ws);
        }
    }

    /**
   * Handle an inbound 'drain-request' message from a client. Re-entrant: a
   * second 'drain-request' (e.g. a retry) while one is already in flight
   * shares the same in-flight promise rather than invoking the handler
   * again. Before a handler is registered the request is queued for
   * {@link setDrainHandler} to serve.
   */
    private handleDrainRequest(ws: WebSocket): void {
        if(!this.drainHandler) {
            this.pendingDrainClients.add(ws);
            return;
        }

        this.drainInFlight ??= this.drainHandler();
        const inFlight = this.drainInFlight;

        void (async () => {
            try {
                await inFlight;
            } catch{
                // Drain handler rejected (or its own timeout fired) — send nothing;
                // the preload's bounded wait falls through to today's behavior.
                return;
            }

            try {
                if(ws.readyState === this.webSocketOpenState) {
                    ws.send('drained');
                }
            } catch{
                // Ignore send errors - client may have disconnected
            }
        })();
    }

    /**
   * Close the server and all client connections
   */
    async close(): Promise<void> {
        // Reset the ready latch so the instance can be reused across runs
        this.readyLatched = false;
        this.drainHandler = null;
        this.drainInFlight = null;
        this.pendingDrainClients = new Set();

        // Close all client connections
        for(const client of this.clients) {
            try {
                client.close();
            } catch{
                // Ignore errors
            }
        }
        this.clients.clear();

        // Close WebSocket server
        if(this.wss) {
            await new Promise<void>((resolve) => {
                this.wss!.close(() => resolve());
            });
            this.wss = null;
        }

        // Stop HTTP server
        if(this.httpServer) {
            await new Promise<void>((resolve) => {
                this.httpServer!.close(() => {
                    resolve();
                });
            });
            this.httpServer = null;
        }
    }

    /**
   * Get the number of connected clients
   */
    get clientCount(): number {
        return this.clients.size;
    }
}
