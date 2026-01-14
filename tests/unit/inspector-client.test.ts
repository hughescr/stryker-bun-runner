import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
    InspectorClient,
    InspectorTimeoutError,
    InspectorConnectionError,
    type InspectorEventHandlers,
    type TestInfo
} from '../../src/inspector/index.js';

// Mock WebSocket server for testing
class MockWebSocketServer {
    private handlers = new Map<string, ((data: string) => void)[]>();
    public readyState:   number = WebSocket.CONNECTING;
    public sentMessages: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock handler accepts any data type
    addEventListener(event: string, handler: (data: any) => void): void {
        if(!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);
    }

    send(data: string): void {
        this.sentMessages.push(data);
    }

    close(): void {
        this.readyState = WebSocket.CLOSED;
        this.emit('close', {});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock event data can be any type
    emit(event: string, data: any): void {
        const handlers = this.handlers.get(event);
        if(handlers) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- mock event data passed through
            handlers.forEach(handler => handler(data));
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

describe('InspectorClient', () => {
    let mockWs: MockWebSocketServer;
    let originalWebSocket: typeof WebSocket;

    beforeEach(() => {
    // Save original WebSocket
        originalWebSocket = globalThis.WebSocket;

        // Replace with mock
        mockWs = new MockWebSocketServer();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
        globalThis.WebSocket = function(_url: string) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- returning mock as WebSocket
            return mockWs as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket type cast
        } as any;
    });

    afterEach(() => {
    // Restore original WebSocket
        globalThis.WebSocket = originalWebSocket;
    });

    describe('constructor', () => {
        it('should create client with default options', () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });
            expect(client).toBeDefined();
        });

        it('should create client with custom handlers', () => {
            const handlers: InspectorEventHandlers = {
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
                onTestFound: mock(() => {}),
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
                onTestStart: mock(() => {}),
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
                onTestEnd:   mock(() => {}),
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
                onError:     mock(() => {}),
            };

            const client = new InspectorClient({
                url: 'ws://localhost:6499',
                handlers,
            });

            expect(client).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should connect successfully', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();

            await expect(connectPromise).resolves.toBeUndefined();
        });

        it('should reject on connection timeout', async () => {
            const client = new InspectorClient({
                url:               'ws://localhost:6499',
                connectionTimeout: 100,
            });

            const connectPromise = client.connect();

            await expect(connectPromise).rejects.toThrow(InspectorTimeoutError);
            await expect(connectPromise).rejects.toThrow('Connection timeout after 100ms');
        });

        it('should reject on connection error', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateError();

            await expect(connectPromise).rejects.toThrow(InspectorConnectionError);
            await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
        });

        it('should throw if already connected', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            await expect(client.connect()).rejects.toThrow('Already connected');
        });
    });

    describe('send', () => {
        it('should send request and receive response', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            // Simulate response
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing mock message data
            const sentMessage = JSON.parse(mockWs.sentMessages[0]);
            mockWs.simulateMessage(
                JSON.stringify({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- accessing mock message ID
                    id:     sentMessage.id,
                    result: { enabled: true },
                })
            );

            const result = await sendPromise;
            expect(result).toEqual({ enabled: true });
        });

        it('should reject on request timeout', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                requestTimeout: 100,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            await expect(sendPromise).rejects.toThrow(InspectorTimeoutError);
            await expect(sendPromise).rejects.toThrow('Request timeout after 100ms: TestReporter.enable');
        });

        it('should reject with error from server', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('InvalidMethod', {});

            // Simulate error response
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing mock message data
            const sentMessage = JSON.parse(mockWs.sentMessages[0]);
            mockWs.simulateMessage(
                JSON.stringify({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- accessing mock message ID
                    id:    sentMessage.id,
                    error: {
                        code:    -32601,
                        message: 'Method not found',
                    },
                })
            );

            await expect(sendPromise).rejects.toThrow('Inspector error: Method not found');
        });

        it('should throw if not connected', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            await expect(client.send('TestReporter.enable', {})).rejects.toThrow(
                'WebSocket not connected'
            );
        });
    });

    describe('close', () => {
        it('should close connection', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            await client.close();
            expect(mockWs.readyState).toBe(WebSocket.CLOSED);
        });

        it('should reject pending requests on close', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});
            await client.close();

            await expect(sendPromise).rejects.toThrow(InspectorConnectionError);
            await expect(sendPromise).rejects.toThrow('Connection closed');
        });

        it('should be idempotent', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            await client.close();
            await client.close(); // Second close should not throw
        });

        it('should handle close on unconnected client', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });
            await client.close(); // Should not throw
        });
    });

    describe('event handling', () => {
        it('should handle TestReporter.found event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onTestFound = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onTestFound },
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Simulate TestReporter.found event
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'test1',
                        type: 'test',
                        url:  '/path/to/test.ts',
                        line: 10,
                    },
                })
            );

            expect(onTestFound).toHaveBeenCalledTimes(1);
            expect(onTestFound).toHaveBeenCalledWith({
                id:       1,
                name:     'test1',
                fullName: 'test1',
                type:     'test',
                url:      '/path/to/test.ts',
                line:     10,
            });
        });

        it('should handle TestReporter.start event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onTestStart = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onTestStart },
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // First discover the test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'test1',
                        type: 'test',
                    },
                })
            );

            // Then start it
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 1 },
                })
            );

            expect(onTestStart).toHaveBeenCalledTimes(1);
            expect(onTestStart).toHaveBeenCalledWith({
                id:       1,
                name:     'test1',
                fullName: 'test1',
                type:     'test',
            });
        });

        it('should handle TestReporter.end event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onTestEnd = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onTestEnd },
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'test1',
                        type: 'test',
                    },
                })
            );

            // End test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.end',
                    params: {
                        id:      1,
                        status:  'pass',
                        elapsed: 150,
                    },
                })
            );

            expect(onTestEnd).toHaveBeenCalledTimes(1);
            const call = onTestEnd.mock.calls[0][0];
            expect(call.id).toBe(1);
            expect(call.status).toBe('pass');
            expect(call.elapsed).toBe(150);
        });

        it('should call onError for unknown test in start event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Start unknown test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 999 },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toContain('unknown test ID: 999');
        });
    });

    describe('test hierarchy', () => {
        it('should build full name with parent chain', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover describe block
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'Suite',
                        type: 'describe',
                    },
                })
            );

            // Discover nested describe
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'Nested',
                        type:     'describe',
                        parentId: 1,
                    },
                })
            );

            // Discover test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       3,
                        name:     'test1',
                        type:     'test',
                        parentId: 2,
                    },
                })
            );

            const test = client.getTest(3);
            expect(test?.fullName).toBe('Suite > Nested > test1');
        });

        it('should detect circular references', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover test with circular parent reference
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'Suite',
                        type: 'describe',
                    },
                })
            );

            // Create circular reference
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'test1',
                        type:     'test',
                        parentId: 2, // Self-reference
                    },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toContain('Circular reference detected');
        });

        it('should track execution order for tests only', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover describe
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'Suite',
                        type: 'describe',
                    },
                })
            );

            // Discover two tests
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'test1',
                        type:     'test',
                        parentId: 1,
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       3,
                        name:     'test2',
                        type:     'test',
                        parentId: 1,
                    },
                })
            );

            // Start describe (should not be tracked)
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 1 },
                })
            );

            // Start tests
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 2 },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 3 },
                })
            );

            const executionOrder = client.getExecutionOrder();
            expect(executionOrder).toEqual([2, 3]);
        });
    });

    describe('getters', () => {
        it('should return all tests', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'test1',
                        type: 'test',
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   2,
                        name: 'test2',
                        type: 'test',
                    },
                })
            );

            const tests = client.getTests();
            expect(tests).toHaveLength(2);
            expect(tests[0].name).toBe('test1');
            expect(tests[1].name).toBe('test2');
        });

        it('should return specific test by ID', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   42,
                        name: 'test42',
                        type: 'test',
                    },
                })
            );

            const test = client.getTest(42);
            expect(test).toBeDefined();
            expect(test?.name).toBe('test42');
        });

        it('should return undefined for unknown test ID', () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });
            const test = client.getTest(999);
            expect(test).toBeUndefined();
        });
    });

    describe('connection close handling', () => {
        it('should reject pending requests on unexpected close', async () => {
            const client = new InspectorClient({ url: 'ws://localhost:6499' });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            // Simulate unexpected close
            mockWs.close();

            await expect(sendPromise).rejects.toThrow(InspectorConnectionError);
            await expect(sendPromise).rejects.toThrow('Connection closed unexpectedly');
        });
    });
});
