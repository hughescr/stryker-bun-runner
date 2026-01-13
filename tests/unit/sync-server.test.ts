/**
 * Unit tests for utils/sync-server
 * Tests WebSocket synchronization server
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SyncServer } from '../../src/utils/sync-server.js';

// Mock getAvailablePort to return predictable, widely-spaced ports
// Use atomic counter with immediate return to avoid race conditions
let nextPort = 50000;
mock.module('../../src/utils/port.js', () => ({
  getAvailablePort: () => Promise.resolve(nextPort++)
}));

import { getAvailablePort } from '../../src/utils/port.js';

// Skip: These tests require real WebSocket connections and Bun.serve() which are blocked in sandbox mode.
// Run manually with: bun test tests/unit/sync-server.test.ts --no-sandbox
describe.skip('SyncServer', () => {
  let server: SyncServer;
  let testPort: number;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  describe('initialization', () => {
    it('should create server with specified port', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      expect(server).toBeDefined();
    });

    it('should use default timeout when not specified', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      expect(server).toBeDefined();
    });

    it('should accept custom timeout', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort, timeout: 10000 });
      expect(server).toBeDefined();
    });
  });

  describe('start', () => {
    it('should start server successfully', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await expect(server.start()).resolves.toBeUndefined();
    });

    it('should reject if port is already in use', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();

      // Try to start another server on same port
      const server2 = new SyncServer({ port: testPort });
      await expect(server2.start()).rejects.toThrow();
      await server2.close();
    });
  });

  describe('client connections', () => {
    beforeEach(async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();
    });

    it('should accept WebSocket connections', async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.close();
          resolve();
        };
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Connection timeout')), 1000);
      });
    });

    it('should track connected clients', async () => {
      expect(server.clientCount).toBe(0);

      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          // Give server a moment to register the client
          setTimeout(() => {
            expect(server.clientCount).toBe(1);
            ws.close();
            resolve();
          }, 50);
        };
      });

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.clientCount).toBe(0);
    });

    it('should handle multiple simultaneous connections', async () => {
      const ws1 = new WebSocket(`ws://localhost:${testPort}/sync`);
      const ws2 = new WebSocket(`ws://localhost:${testPort}/sync`);

      await Promise.all([
        new Promise<void>((resolve) => {
          ws1.onopen = () => resolve();
        }),
        new Promise<void>((resolve) => {
          ws2.onopen = () => resolve();
        }),
      ]);

      // Give server a moment to register clients
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.clientCount).toBe(2);

      ws1.close();
      ws2.close();
    });

    it('should reject connections to wrong path', async () => {
      const response = await fetch(`http://localhost:${testPort}/wrong-path`);
      expect(response.status).toBe(404);
    });
  });

  describe('signalReady', () => {
    beforeEach(async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();
    });

    it('should send ready message to connected clients', async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      const messageReceived = new Promise<string>((resolve) => {
        ws.onmessage = (event) => {
          resolve(event.data);
        };
      });

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      server.signalReady();

      const message = await messageReceived;
      expect(message).toBe('ready');

      ws.close();
    });

    it('should send ready to all connected clients', async () => {
      const ws1 = new WebSocket(`ws://localhost:${testPort}/sync`);
      const ws2 = new WebSocket(`ws://localhost:${testPort}/sync`);

      const message1 = new Promise<string>((resolve) => {
        ws1.onmessage = (event) => resolve(event.data);
      });

      const message2 = new Promise<string>((resolve) => {
        ws2.onmessage = (event) => resolve(event.data);
      });

      await Promise.all([
        new Promise<void>((resolve) => {
          ws1.onopen = () => resolve();
        }),
        new Promise<void>((resolve) => {
          ws2.onopen = () => resolve();
        }),
      ]);

      server.signalReady();

      const [msg1, msg2] = await Promise.all([message1, message2]);
      expect(msg1).toBe('ready');
      expect(msg2).toBe('ready');

      ws1.close();
      ws2.close();
    });

    it('should not throw if no clients connected', () => {
      expect(() => server.signalReady()).not.toThrow();
    });

    it('should gracefully handle disconnected clients', async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Close client before signaling
      ws.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not throw
      expect(() => server.signalReady()).not.toThrow();
    });
  });

  describe('close', () => {
    it('should close server successfully', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();
      await expect(server.close()).resolves.toBeUndefined();
    });

    it('should close all client connections', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      const closedPromise = new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      await server.close();
      await closedPromise;
    });

    it('should clear client count after closing', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.clientCount).toBeGreaterThan(0);

      await server.close();
      expect(server.clientCount).toBe(0);
    });

    it('should be safe to call close multiple times', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();

      await server.close();
      await expect(server.close()).resolves.toBeUndefined();
    });

    it('should allow restarting on same port after close', async () => {
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();
      await server.close();

      const server2 = new SyncServer({ port: testPort });
      await expect(server2.start()).resolves.toBeUndefined();
      await server2.close();
    });
  });

  describe('integration scenario', () => {
    it('should complete full sync workflow', async () => {
      // Start server
      testPort = await getAvailablePort();
      server = new SyncServer({ port: testPort });
      await server.start();

      // Client connects
      const ws = new WebSocket(`ws://localhost:${testPort}/sync`);

      const readyReceived = new Promise<boolean>((resolve) => {
        ws.onmessage = (event) => {
          if (event.data === 'ready') {
            resolve(true);
          }
        };
      });

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      expect(server.clientCount).toBeGreaterThan(0);

      // Server signals ready
      server.signalReady();

      // Client receives ready
      const received = await readyReceived;
      expect(received).toBe(true);

      // Client closes
      ws.close();

      // Server closes
      await server.close();
      expect(server.clientCount).toBe(0);
    });
  });
});
