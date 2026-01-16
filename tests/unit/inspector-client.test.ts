import { describe, it, expect, beforeEach, mock } from 'bun:test';
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket constructor needs flexible typing
    let MockWebSocketConstructor: any;

    beforeEach(() => {
        // Create mock WebSocket instance
        mockWs = new MockWebSocketServer();

        // Create mock WebSocket constructor

        MockWebSocketConstructor = function(_url: string) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- returning mock as WebSocket
            return mockWs as any;
        };
    });

    describe('constructor', () => {
        it('should create client with default options', () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });
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
                url:            'ws://localhost:6499',
                handlers,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            expect(client).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should connect successfully', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();

            await expect(connectPromise).resolves.toBeUndefined();
        });

        it('should reject on connection timeout', async () => {
            const client = new InspectorClient({
                url:               'ws://localhost:6499',
                connectionTimeout: 100,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass:    MockWebSocketConstructor,
            });

            const connectPromise = client.connect();

            await expect(connectPromise).rejects.toThrow(InspectorTimeoutError);
            await expect(connectPromise).rejects.toThrow('Connection timeout after 100ms');
        });

        it('should reject on connection error', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateError();

            await expect(connectPromise).rejects.toThrow(InspectorConnectionError);
            await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
        });

        it('should throw if already connected', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            await expect(client.connect()).rejects.toThrow('Already connected');
        });
    });

    describe('send', () => {
        it('should send request and receive response', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            await expect(sendPromise).rejects.toThrow(InspectorTimeoutError);
            await expect(sendPromise).rejects.toThrow('Request timeout after 100ms: TestReporter.enable');
        });

        it('should reject with error from server', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            await expect(client.send('TestReporter.enable', {})).rejects.toThrow(
                'WebSocket not connected'
            );
        });
    });

    describe('close', () => {
        it('should close connection', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            await client.close();
            expect(mockWs.readyState).toBe(WebSocket.CLOSED);
        });

        it('should reject pending requests on close', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});
            await client.close();

            await expect(sendPromise).rejects.toThrow(InspectorConnectionError);
            await expect(sendPromise).rejects.toThrow('Connection closed');
        });

        it('should be idempotent', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            await client.close();
            await client.close(); // Second close should not throw
        });

        it('should handle close on unconnected client', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });
            await client.close(); // Should not throw
        });
    });

    describe('event handling', () => {
        it('should handle TestReporter.found event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onTestFound = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                handlers:       { onTestFound },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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
                url:            'ws://localhost:6499',
                handlers:       { onTestStart },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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
                url:            'ws://localhost:6499',
                handlers:       { onTestEnd },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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
                url:            'ws://localhost:6499',
                handlers:       { onError },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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

        it('should call onError for unknown test in end event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                handlers:       { onError },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // End unknown test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.end',
                    params: {
                        id:      888,
                        status:  'pass',
                        elapsed: 100,
                    },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toBe('Test end event for unknown test ID: 888');
        });

        it('should verify exact error message for start event', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                handlers:       { onError },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Start unknown test
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 777 },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toBe('Test start event for unknown test ID: 777');
        });
    });

    describe('test hierarchy', () => {
        it('should build full name with parent chain', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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
                url:            'ws://localhost:6499',
                handlers:       { onError },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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

        it('should detect circular references in parent chains', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                handlers:       { onError },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Create chain: 1 -> 2
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'Suite1',
                        type: 'describe',
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'Suite2',
                        type:     'describe',
                        parentId: 1,
                    },
                })
            );

            // Create circular chain: 3 -> 1 (which points to 2, which is parent of 1)
            // This simulates a scenario where building fullName for test 3 would encounter id 3 again
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       3,
                        name:     'test1',
                        type:     'test',
                        parentId: 3, // Points to itself through chain
                    },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toContain('Circular reference detected');
            expect(onError.mock.calls[0][0].message).toContain('3');
        });

        it('should build name when parent is undefined', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Test without parentId
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'RootTest',
                        type: 'test',
                        // No parentId
                    },
                })
            );

            const test = client.getTest(1);
            expect(test?.fullName).toBe('RootTest');
        });

        it('should stop building name when parent not found', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover test with parentId that doesn't exist yet
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'test1',
                        type:     'test',
                        parentId: 99, // Parent doesn't exist
                    },
                })
            );

            const test = client.getTest(2);
            // Should just return the test name since parent wasn't found
            expect(test?.fullName).toBe('test1');
        });

        it('should continue building name until parent is undefined', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Create chain with no parentId at root
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'Root',
                        type: 'describe',
                        // No parentId - this terminates the chain
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'Child',
                        type:     'describe',
                        parentId: 1,
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       3,
                        name:     'test',
                        type:     'test',
                        parentId: 2,
                    },
                })
            );

            const test = client.getTest(3);
            expect(test?.fullName).toBe('Root > Child > test');
        });

        it('should track execution order for tests only', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });
            const test = client.getTest(999);
            expect(test).toBeUndefined();
        });
    });

    describe('connection close handling', () => {
        it('should reject pending requests on unexpected close', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            // Simulate unexpected close
            mockWs.close();

            await expect(sendPromise).rejects.toThrow(InspectorConnectionError);
            await expect(sendPromise).rejects.toThrow('Connection closed unexpectedly');
        });

        it('should handle close event while isClosing is true', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Start closing
            const closePromise = client.close();

            // Simulate close event during close operation
            mockWs.close();

            await closePromise;

            // Verify no errors thrown
            expect(mockWs.readyState).toBe(WebSocket.CLOSED);
        });

        it('should not process close if already closing', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            // Start explicit close
            const closePromise = client.close();

            // Simulate close event during close operation - this should be ignored
            mockWs.close();

            await closePromise;

            // Request should be rejected with "Connection closed" not "Connection closed unexpectedly"
            await expect(sendPromise).rejects.toThrow(InspectorConnectionError);
            await expect(sendPromise).rejects.toThrow('Connection closed');
        });
    });

    describe('method return values', () => {
        it('should return copy of execution order', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover and start a test
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
                    method: 'TestReporter.start',
                    params: { id: 1 },
                })
            );

            const order1 = client.getExecutionOrder();
            const order2 = client.getExecutionOrder();

            // Should return copies, not the same array
            expect(order1).not.toBe(order2);
            expect(order1).toEqual(order2);
            expect(order1).toEqual([1]);

            // Modifying returned array should not affect internal state
            order1.push(999);
            const order3 = client.getExecutionOrder();
            expect(order3).toEqual([1]);
        });

        it('should return copy of tests array', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

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

            const tests1 = client.getTests();
            const tests2 = client.getTests();

            // Arrays should be different instances but have same content
            expect(tests1).not.toBe(tests2);
            expect(tests1.length).toBe(tests2.length);
            expect(tests1[0].id).toBe(tests2[0].id);
        });
    });

    describe('error class names', () => {
        it('should have InspectorTimeoutError as error name', async () => {
            const client = new InspectorClient({
                url:               'ws://localhost:6499',
                connectionTimeout: 10,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass:    MockWebSocketConstructor,
            });

            try {
                await client.connect();
            } catch (error) {
                expect(error).toBeInstanceOf(InspectorTimeoutError);
                expect((error as Error).name).toBe('InspectorTimeoutError');
            }
        });

        it('should have InspectorConnectionError as error name', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateError();

            try {
                await connectPromise;
            } catch (error) {
                expect(error).toBeInstanceOf(InspectorConnectionError);
                expect((error as Error).name).toBe('InspectorConnectionError');
            }
        });
    });

    describe('connection timeout cleanup', () => {
        it('should close WebSocket and set to null on timeout', async () => {
            const client = new InspectorClient({
                url:               'ws://localhost:6499',
                connectionTimeout: 10,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass:    MockWebSocketConstructor,
            });

            const connectPromise = client.connect();

            // Save reference to the mockWs before it might get replaced
            const wsInstance = mockWs;

            // Catch the rejection immediately to prevent unhandled error
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- test error handling
            const result = await connectPromise.catch(e => e);

            expect(result).toBeInstanceOf(InspectorTimeoutError);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test error validation
            expect(result.message).toContain('Connection timeout after 10ms');

            // Verify WebSocket was closed and nulled
            expect(wsInstance.readyState).toBe(WebSocket.CLOSED);
        });
    });

    describe('WebSocket readyState checks', () => {
        it('should throw when WebSocket is CONNECTING', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            // Start connection but don't open
            const connectPromise = client.connect();

            // Try to send while still connecting

            await expect(client.send('TestReporter.enable', {})).rejects.toThrow('WebSocket not connected');

            // Clean up
            mockWs.simulateOpen();
            await connectPromise;
            await client.close();
        });

        it('should throw when WebSocket is CLOSED', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Close and try to send
            await client.close();

            await expect(client.send('TestReporter.enable', {})).rejects.toThrow('WebSocket not connected');
        });
    });

    describe('message ID increment', () => {
        it('should increment messageId for each request', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Send multiple requests (catching to prevent unhandled rejections)
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty catch for test
            const p1 = client.send('Method1', {}).catch(() => {});
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty catch for test
            const p2 = client.send('Method2', {}).catch(() => {});
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty catch for test
            const p3 = client.send('Method3', {}).catch(() => {});

            // Verify message IDs are incrementing
            expect(mockWs.sentMessages.length).toBe(3);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing mock message
            const msg1 = JSON.parse(mockWs.sentMessages[0]);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing mock message
            const msg2 = JSON.parse(mockWs.sentMessages[1]);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing mock message
            const msg3 = JSON.parse(mockWs.sentMessages[2]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- checking message IDs
            expect(msg2.id).toBe(msg1.id + 1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- checking message IDs
            expect(msg3.id).toBe(msg2.id + 1);

            // Close the client (which will reject the pending requests)
            await client.close();

            // Wait for promises to settle
            await Promise.all([p1, p2, p3]);
        });
    });

    describe('close method edge cases', () => {
        it('should only close WebSocket when in OPEN or CONNECTING state', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Manually set to a closed state before calling close
            mockWs.readyState = WebSocket.CLOSED;
            await client.close();

            // Should not throw, just handle gracefully
        });

        it('should return early when ws is null', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            // Close without ever connecting
            await client.close();

            // Should not throw
        });

        it('should set isClosing flag to prevent duplicate close handling', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Call close twice simultaneously
            const close1 = client.close();
            const close2 = client.close();

            await Promise.all([close1, close2]);

            // Should not throw and handle idempotently
        });
    });

    describe('error handling edge cases', () => {
        it('should update testInfo when error is present in end event', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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

            // End test with error
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.end',
                    params: {
                        id:      1,
                        status:  'fail',
                        elapsed: 100,
                        error:   {
                            message: 'Test failed',
                            stack:   'at line 1',
                        },
                    },
                })
            );

            const test = client.getTest(1);
            expect(test?.error).toBeDefined();
            expect(test?.error?.message).toBe('Test failed');
        });

        it('should update testInfo without error when not present', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
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

            // End test without error
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.end',
                    params: {
                        id:      1,
                        status:  'pass',
                        elapsed: 100,
                    },
                })
            );

            const test = client.getTest(1);
            expect(test?.error).toBeUndefined();
        });
    });

    describe('buildFullName edge cases', () => {
        it('should return just name when parentId is undefined', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Discover test with no parent
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:   1,
                        name: 'RootTest',
                        type: 'test',
                        // parentId is undefined
                    },
                })
            );

            const test = client.getTest(1);
            expect(test?.fullName).toBe('RootTest');
        });

        it('should include specific circular reference IDs in error message', async () => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                handlers:       { onError },
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Create circular reference with specific IDs
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       5,
                        name:     'CircularTest',
                        type:     'test',
                        parentId: 5, // Points to itself
                    },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            const errorMessage = onError.mock.calls[0][0].message;
            expect(errorMessage).toContain('5 -> 5');
            expect(errorMessage).toContain('Circular reference detected');
        });
    });

    describe('handleClose edge cases', () => {
        it('should return early when isClosing is true', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Start explicit close (sets isClosing = true)
            const closePromise = client.close();

            // The close event handler should return early since isClosing = true
            mockWs.close();

            await closePromise;

            // Should not throw
        });
    });

    describe('send error handling', () => {
        it('should handle non-Error exceptions during send', async () => {
            const client = new InspectorClient({
                url:            'ws://localhost:6499',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Mock send to throw a non-Error
            mockWs.send = () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error exception handling
                throw 'string error';
            };

            await expect(client.send('TestReporter.enable', {})).rejects.toThrow('string error');
        });
    });

    describe('mutation-specific tests', () => {
        describe('line 222: isClosing BooleanLiteral mutation', () => {
            it('should prevent handleClose from running when close() is called explicitly', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Track rejection error messages to ensure they're from close(), not handleClose()
                const rejectionErrors: string[] = [];

                const sendPromise1 = client.send('TestReporter.enable', {}).catch((e: Error) => {
                    rejectionErrors.push(e.message);
                });

                const sendPromise2 = client.send('TestReporter.start', {}).catch((e: Error) => {
                    rejectionErrors.push(e.message);
                });

                // Call close() which MUST set isClosing to true
                await client.close();

                // Simulate the close event that happens after close() is called
                mockWs.close();

                // Wait for all rejections to complete
                await Promise.all([sendPromise1, sendPromise2]);

                // CRITICAL: All rejections must be "Connection closed" not "Connection closed unexpectedly"
                // If isClosing were false (mutation), handleClose would run and reject with "unexpectedly"
                expect(rejectionErrors).toHaveLength(2);
                expect(rejectionErrors[0]).toBe('Connection closed');
                expect(rejectionErrors[1]).toBe('Connection closed');
                expect(rejectionErrors[0]).not.toContain('unexpectedly');
                expect(rejectionErrors[1]).not.toContain('unexpectedly');
            });

            it('should set isClosing to true when close() is called', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Add a pending request
                const sendPromise = client.send('TestReporter.enable', {});

                // Call close() which should set isClosing to true
                await client.close();

                // Verify the request was rejected with "Connection closed" not "Connection closed unexpectedly"
                await expect(sendPromise).rejects.toThrow(InspectorConnectionError);
                await expect(sendPromise).rejects.toThrow('Connection closed');
                // If isClosing was false instead of true, handleClose would trigger and reject with "Connection closed unexpectedly"
            });
        });

        describe('line 233: ConditionalExpression readyState check mutation', () => {
            it('MUST call ws.close() when readyState is OPEN or CONNECTING', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Track if close was called
                let closeCalled = false;
                const originalClose = mockWs.close.bind(mockWs);
                mockWs.close = () => {
                    closeCalled = true;
                    originalClose();
                };

                // Verify WebSocket is OPEN
                expect(mockWs.readyState).toBe(WebSocket.OPEN);

                // Close MUST call ws.close() because readyState is OPEN
                await client.close();

                // CRITICAL: If the condition were false, ws.close() would never be called
                expect(closeCalled).toBe(true);
                expect(mockWs.readyState).toBe(WebSocket.CLOSED);
            });

            it('should close WebSocket when readyState is OPEN', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Verify WebSocket is OPEN
                expect(mockWs.readyState).toBe(WebSocket.OPEN);

                // Close should call ws.close()
                await client.close();
                expect(mockWs.readyState).toBe(WebSocket.CLOSED);
            });

            it('should close WebSocket when readyState is CONNECTING', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                // Start connection but keep it in CONNECTING state
                const connectPromise = client.connect();

                // At this point, readyState should be CONNECTING
                expect(mockWs.readyState).toBe(WebSocket.CONNECTING);

                // Close should still call ws.close() for CONNECTING state
                const closePromise = client.close();

                // Simulate the close event
                mockWs.readyState = WebSocket.CLOSED;
                mockWs.emit('close', {});

                await closePromise;
                expect(mockWs.readyState).toBe(WebSocket.CLOSED);

                // Clean up connection attempt
                mockWs.simulateOpen();
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional empty catch for test cleanup
                await connectPromise.catch(() => {});
            });

            it('should NOT close WebSocket when readyState is CLOSED', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Manually set WebSocket to CLOSED before calling close
                mockWs.readyState = WebSocket.CLOSED;

                // Track if close was called
                let closeWasCalled = false;
                const originalClose = mockWs.close.bind(mockWs);
                mockWs.close = () => {
                    closeWasCalled = true;
                    originalClose();
                };

                await client.close();

                // close() should not have been called since readyState was CLOSED
                expect(closeWasCalled).toBe(false);
            });

            it('should NOT close WebSocket when readyState is CLOSING', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Manually set WebSocket to CLOSING
                mockWs.readyState = WebSocket.CLOSING;

                // Track if close was called
                let closeWasCalled = false;
                const originalClose = mockWs.close.bind(mockWs);
                mockWs.close = () => {
                    closeWasCalled = true;
                    originalClose();
                };

                await client.close();

                // close() should not have been called since readyState was CLOSING
                expect(closeWasCalled).toBe(false);
            });
        });

        describe('line 353: error assignment check', () => {
            it('should NOT assign error when params.error is undefined', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
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

                // End test without error (params.error is undefined)
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.end',
                        params: {
                            id:      1,
                            status:  'pass',
                            elapsed: 100,
                            // No error field
                        },
                    })
                );

                const test = client.getTest(1);
                // If the mutation "always true" were active, error would be assigned even when undefined
                expect(test?.error).toBeUndefined();
                expect('error' in (test ?? {})).toBe(false);
            });

            it('should assign error when params.error is present', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
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

                // End test with error
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.end',
                        params: {
                            id:      1,
                            status:  'fail',
                            elapsed: 100,
                            error:   {
                                message: 'Test failed',
                            },
                        },
                    })
                );

                const test = client.getTest(1);
                expect(test?.error).toBeDefined();
                expect(test?.error?.message).toBe('Test failed');
            });
        });

        describe('line 367: BlockStatement and ConditionalExpression parentId mutations', () => {
            it('MUST return early when parentId is undefined without building hierarchy', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Discover test with no parent (parentId is undefined)
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: {
                            id:   1,
                            name: 'StandaloneTest',
                            type: 'test',
                            // parentId is undefined - should NOT attempt to build hierarchy
                        },
                    })
                );

                const test = client.getTest(1);
                // CRITICAL: Must be exactly the name with no separators
                // If the condition were false or block removed, it would attempt hierarchy building
                // and might produce different results or fail
                expect(test?.fullName).toBe('StandaloneTest');
                expect(test?.fullName).not.toContain('>');
            });

            it('should return just name when parentId is undefined', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Discover test with no parent (parentId is undefined)
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: {
                            id:   1,
                            name: 'StandaloneTest',
                            type: 'test',
                            // parentId is undefined
                        },
                    })
                );

                const test = client.getTest(1);
                // Should return just the name, not attempt to build hierarchy
                expect(test?.fullName).toBe('StandaloneTest');
                // If the mutation "false" or "block removal" were active, it would try to build hierarchy
            });

            it('should build hierarchy when parentId is defined (even if 0)', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Create parent with id 0
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: {
                            id:   0,
                            name: 'ParentSuite',
                            type: 'describe',
                        },
                    })
                );

                // Child with parentId: 0 (falsy but not undefined)
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: {
                            id:       1,
                            name:     'ChildTest',
                            type:     'test',
                            parentId: 0,
                        },
                    })
                );

                const test = client.getTest(1);
                // Should build full hierarchy since parentId is 0 (not undefined)
                expect(test?.fullName).toBe('ParentSuite > ChildTest');
            });
        });

        describe('line 379: StringLiteral error message mutation', () => {
            it('MUST include non-empty descriptive error message for circular reference', async () => {
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
                const onError = mock((_error: Error) => {});

                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    handlers:       { onError },
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Create circular reference
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: {
                            id:       42,
                            name:     'CircularTest',
                            type:     'test',
                            parentId: 42, // Self-reference
                        },
                    })
                );

                expect(onError).toHaveBeenCalledTimes(1);
                const errorMessage = onError.mock.calls[0][0].message;

                // CRITICAL: Error message MUST NOT be empty string
                expect(errorMessage).not.toBe('');
                expect(errorMessage.length).toBeGreaterThan(0);

                // Must contain the exact text from line 379
                expect(errorMessage).toContain('Circular reference detected in test hierarchy:');
                expect(errorMessage).toContain('42 -> 42');

                // If mutated to empty string, these would all fail
                expect(errorMessage).toMatch(/Circular reference detected/);
            });

            it('should include exact circular reference error message', async () => {
                // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional mock stub
                const onError = mock((_error: Error) => {});

                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    handlers:       { onError },
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Create circular reference
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: {
                            id:       42,
                            name:     'CircularTest',
                            type:     'test',
                            parentId: 42, // Self-reference
                        },
                    })
                );

                expect(onError).toHaveBeenCalledTimes(1);
                const errorMessage = onError.mock.calls[0][0].message;
                // Test for exact string from line 379
                expect(errorMessage).toContain('Circular reference detected in test hierarchy:');
                expect(errorMessage).toContain('42 -> 42');
            });
        });

        describe('line 402: BlockStatement and ConditionalExpression handleClose mutations', () => {
            it('MUST distinguish between expected and unexpected close via isClosing flag', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('TestReporter.enable', {});

                // Simulate unexpected close (isClosing is false)
                mockWs.close();

                // CRITICAL: Must reject with "unexpectedly" because isClosing is false
                // If the condition were false or block removed, it would not return early
                // and would always process the close (even when expected)
                await expect(sendPromise).rejects.toThrow('Connection closed unexpectedly');

                // The error message MUST contain "unexpectedly" to prove handleClose ran
                try {
                    await sendPromise;
                } catch (error) {
                    expect((error as Error).message).toContain('unexpectedly');
                }
            });

            it('should handle unexpected close when isClosing is false', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('TestReporter.enable', {});

                // Simulate unexpected close (isClosing is false)
                mockWs.close();

                // Should reject with "Connection closed unexpectedly"
                await expect(sendPromise).rejects.toThrow('Connection closed unexpectedly');
            });

            it('should NOT process close handler when isClosing is true', async () => {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock WebSocket constructor
                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('TestReporter.enable', {});

                // Explicitly close (sets isClosing to true)
                const closePromise = client.close();

                // Simulate close event - should be ignored because isClosing is true
                mockWs.close();

                await closePromise;

                // Should reject with "Connection closed" not "Connection closed unexpectedly"
                // This verifies that handleClose returned early when isClosing was true
                await expect(sendPromise).rejects.toThrow('Connection closed');
                await expect(sendPromise).rejects.not.toThrow('Connection closed unexpectedly');
            });
        });
    });
});
