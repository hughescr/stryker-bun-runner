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
  port: number;

  /**
   * Timeout in milliseconds for client connections
   * @default 5000
   */
  timeout?: number;
}

/**
 * Simple WebSocket synchronization server
 * Allows preload script to wait for "ready" signal before proceeding with tests
 */
export class SyncServer {
  private httpServer: HTTPServer | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private readonly port: number;

  constructor(options: SyncServerOptions) {
    this.port = options.port;
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server to handle WebSocket upgrades and 404s
        this.httpServer = createServer((req, res) => {
          // Non-WebSocket requests get 404
          if (req.url !== '/sync') {
            res.writeHead(404);
            res.end('Not found');
          } else {
            // WebSocket upgrade requests should be handled by ws
            res.writeHead(400);
            res.end('WebSocket upgrade failed');
          }
        });

        // Create WebSocket server attached to HTTP server
        this.wss = new WebSocketServer({
          server: this.httpServer,
          path: '/sync',
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
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Signal all connected clients that they can proceed
   */
  signalReady(): void {
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send('ready');
        }
      } catch (error) {
        // Ignore send errors - client may have disconnected
      }
    }
  }

  /**
   * Close the server and all client connections
   */
  async close(): Promise<void> {
    // Close all client connections
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // Ignore errors
      }
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Stop HTTP server
    if (this.httpServer) {
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
