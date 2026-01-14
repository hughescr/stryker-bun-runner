/**
 * WebSocket client for Bun Inspector Protocol
 * Handles test discovery, execution tracking, and test hierarchy management
 */

import type {
    InspectorMessage,
    TestInfo,
    TestReporterFoundEvent,
    TestReporterStartEvent,
    TestReporterEndEvent
} from './types.js';
import {
    isTestReporterFoundEvent,
    isTestReporterStartEvent,
    isTestReporterEndEvent
} from './types.js';

/**
 * Event handlers for inspector protocol events
 */
export interface InspectorEventHandlers {
    /** Called when a test or describe block is discovered */
    onTestFound?: (test: TestInfo) => void
    /** Called when a test begins execution */
    onTestStart?: (test: TestInfo) => void
    /** Called when a test completes execution */
    onTestEnd?:   (test: TestInfo) => void
    /** Called when an error occurs */
    onError?:     (error: Error) => void
}

/**
 * Options for creating an InspectorClient
 */
export interface InspectorClientOptions {
    /** WebSocket URL to connect to */
    url:                string
    /** Event handlers for inspector events */
    handlers?:          InspectorEventHandlers
    /** Connection timeout in milliseconds (default: 5000) */
    connectionTimeout?: number
    /** Request timeout in milliseconds (default: 5000) */
    requestTimeout?:    number
}

/**
 * Internal client state
 */
interface InspectorClientState {
    url:               string
    connectionTimeout: number
    requestTimeout:    number
}

/**
 * Pending request tracking
 */
interface PendingRequest {
    resolve: (result: unknown) => void
    reject:  (error: Error) => void
    timer:   ReturnType<typeof setTimeout>
}

/**
 * Error thrown when a request times out
 */
export class InspectorTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InspectorTimeoutError';
    }
}

/**
 * Error thrown when the connection is closed
 */
export class InspectorConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InspectorConnectionError';
    }
}

/**
 * WebSocket client for Bun Inspector Protocol
 *
 * Features:
 * - Request/response correlation with automatic timeout handling
 * - Test hierarchy tracking with full name building
 * - Circular reference detection in test hierarchy
 * - Idempotent connection management
 * - Event-based test lifecycle notifications
 *
 * @example
 * ```typescript
 * const client = new InspectorClient({
 *   url: 'ws://localhost:6499',
 *   handlers: {
 *     onTestFound: (test) => console.log('Found:', test.fullName),
 *     onTestEnd: (test) => console.log('Completed:', test.fullName, test.status),
 *   },
 * });
 *
 * await client.connect();
 * await client.send('TestReporter.enable', {});
 * // ... wait for tests to complete
 * await client.close();
 * ```
 */
export class InspectorClient {
    private ws:             WebSocket | null = null;
    private messageId = 0;
    private pendingRequests = new Map<number, PendingRequest>();
    private testHierarchy = new Map<number, TestInfo>();
    private executionOrder: number[] = [];
    private handlers:       InspectorEventHandlers;
    private state:          InspectorClientState;
    private isClosing = false;

    constructor(options: InspectorClientOptions) {
        this.handlers = options.handlers ?? {};
        this.state = {
            url:               options.url,
            connectionTimeout: options.connectionTimeout ?? 5000,
            requestTimeout:    options.requestTimeout ?? 5000,
        };
    }

