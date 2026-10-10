/**
 * Mutation-killing tests for InspectorClient's cleanup / bookkeeping paths:
 * every way a pending request or close waiter can be settled must also release
 * its bookkeeping entry (and timers), and the connect-timeout watchdog must be
 * disarmed by a connection error. Split out of inspector-client.test.ts to keep
 * that file's merge surface small.
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import {
    InspectorClient,
    InspectorTimeoutError,
    type InspectorClientOptions,
    type InspectorEventHandlers,
    type RequestStallInfo
} from '../../src/inspector/index.js';

class MockWebSocket {
    private handlers = new Map<string, ((data: unknown) => void)[]>();
    public readyState:   number = WebSocket.CONNECTING;
    public sentMessages: string[] = [];
    public closeCalls = 0;

    addEventListener(event: string, handler: (data: unknown) => void): void {
        if(!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);
    }

    send(data: string): void {
        this.sentMessages.push(data);
    }

    close(): void {
        this.closeCalls++;
        this.readyState = WebSocket.CLOSED;
        this.emit('close', {});
    }

    emit(event: string, data: unknown): void {
        for(const handler of this.handlers.get(event) ?? []) {
            handler(data);
        }
    }

    simulateOpen(): void {
        this.readyState = WebSocket.OPEN;
        this.emit('open', {});
    }

    simulateError(): void {
        this.emit('error', {});
    }

    simulateMessage(data: string): void {
        this.emit('message', { data });
    }
}

/** Peek at the private bookkeeping containers — their size is the only observable for a leaked entry. */
function internals(client: InspectorClient): { pendingRequests: Map<number, unknown>, closeWaiters: unknown[] } {
    return client as unknown as { pendingRequests: Map<number, unknown>, closeWaiters: unknown[] };
}

