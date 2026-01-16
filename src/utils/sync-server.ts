/**
 * WebSocket synchronization server
 * Used to coordinate inspector connection with test execution
 */

import { createServer } from 'node:http';
import type { Server as HTTPServer } from 'node:http';
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
        return new Promise((resolve, reject) => {
            try {
                // Create HTTP server to handle WebSocket upgrades and 404s
                this.httpServer = this.createHttpServer((req, res) => {
                    // Non-WebSocket requests get 404
                    if(req.url !== '/sync') {
                        res.writeHead(404);
                        res.end('Not found');
                    } else {
                        // WebSocket upgrade requests should be handled by ws
                        res.writeHead(400);
                        res.end('WebSocket upgrade failed');
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
   * Signal all connected clients that they can proceed
   */
    signalReady(): void {
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
   * Send test start event to all connected clients
   */
    sendTestStart(testName: string): void {
        const message = JSON.stringify({ type: 'testStart', name: testName });
        for(const client of this.clients) {
            try {
                if(client.readyState === this.webSocketOpenState) {
                    client.send(message);
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
            this.wss.close();
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
