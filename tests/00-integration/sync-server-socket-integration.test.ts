/**
 * The sync server on a real loopback socket: a client that dials it with the
 * run's token reaches it, and one dialing any other path is refused.
 *
 * Every wait here is on an event (listening, open, a message, the refused
 * upgrade). Real sockets still need real time underneath those events: bun
 * 1.4.0 emits a server's 'listening' from a 1 ms timer of its own (node:http,
 * node:net), so timers scheduled outside tests/ run on real time in this file.
 * A timer scheduled by the tests themselves still fails them.
 */

import { once } from 'node:events';
import { describe, it, expect } from 'bun:test';
import { WebSocket } from 'ws';
import { SyncServer } from '../../src/utils/sync-server.js';
import { allowRealTimersFromSource } from '../real-clock-guard.js';

allowRealTimersFromSource();

describe('SyncServer on a real socket', () => {
    it('refuses a client dialing another token: its upgrade is answered 401 and never opens', async () => {
        const server = new SyncServer();
        await server.start();
        try {
            const client = new WebSocket(`ws://127.0.0.1:${server.port}/sync/${'0'.repeat(32)}`);
            const [, response] = await once(client, 'unexpected-response') as [unknown, { statusCode: number }];

            expect(response.statusCode).toBe(401);
            expect(server.clientCount).toBe(0);
            client.terminate();
        } finally {
            await server.close();
        }
    });

    it('reports the port the OS gave it, and a client dialing that port with its token reaches it', async () => {
        const server = new SyncServer();
        await server.start();
        try {
            expect(server.port).toBeGreaterThan(0);

            const client = new WebSocket(`ws://127.0.0.1:${server.port}/sync/${server.token}`);
            const received = new Promise<string>((resolve, reject) => {
                client.on('message', (data: Buffer) => resolve(data.toString('utf8')));
                client.on('error', reject);
            });
            await once(client, 'open');
            server.signalReady();

            expect(await received).toBe('ready');
            client.close();
        } finally {
            await server.close();
        }
    });
});
