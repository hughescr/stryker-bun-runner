/**
 * WebSocket synchronization server
 * Used to coordinate inspector connection with test execution
 */

import { createServer, type Server as HTTPServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export interface SyncServerOptions {
    /**
   * Port to listen on
   */
    port: number

    /**
   * Timeout in milliseconds for client connections
   * @default 5000
   */
    timeout?: number

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
    private readonly port:                 number;
    private readonly createHttpServer:     typeof createServer;
    private readonly WebSocketServerClass: typeof WebSocketServer;
    private readonly webSocketOpenState:   number;

    constructor(options: SyncServerOptions) {
        this.port = options.port;
        this.createHttpServer = options.createHttpServer ?? createServer;
        this.WebSocketServerClass = options.WebSocketServerClass ?? WebSocketServer;
        this.webSocketOpenState = options.webSocketOpenState ?? WebSocket.OPEN;
    }

    /**
   * Start the WebSocket server
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
                    });

                    // Ignore messages from clients - this is a one-way signal server
                    ws.on('message', () => {
                        // No-op
                    });
                });

                // Handle server errors
                this.httpServer.on('error', reject);

                // Start listening
                // Stryker disable next-line BlockStatement: removing listen callback body means resolve() never called → start() never resolves → Timeout
                this.httpServer.listen(this.port, () => {
                    resolve();
                });
            // eslint-disable-next-line @stylistic/brace-style -- required for Stryker disable to work
            }
            // Stryker disable all: defensive error handling, rejects promise
            catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
            // Stryker restore all
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
   * Close the server and all client connections
   */
    async close(): Promise<void> {
        // Reset the ready latch so the instance can be reused across runs
        this.readyLatched = false;

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
