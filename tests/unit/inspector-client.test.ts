import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
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
            for(const handler of handlers) {
                handler(data);
            }
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- returning mock as WebSocket
            return mockWs as any;
        };
    });

    afterEach(() => {
        // Safety net for fake timers used in nested test bodies below
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should create client with default options', () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });
            expect(client).toBeDefined();
        });

        it('should create client with custom handlers', () => {
            const handlers: InspectorEventHandlers = {

                onTestFound: mock(() => {}),

                onTestStart: mock(() => {}),

                onTestEnd: mock(() => {}),

                onError: mock(() => {}),
            };

            const client = new InspectorClient({
                url: 'ws://localhost:6499',
                handlers,

                WebSocketClass: MockWebSocketConstructor,
            });

            expect(client).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should connect successfully', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();

            await connectPromise;
        });

        // Regression test for the inspector bind/dial address mismatch: bun binds
        // a bare `--inspect=<port>` to ::1 only, while a dial to "localhost"
        // resolves via Node's net.connect fast path to 127.0.0.1, ignoring
        // /etc/hosts — deterministic ECONNREFUSED on hosts with that v4/v6 split
        // (e.g. Docker Desktop for Mac). The fix (process-runner.ts) pins bun's
        // bind host to 127.0.0.1 so its echoed inspector URL, and therefore the
        // URL passed here, is already 127.0.0.1. This client must dial that URL
        // verbatim — no "localhost" normalization/substitution of its own — or a
        // future edit here could silently reintroduce the mismatch.
        it('should dial the exact url passed in options, with no host rewriting', async () => {
            let dialedUrl: string | undefined;
            const CapturingWebSocketConstructor = function(this: unknown, url: string) {
                dialedUrl = url;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock WebSocket constructor returns mock as any
                return mockWs as any;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock constructor needs flexible typing to stand in for the real WebSocket class
            } as any;

            const client = new InspectorClient({
                url:            'ws://127.0.0.1:6499/abc123def456',
                WebSocketClass: CapturingWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            expect(dialedUrl).toBe('ws://127.0.0.1:6499/abc123def456');
        });

        it('should reject on connection timeout', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url:               'ws://localhost:6499',
                    connectionTimeout: 100,

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();

                jest.advanceTimersByTime(150);
                await Promise.resolve();

                const connectError = await connectPromise.catch((e: unknown) => e);
                expect(connectError).toBeInstanceOf(InspectorTimeoutError);
                expect((connectError as InspectorTimeoutError).message).toContain('Connection timeout after 100ms');
            } finally {
                jest.useRealTimers();
            }
        });

        it('should reject on connection error', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateError();

            const connectError = await connectPromise.catch((e: unknown) => e);
            expect(connectError).toBeInstanceOf(InspectorConnectionError);
            expect((connectError as InspectorConnectionError).message).toContain('WebSocket connection failed');
        });

        it('should throw if already connected', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const connectAgainError = await client.connect().catch((e: unknown) => e);
            expect((connectAgainError as Error).message).toContain('Already connected');
        });
    });

    describe('send', () => {
        it('should send request and receive response', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            // Simulate response

            const sentMessage = JSON.parse(mockWs.sentMessages[0]);
            mockWs.simulateMessage(
                JSON.stringify({

                    id:     sentMessage.id,
                    result: { enabled: true },
                })
            );

            const result = await sendPromise;
            expect(result).toEqual({ enabled: true });
        });

        it('should reject on request timeout', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    requestTimeout: 100,

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('TestReporter.enable', {});

                jest.advanceTimersByTime(150);
                await Promise.resolve();

                const sendError = await sendPromise.catch((e: unknown) => e);
                expect(sendError).toBeInstanceOf(InspectorTimeoutError);
                expect((sendError as InspectorTimeoutError).message).toContain('Request timeout after 100ms: TestReporter.enable');
            } finally {
                jest.useRealTimers();
            }
        });

        it('should honor a per-call timeout override, not the constructor requestTimeout', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    requestTimeout: 5000,

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('m', {}, 10_000);
                let rejected = false;
                const settled = sendPromise.catch((e: unknown) => {
                    rejected = true;
                    return e;
                });

                jest.advanceTimersByTime(5000);
                await Promise.resolve();
                await Promise.resolve();
                expect(rejected).toBe(false);

                jest.advanceTimersByTime(5000);
                await Promise.resolve();
                await Promise.resolve();

                const sendError = await settled;
                expect(rejected).toBe(true);
                expect(sendError).toBeInstanceOf(InspectorTimeoutError);
                expect((sendError as InspectorTimeoutError).message).toContain('Request timeout after 10000ms');
            } finally {
                jest.useRealTimers();
            }
        });

        it('should still use the constructor requestTimeout when no per-call override is passed', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url:            'ws://localhost:6499',
                    requestTimeout: 5000,

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('m', {});

                jest.advanceTimersByTime(5000);
                await Promise.resolve();

                const sendError = await sendPromise.catch((e: unknown) => e);
                expect(sendError).toBeInstanceOf(InspectorTimeoutError);
                expect((sendError as InspectorTimeoutError).message).toContain('Request timeout after 5000ms');
            } finally {
                jest.useRealTimers();
            }
        });

        it('should reject with error from server', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('InvalidMethod', {});

            // Simulate error response

            const sentMessage = JSON.parse(mockWs.sentMessages[0]);
            mockWs.simulateMessage(
                JSON.stringify({

                    id:    sentMessage.id,
                    error: {
                        code:    -32_601,
                        message: 'Method not found',
                    },
                })
            );

            const sendError = await sendPromise.catch((e: unknown) => e);
            expect((sendError as Error).message).toContain('Inspector error: Method not found');
        });

        it('should throw if not connected', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const sendError = await client.send('TestReporter.enable', {}).catch((e: unknown) => e);
            expect((sendError as Error).message).toContain('WebSocket not connected');
        });
    });

    describe('close', () => {
        it('should close connection', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});
            await client.close();

            const sendError = await sendPromise.catch((e: unknown) => e);
            expect(sendError).toBeInstanceOf(InspectorConnectionError);
            expect((sendError as InspectorConnectionError).message).toContain('Connection closed');
        });

        it('should be idempotent', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });
            await client.close(); // Should not throw
        });
    });

    describe('event handling', () => {
        it('should handle TestReporter.found event', async () => {
            const onTestFound = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onTestFound },

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
                bunName:  'test1',
                type:     'test',
                url:      '/path/to/test.ts',
                line:     10,
            });
        });

        it('should handle TestReporter.start event', async () => {
            const onTestStart = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onTestStart },

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
                bunName:  'test1',
                type:     'test',
            });
        });

        it('should handle TestReporter.end event', async () => {
            const onTestEnd = mock((_test: TestInfo) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onTestEnd },

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
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

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
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

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
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

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
                url: 'ws://localhost:6499',

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
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

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
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

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
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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

    describe('bunName', () => {
        it('should join nested describe and test titles with a single space (fullName stays " > "-joined)', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                        name: 'Suite',
                        type: 'describe',
                    },
                })
            );

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
            expect(test?.bunName).toBe('Suite Nested test1');
            expect(test?.fullName).toBe('Suite > Nested > test1');
        });

        it('should preserve exactly 3 spaces for padded titles (no per-level trim)', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                        name: 'outer ',
                        type: 'describe',
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     ' inner test',
                        type:     'test',
                        parentId: 1,
                    },
                })
            );

            const test = client.getTest(2);
            expect(test?.bunName).toBe('outer   inner test');
            expect(test?.fullName).toBe('outer  >  inner test');
        });

        it('should preserve a literal " > " substring in a leaf title verbatim', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                        name: 'createContextBuilder loading methods',
                        type: 'describe',
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'should call listMessages with CleanInbox when unread > 0',
                        type:     'test',
                        parentId: 1,
                    },
                })
            );

            const test = client.getTest(2);
            expect(test?.bunName).toBe('createContextBuilder loading methods should call listMessages with CleanInbox when unread > 0');
            expect(test?.fullName).toBe('createContextBuilder loading methods > should call listMessages with CleanInbox when unread > 0');
        });

        it('should preserve a literal " > " substring in a describe name verbatim', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                        name: 'Suite > with arrow in name',
                        type: 'describe',
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'works',
                        type:     'test',
                        parentId: 1,
                    },
                })
            );

            const test = client.getTest(2);
            expect(test?.bunName).toBe('Suite > with arrow in name works');
            expect(test?.fullName).toBe('Suite > with arrow in name > works');
        });

        it('should preserve a tab character in a title raw (no control-char substitution)', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                        name: 'Suite',
                        type: 'describe',
                    },
                })
            );

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: {
                        id:       2,
                        name:     'has\ttab',
                        type:     'test',
                        parentId: 1,
                    },
                })
            );

            const test = client.getTest(2);
            expect(test?.bunName).toBe('Suite has\ttab');
            expect(test?.fullName).toBe('Suite > has\ttab');
        });

        it('should set bunName equal to name (verbatim) for a root-level test', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                        name: 'RootTest',
                        type: 'test',
                        // No parentId
                    },
                })
            );

            const test = client.getTest(1);
            expect(test?.bunName).toBe('RootTest');
            expect(test?.fullName).toBe('RootTest');
        });
    });

    describe('getters', () => {
        it('should return all tests', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });
            const test = client.getTest(999);
            expect(test).toBeUndefined();
        });
    });

    describe('connection close handling', () => {
        it('should reject pending requests on unexpected close', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const sendPromise = client.send('TestReporter.enable', {});

            // Simulate unexpected close
            mockWs.close();

            const sendError = await sendPromise.catch((e: unknown) => e);
            expect(sendError).toBeInstanceOf(InspectorConnectionError);
            expect((sendError as InspectorConnectionError).message).toContain('Connection closed unexpectedly');
        });

        it('should handle close event while isClosing is true', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
            const sendError = await sendPromise.catch((e: unknown) => e);
            expect(sendError).toBeInstanceOf(InspectorConnectionError);
            expect((sendError as InspectorConnectionError).message).toContain('Connection closed');
        });
    });

    describe('method return values', () => {
        it('should return copy of execution order', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url:               'ws://localhost:6499',
                    connectionTimeout: 100,

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();

                jest.advanceTimersByTime(150);
                await Promise.resolve();

                const result = await connectPromise.catch((e: unknown) => e);
                expect(result).toBeInstanceOf(InspectorTimeoutError);
                expect((result as Error).name).toBe('InspectorTimeoutError');
            } finally {
                jest.useRealTimers();
            }
        });

        it('should have InspectorConnectionError as error name', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateError();

            const result = await connectPromise.catch((e: unknown) => e);
            expect(result).toBeInstanceOf(InspectorConnectionError);
            expect((result as Error).name).toBe('InspectorConnectionError');
        });
    });

    describe('connection timeout cleanup', () => {
        it('should close WebSocket and set to null on timeout', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url:               'ws://localhost:6499',
                    connectionTimeout: 10,

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();

                // Save reference to the mockWs before it might get replaced
                const wsInstance = mockWs;

                jest.advanceTimersByTime(20);
                await Promise.resolve();

                // Catch the rejection immediately to prevent unhandled error

                const result = await connectPromise.catch(e => e);

                expect(result).toBeInstanceOf(InspectorTimeoutError);

                expect(result.message).toContain('Connection timeout after 10ms');

                // Verify WebSocket was closed and nulled
                expect(wsInstance.readyState).toBe(WebSocket.CLOSED);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('WebSocket readyState checks', () => {
        it('should throw when WebSocket is CONNECTING', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            // Start connection but don't open
            const connectPromise = client.connect();

            // Try to send while still connecting

            const sendError1 = await client.send('TestReporter.enable', {}).catch((e: unknown) => e);
            expect((sendError1 as Error).message).toContain('WebSocket not connected');

            // Clean up
            mockWs.simulateOpen();
            await connectPromise;
            await client.close();
        });

        it('should throw when WebSocket is CLOSED', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Close and try to send
            await client.close();

            const sendError2 = await client.send('TestReporter.enable', {}).catch((e: unknown) => e);
            expect((sendError2 as Error).message).toContain('WebSocket not connected');
        });
    });

    describe('message ID increment', () => {
        it('should increment messageId for each request', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Send multiple requests (catching to prevent unhandled rejections)

            const p1 = client.send('Method1', {}).catch(() => {});

            const p2 = client.send('Method2', {}).catch(() => {});

            const p3 = client.send('Method3', {}).catch(() => {});

            // Verify message IDs are incrementing
            expect(mockWs.sentMessages.length).toBe(3);

            const msg1 = JSON.parse(mockWs.sentMessages[0]);

            const msg2 = JSON.parse(mockWs.sentMessages[1]);

            const msg3 = JSON.parse(mockWs.sentMessages[2]);

            expect(msg2.id).toBe(msg1.id + 1);

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
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Manually set to a closed state before calling close
            // eslint-disable-next-line require-atomic-updates -- mockWs is a test mock; no concurrent access
            mockWs.readyState = WebSocket.CLOSED;
            await client.close();

            // Should not throw, just handle gracefully
        });

        it('should return early when ws is null', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            // Close without ever connecting
            await client.close();

            // Should not throw
        });

        it('should set isClosing flag to prevent duplicate close handling', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
                url: 'ws://localhost:6499',

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
            const onError = mock((_error: Error) => {});

            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

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
                url: 'ws://localhost:6499',

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

        it('calls onUnexpectedClose exactly once with the expected context when the socket closes with no prior close()/expectClose()', async () => {
            const onUnexpectedClose = mock((_ctx: { wsClosed: boolean, closeExpected: boolean, isClosing: boolean }) => {});
            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onUnexpectedClose },

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            mockWs.close();

            expect(onUnexpectedClose).toHaveBeenCalledTimes(1);
            expect(onUnexpectedClose).toHaveBeenCalledWith({ wsClosed: true, closeExpected: false, isClosing: false });
        });

        it('does NOT call onUnexpectedClose after an explicit close()', async () => {
            const onUnexpectedClose = mock((_ctx: { wsClosed: boolean, closeExpected: boolean, isClosing: boolean }) => {});
            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onUnexpectedClose },

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            const closePromise = client.close();
            mockWs.close();
            await closePromise;

            expect(onUnexpectedClose).not.toHaveBeenCalled();
        });

        it('does NOT call onUnexpectedClose after expectClose()', async () => {
            const onUnexpectedClose = mock((_ctx: { wsClosed: boolean, closeExpected: boolean, isClosing: boolean }) => {});
            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onUnexpectedClose },

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            client.expectClose();
            mockWs.close();

            expect(onUnexpectedClose).not.toHaveBeenCalled();
        });

        it('does not throw when no onUnexpectedClose handler is registered and the socket closes unexpectedly', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            expect(() => mockWs.close()).not.toThrow();
        });
    });

    describe('send error handling', () => {
        it('should handle non-Error exceptions during send', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            // Mock send to throw a non-Error
            mockWs.send = () => {
                throw 'string error';
            };

            const sendError = await client.send('TestReporter.enable', {}).catch((e: unknown) => e);
            expect(String(sendError)).toContain('string error');
        });
    });

    describe('mutation-specific tests', () => {
        describe('line 222: isClosing BooleanLiteral mutation', () => {
            it('should prevent handleClose from running when close() is called explicitly', async () => {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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
                const sendError = await sendPromise.catch((e: unknown) => e);
                expect(sendError).toBeInstanceOf(InspectorConnectionError);
                expect((sendError as InspectorConnectionError).message).toContain('Connection closed');
                // If isClosing was false instead of true, handleClose would trigger and reject with "Connection closed unexpectedly"
            });
        });

        describe('line 233: ConditionalExpression readyState check mutation', () => {
            it('MUST call ws.close() when readyState is OPEN or CONNECTING', async () => {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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

                await connectPromise.catch(() => {});
            });

            it('should NOT close WebSocket when readyState is CLOSED', async () => {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Manually set WebSocket to CLOSED before calling close
                // eslint-disable-next-line require-atomic-updates -- mockWs is a test mock; no concurrent access
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
                    url: 'ws://localhost:6499',

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                // Manually set WebSocket to CLOSING
                // eslint-disable-next-line require-atomic-updates -- mockWs is a test mock; no concurrent access
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
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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
                    url: 'ws://localhost:6499',

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
                const onError = mock((_error: Error) => {});

                const client = new InspectorClient({
                    url:      'ws://localhost:6499',
                    handlers: { onError },

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
                const onError = mock((_error: Error) => {});

                const client = new InspectorClient({
                    url:      'ws://localhost:6499',
                    handlers: { onError },

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
                    url: 'ws://localhost:6499',

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
                const sendError = await sendPromise.catch((e: unknown) => e);
                expect((sendError as Error).message).toContain('Connection closed unexpectedly');

                // The error message MUST contain "unexpectedly" to prove handleClose ran
                expect((sendError as Error).message).toContain('unexpectedly');
            });

            it('should handle unexpected close when isClosing is false', async () => {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                const sendPromise = client.send('TestReporter.enable', {});

                // Simulate unexpected close (isClosing is false)
                mockWs.close();

                // Should reject with "Connection closed unexpectedly"
                const sendError = await sendPromise.catch((e: unknown) => e);
                expect((sendError as Error).message).toContain('Connection closed unexpectedly');
            });

            it('should NOT process close handler when isClosing is true', async () => {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

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
                const sendError = await sendPromise.catch((e: unknown) => e);
                expect((sendError as Error).message).toContain('Connection closed');
                expect((sendError as Error).message).not.toContain('Connection closed unexpectedly');
            });
        });
    });

    // expectClose()/waitForClose() let the runner drain the inspector socket before
    // snapshotting; wasClosedUnexpectedly flags a close that wasn't preceded by
    // expectClose(), which the runner's dry-run completeness gate treats as corroborating
    // context for a possibly-truncated inspector event stream.
    describe('expectClose / waitForClose / wasClosedUnexpectedly', () => {
        it('does not set wasClosedUnexpectedly when expectClose() is called before any close event', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            client.expectClose();
            mockWs.close();

            expect(client.wasClosedUnexpectedly).toBe(false);
        });

        it('sets wasClosedUnexpectedly when the socket closes with neither isClosing nor closeExpected set', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            expect(client.wasClosedUnexpectedly).toBe(false);

            // The incident shape: the WS dies mid-run before the runner has any idea
            // the run is over (neither close() nor expectClose() has run yet).
            mockWs.close();

            expect(client.wasClosedUnexpectedly).toBe(true);
        });

        it('waitForClose() resolves immediately when the socket is already closed, with no timer left dangling', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                mockWs.close();

                let resolved = false;
                const waitPromise = client.waitForClose(1000).then(() => {
                    resolved = true;
                    return resolved;
                });
                // No fake-timer advance at all: if a timer were created, this would hang.
                await waitPromise;
                expect(resolved).toBe(true);
                // No pending timers were ever scheduled by the immediate-resolve path.
                expect(jest.getTimerCount()).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });

        it('waitForClose(timeoutMs) resolves via the close event before the timeout fires, and clears the pending timer', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                let resolved = false;
                const waitPromise = client.waitForClose(1000).then(() => {
                    resolved = true;
                    return resolved;
                });

                // Timer is pending until the close event arrives.
                expect(jest.getTimerCount()).toBeGreaterThan(0);

                mockWs.close();
                await waitPromise;

                expect(resolved).toBe(true);
                // The timer scheduled for the timeout path must have been cleared —
                // no leaked timer once the close event has already resolved us.
                expect(jest.getTimerCount()).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });

        it('waitForClose(timeoutMs) resolves via the timeout when no close event ever arrives', async () => {
            jest.useFakeTimers();
            try {
                const client = new InspectorClient({
                    url: 'ws://localhost:6499',

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                let resolved = false;
                const waitPromise = client.waitForClose(1000).then(() => {
                    resolved = true;
                    return resolved;
                });

                expect(resolved).toBe(false);
                jest.advanceTimersByTime(1000);
                await waitPromise;
                expect(resolved).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('onError handler regression guard (inspector errors must be logged, not swallowed)', () => {
        it('invokes a real onError handler for "Test start event for unknown test ID"', async () => {
            const onError = mock((_e: Error) => {});
            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 999 },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toContain('Test start event for unknown test ID: 999');
        });

        it('invokes a real onError handler for a circular hierarchy reference', async () => {
            const onError = mock((_e: Error) => {});
            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: { id: 7, name: 'circular', type: 'test', parentId: 7 },
                })
            );

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toContain('Circular reference detected in test hierarchy:');
        });

        it('invokes a real onError handler for a WebSocket error event', async () => {
            const onError = mock((_e: Error) => {});
            const client = new InspectorClient({
                url:      'ws://localhost:6499',
                handlers: { onError },

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            mockWs.simulateError();

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0].message).toContain('WebSocket connection failed');
        });
    });

    describe('getMsSinceLastFrame', () => {
        it('tracks elapsed time since open, since the last valid message, and since a malformed message (stamped before parse)', async () => {
            let fakeNow = 1000;
            const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
            try {
                const onError = mock((_e: Error) => {});
                const client = new InspectorClient({
                    url:      'ws://localhost:6499',
                    handlers: { onError },

                    WebSocketClass: MockWebSocketConstructor,
                });

                const connectPromise = client.connect();
                mockWs.simulateOpen();
                await connectPromise;

                fakeNow = 1500;
                expect(client.getMsSinceLastFrame()).toBe(500);

                fakeNow = 1600;
                mockWs.simulateMessage(
                    JSON.stringify({
                        method: 'TestReporter.found',
                        params: { id: 1, name: 'test1', type: 'test' },
                    })
                );
                fakeNow = 1700;
                expect(client.getMsSinceLastFrame()).toBe(100);

                fakeNow = 2000;
                mockWs.simulateMessage('{ this is not valid JSON');
                expect(onError).toHaveBeenCalledTimes(1);

                fakeNow = 2050;
                expect(client.getMsSinceLastFrame()).toBe(50);
            } finally {
                dateNowSpy.mockRestore();
            }
        });
    });

    describe('getFoundIdGaps', () => {
        const found = (id: number): void => {
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: { id, name: `test${id}`, type: 'test' },
                })
            );
        };

        const makeClient = (): InspectorClient => new InspectorClient({
            url: 'ws://localhost:6499',

            WebSocketClass: MockWebSocketConstructor,
        });

        it('returns [] when no found events have been received', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            expect(client.getFoundIdGaps()).toEqual([]);
        });

        it('returns [] for a contiguous run of ids', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            found(1);
            found(2);
            found(3);
            expect(client.getFoundIdGaps()).toEqual([]);
        });

        it('returns the missing id in the middle of the range', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            found(1);
            found(3);
            expect(client.getFoundIdGaps()).toEqual([2]);
        });

        it('returns [] when only a single id has been found (window starts at min, not 1)', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            found(5);
            expect(client.getFoundIdGaps()).toEqual([]);
        });

        it('returns all missing ids between a non-1 min and max', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            found(5);
            found(9);
            expect(client.getFoundIdGaps()).toEqual([6, 7, 8]);
        });

        it('returns the single gap regardless of delivery order', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            found(2);
            found(4);
            expect(client.getFoundIdGaps()).toEqual([3]);
        });

        it('handles out-of-order delivery correctly (min/max loop boundary)', async () => {
            const client = makeClient();
            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            found(3);
            found(1);
            found(2);
            expect(client.getFoundIdGaps()).toEqual([]);
        });
    });

    describe('getEventCounts', () => {
        it('starts at zero and increments per-kind, including counting a start for an unknown id (counter precedes the early return)', async () => {
            const client = new InspectorClient({
                url: 'ws://localhost:6499',

                WebSocketClass: MockWebSocketConstructor,
            });

            const connectPromise = client.connect();
            mockWs.simulateOpen();
            await connectPromise;

            expect(client.getEventCounts()).toEqual({ found: 0, start: 0, end: 0 });

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: { id: 1, name: 'test1', type: 'test' },
                })
            );
            expect(client.getEventCounts()).toEqual({ found: 1, start: 0, end: 0 });

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 1 },
                })
            );
            expect(client.getEventCounts()).toEqual({ found: 1, start: 1, end: 0 });

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.end',
                    params: { id: 1, status: 'pass', elapsed: 10 },
                })
            );
            expect(client.getEventCounts()).toEqual({ found: 1, start: 1, end: 1 });

            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.found',
                    params: { id: 2, name: 'test2', type: 'test' },
                })
            );
            expect(client.getEventCounts()).toEqual({ found: 2, start: 1, end: 1 });

            // Start for an unknown id: still increments startCount even though
            // handleTestStart early-returns after the counter bump.
            mockWs.simulateMessage(
                JSON.stringify({
                    method: 'TestReporter.start',
                    params: { id: 999 },
                })
            );
            expect(client.getEventCounts()).toEqual({ found: 2, start: 2, end: 1 });
        });
    });
});