    /**
   * Connect to the inspector WebSocket
   * @throws {InspectorTimeoutError} if connection times out
   * @throws {InspectorConnectionError} if connection fails
   */
    async connect(): Promise<void> {
        if(this.ws) {
            throw new Error('Already connected');
        }

        return new Promise((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
                if(this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
                reject(new InspectorTimeoutError(`Connection timeout after ${this.state.connectionTimeout}ms`));
            }, this.state.connectionTimeout);

            const ws = new WebSocket(this.state.url);
            this.ws = ws;

            ws.addEventListener('open', () => {
                clearTimeout(timeoutTimer);
                resolve();
            });

            ws.addEventListener('error', () => {
                clearTimeout(timeoutTimer);
                const error = new InspectorConnectionError('WebSocket connection failed');
                this.handleError(error);
                reject(error);
            });

            ws.addEventListener('close', () => {
                this.handleClose();
            });

            ws.addEventListener('message', (event) => {
                this.handleMessage(event.data as string);
            });
        });
    }

    /**
   * Send a request and wait for response
   * @param method Method name to invoke
   * @param params Parameters for the method
   * @returns Promise that resolves with the response result
   * @throws {InspectorTimeoutError} if request times out
   */
    async send(method: string, params?: unknown): Promise<unknown> {
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- optional chain doesn't work here because null?.readyState === undefined, not !== OPEN
        if(!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new InspectorConnectionError('WebSocket not connected');
        }

        const id = ++this.messageId;
        const message: InspectorMessage = { id, method, params };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new InspectorTimeoutError(`Request timeout after ${this.state.requestTimeout}ms: ${method}`));
            }, this.state.requestTimeout);

            this.pendingRequests.set(id, { resolve, reject, timer });

            try {
                this.ws!.send(JSON.stringify(message));
            } catch (error) {
                this.pendingRequests.delete(id);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
   * Close the WebSocket connection
   * Idempotent - safe to call multiple times
   */
    async close(): Promise<void> {
        if(this.isClosing || !this.ws) {
            return;
        }

        this.isClosing = true;

        // Reject all pending requests
        const error = new InspectorConnectionError('Connection closed');
        for(const pending of Array.from(this.pendingRequests.values())) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();

        // Close WebSocket
        if(this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
        }

        this.ws = null;
    }

    /**
   * Get all discovered tests
   */
    getTests(): TestInfo[] {
        return Array.from(this.testHierarchy.values());
    }

    /**
   * Get test execution order (test IDs only, no describe blocks)
   */
    getExecutionOrder(): number[] {
        return [...this.executionOrder];
    }

    /**
   * Get a specific test by ID
   */
    getTest(id: number): TestInfo | undefined {
        return this.testHierarchy.get(id);
    }

    /**
   * Handle incoming WebSocket message
   */
    private handleMessage(data: string | Buffer): void {
        try {
            const message = JSON.parse(data.toString()) as InspectorMessage;

            // Handle response to a request
            if(message.id !== undefined) {
                const pending = this.pendingRequests.get(message.id);
                if(pending) {
                    this.pendingRequests.delete(message.id);
                    clearTimeout(pending.timer);

                    if(message.error) {
                        pending.reject(new Error(`Inspector error: ${message.error.message}`));
                    } else {
                        pending.resolve(message.result);
                    }
                }
                return;
            }

            // Handle events
            if(isTestReporterFoundEvent(message)) {
                this.handleTestFound(message.params);
            } else if(isTestReporterStartEvent(message)) {
                this.handleTestStart(message.params);
            } else if(isTestReporterEndEvent(message)) {
                this.handleTestEnd(message.params);
            }
        } catch (error) {
            this.handleError(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
   * Handle TestReporter.found event
   */
    private handleTestFound(params: TestReporterFoundEvent): void {
        const fullName = this.buildFullName(params.id, params.name, params.parentId);

        const testInfo: TestInfo = {
            id:       params.id,
            name:     params.name,
            fullName,
            type:     params.type,
            parentId: params.parentId,
            url:      params.url,
            line:     params.line,
        };

        this.testHierarchy.set(params.id, testInfo);

        if(this.handlers.onTestFound) {
            this.handlers.onTestFound(testInfo);
        }
    }

    /**
   * Handle TestReporter.start event
   */
    private handleTestStart(params: TestReporterStartEvent): void {
        const testInfo = this.testHierarchy.get(params.id);
        if(!testInfo) {
            this.handleError(new Error(`Test start event for unknown test ID: ${params.id}`));
            return;
        }

        // Only track execution order for actual tests, not describe blocks
        if(testInfo.type === 'test') {
            this.executionOrder.push(params.id);
        }

        if(this.handlers.onTestStart) {
            this.handlers.onTestStart(testInfo);
        }
    }

    /**
   * Handle TestReporter.end event
   */
    private handleTestEnd(params: TestReporterEndEvent): void {
        const testInfo = this.testHierarchy.get(params.id);
        if(!testInfo) {
            this.handleError(new Error(`Test end event for unknown test ID: ${params.id}`));
            return;
        }

        // Update test info with results
        testInfo.status = params.status;
        testInfo.elapsed = params.elapsed;
        if(params.error) {
            testInfo.error = params.error;
        }

        if(this.handlers.onTestEnd) {
            this.handlers.onTestEnd(testInfo);
        }
    }

    /**
   * Build full hierarchical name by walking parent chain
   * Detects circular references to prevent infinite loops
   */
    private buildFullName(id: number, name: string, parentId?: number): string {
        if(parentId === undefined) {
            return name;
        }

        const parts: string[] = [name];
        const visited = new Set<number>([id]);
        let currentId: number | undefined = parentId;

        while(currentId !== undefined) {
            // Circular reference detection
            if(visited.has(currentId)) {
                this.handleError(
                    new Error(`Circular reference detected in test hierarchy: ${Array.from(visited).join(' -> ')} -> ${currentId}`)
                );
                break;
            }
            visited.add(currentId);

            const parent = this.testHierarchy.get(currentId);
            if(!parent) {
                // Parent not yet discovered, stop here
                break;
            }

            parts.unshift(parent.name);
            currentId = parent.parentId;
        }

        return parts.join(' > ');
    }

    /**
   * Handle connection close
   */
    private handleClose(): void {
        if(this.isClosing) {
            return;
        }

        // Reject all pending requests
        const error = new InspectorConnectionError('Connection closed unexpectedly');
        for(const pending of Array.from(this.pendingRequests.values())) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();

        this.ws = null;
    }

    /**
   * Handle errors
   */
    private handleError(error: Error): void {
        if(this.handlers.onError) {
            this.handlers.onError(error);
        }
    }
}