describe('InspectorClient cleanup bookkeeping', () => {
    let mockWs: MockWebSocket;

    const makeClient = (handlers?: InspectorEventHandlers, extra: { requestTimeout?: number, connectionTimeout?: number } = {}): InspectorClient => new InspectorClient({
        url:            'ws://localhost:6499',
        handlers,
        WebSocketClass: function() {
            return mockWs;
        } as unknown as InspectorClientOptions['WebSocketClass'],
        ...extra,
    });

    const connected = async (handlers?: InspectorEventHandlers, extra: { requestTimeout?: number, connectionTimeout?: number } = {}): Promise<InspectorClient> => {
        const client = makeClient(handlers, extra);
        const connectPromise = client.connect();
        mockWs.simulateOpen();
        await connectPromise;
        return client;
    };

    beforeEach(() => {
        mockWs = new MockWebSocket();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('connect() error path', () => {
        it('disarms the connection-timeout watchdog when the connection errors, so it never closes the socket later', async () => {
            jest.useFakeTimers();
            const client = makeClient(undefined, { connectionTimeout: 1000 });

            const connectPromise = client.connect();
            const settled = connectPromise.catch((e: unknown) => e);
            mockWs.simulateError();
            const error = await settled;
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe('WebSocket connection failed');

            // The watchdog must have been cleared: nothing left to fire at the 1000ms mark.
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(5000);
            expect(mockWs.closeCalls).toBe(0);
        });
    });

    describe('pending request bookkeeping', () => {
        it('drops the pending entry when a request times out', async () => {
            jest.useFakeTimers();
            const client = await connected(undefined, { requestTimeout: 100 });

            const result = client.send('Some.method', {}).catch((e: unknown) => e);
            expect(internals(client).pendingRequests.size).toBe(1);

            jest.advanceTimersByTime(100);
            expect(await result).toBeInstanceOf(InspectorTimeoutError);
            expect(internals(client).pendingRequests.size).toBe(0);
        });

        it('clears the stall watchdog when a request times out, so no stall warning fires afterwards', async () => {
            jest.useFakeTimers();
            const onRequestStall = mock((_info: RequestStallInfo) => {});
            const client = await connected({ onRequestStall }, { requestTimeout: 100 });

            const baseline = jest.getTimerCount();
            const result = client.send('Some.method', {}).catch((e: unknown) => e);
            expect(jest.getTimerCount()).toBe(baseline + 2); // request timeout + stall watchdog

            jest.advanceTimersByTime(100);
            expect(await result).toBeInstanceOf(InspectorTimeoutError);
            expect(jest.getTimerCount()).toBe(baseline);

            jest.advanceTimersByTime(5000);
            expect(onRequestStall).not.toHaveBeenCalled();
        });

        it('drops the pending entry when the response arrives', async () => {
            const client = await connected();

            const promise = client.send('Some.method', {});
            expect(internals(client).pendingRequests.size).toBe(1);
            const sent = JSON.parse(mockWs.sentMessages[0]) as { id: number };
            mockWs.simulateMessage(JSON.stringify({ id: sent.id, result: { ok: true } }));

            expect(await promise).toEqual({ ok: true });
            expect(internals(client).pendingRequests.size).toBe(0);
        });

        it('drops the pending entry when the error response arrives', async () => {
            const client = await connected();

            const promise = client.send('Some.method', {}).catch((e: unknown) => e);
            const sent = JSON.parse(mockWs.sentMessages[0]) as { id: number };
            mockWs.simulateMessage(JSON.stringify({ id: sent.id, error: { message: 'nope' } }));

            expect(((await promise) as Error).message).toBe('Inspector error: nope');
            expect(internals(client).pendingRequests.size).toBe(0);
        });

        it('drops the pending entry when ws.send throws', async () => {
            const client = await connected();
            mockWs.send = () => {
                throw new Error('boom');
            };

            const error = await client.send('Some.method', {}).catch((e: unknown) => e);
            expect((error as Error).message).toBe('boom');
            expect(internals(client).pendingRequests.size).toBe(0);
        });

        it('wraps a non-Error thrown by ws.send in an Error', async () => {
            const client = await connected();
            mockWs.send = () => {
                throw 'string failure';
            };

            const error = await client.send('Some.method', {}).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe('string failure');
        });

        it('empties the pending map on close(), rejecting every in-flight request', async () => {
            const client = await connected();

            const a = client.send('A', {}).catch((e: unknown) => e);
            const b = client.send('B', {}).catch((e: unknown) => e);
            expect(internals(client).pendingRequests.size).toBe(2);

            await client.close();

            expect(((await a) as Error).message).toBe('Connection closed');
            expect(((await b) as Error).message).toBe('Connection closed');
            expect(internals(client).pendingRequests.size).toBe(0);
        });

        it('empties the pending map on an unexpected close, rejecting every in-flight request', async () => {
            const client = await connected();

            const a = client.send('A', {}).catch((e: unknown) => e);
            const b = client.send('B', {}).catch((e: unknown) => e);
            expect(internals(client).pendingRequests.size).toBe(2);

            mockWs.close();

            expect(((await a) as Error).message).toBe('Connection closed unexpectedly');
            expect(((await b) as Error).message).toBe('Connection closed unexpectedly');
            expect(internals(client).pendingRequests.size).toBe(0);
        });
    });

    describe('waitForClose() bookkeeping', () => {
        it('removes its waiter from the registry when it resolves via the timeout path', async () => {
            jest.useFakeTimers();
            const client = await connected();

            const waiting = client.waitForClose(100);
            expect(internals(client).closeWaiters.length).toBe(1);

            jest.advanceTimersByTime(100);
            await waiting;

            expect(internals(client).closeWaiters.length).toBe(0);
            // And the later real close finds nothing left to drain.
            mockWs.close();
            expect(internals(client).closeWaiters.length).toBe(0);
        });

        it('removes only its own waiter when several are registered', async () => {
            jest.useFakeTimers();
            const client = await connected();

            const short = client.waitForClose(100);
            const long = client.waitForClose(10_000);
            expect(internals(client).closeWaiters.length).toBe(2);

            jest.advanceTimersByTime(100);
            await short;
            expect(internals(client).closeWaiters.length).toBe(1);

            mockWs.close();
            await long;
            expect(internals(client).closeWaiters.length).toBe(0);
        });
    });

    describe('getFoundIdGaps() ordering', () => {
        const found = (id: number): void => {
            mockWs.simulateMessage(JSON.stringify({
                method: 'TestReporter.found',
                params: { id, name: `t${id}`, type: 'test' },
            }));
        };

        it('reports gaps in ascending order regardless of arrival order', async () => {
            const client = await connected();
            for(const id of [9, 2, 5, 3]) {
                found(id);
            }

            expect(client.getFoundIdGaps()).toEqual([4, 6, 7, 8]);
        });

        it('does not report the highest id (or anything past it) as a gap when it arrives before lower ids', async () => {
            const client = await connected();
            for(const id of [10, 1]) {
                found(id);
            }

            expect(client.getFoundIdGaps()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        });

        it('reports no gaps for a single id or for adjacent ids arriving out of order', async () => {
            const client = await connected();
            found(7);
            expect(client.getFoundIdGaps()).toEqual([]);
            found(6);
            found(8);
            expect(client.getFoundIdGaps()).toEqual([]);
        });
    });
});
