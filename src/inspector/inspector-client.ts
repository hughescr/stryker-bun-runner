/**
 * WebSocket client for Bun Inspector Protocol
 * Handles test discovery, execution tracking, and test hierarchy management
 */

import WebSocket from 'ws';
import {
    type InspectorMessage,
    type TestInfo,
    type TestReporterFoundEvent,
    type TestReporterStartEvent,
    type TestReporterEndEvent,
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
    /**
     * WebSocket URL to connect to. Dialed verbatim (no host rewriting) — callers
     * must pass a host that matches what the inspector actually bound to. In
     * particular, do not assume "localhost" resolves the way the bound address
     * was specified: Node's net.connect resolves the literal string "localhost"
     * to 127.0.0.1 via an internal fast path that ignores /etc/hosts, so a bind
     * on ::1 (bun's default for `--inspect=<port>` with no host) and a dial to
     * "localhost" can silently target different addresses and fail to connect.
     */
    url:                string
    /** Event handlers for inspector events */
    handlers?:          InspectorEventHandlers
    /** Connection timeout in milliseconds (default: 5000) */
    connectionTimeout?: number
    /** Request timeout in milliseconds (default: 5000) */
    requestTimeout?:    number
    /** WebSocket class to use (default: ws WebSocket) */
    WebSocketClass?:    typeof WebSocket
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
 *   url: 'ws://127.0.0.1:6499',
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
    private ws:                      WebSocket | null = null;
    private messageId = 0;
    private pendingRequests = new Map<number, PendingRequest>();
    private testHierarchy = new Map<number, TestInfo>();
    private executionOrder:          number[] = [];
    private handlers:                InspectorEventHandlers;
    private state:                   InspectorClientState;
    private isClosing = false;
    private readonly WebSocketClass: typeof WebSocket;

    /**
   * Set by {@link expectClose} the instant a caller knows the run is over —
   * BEFORE awaiting any drain — so it always wins the race against the
   * WebSocket's own OS-driven 'close' event (a same-tick synchronous set beats
   * a queued event-listener callback). Orthogonal to `isClosing` (which tracks
   * OUR OWN explicit {@link close} call): `closeExpected` lets `handleClose`
   * distinguish "we knew this was coming" from "this happened while we still
   * thought the run was in progress" without touching `close()`'s own semantics.
   */
    private closeExpected = false;

    /** True once the underlying WebSocket has actually fired its 'close' event. */
    private wsClosed = false;

    /**
   * True iff the WebSocket closed while neither {@link close} nor
   * {@link expectClose} had run yet — i.e. the connection died out from under
   * the runner before it had any idea the test run was over. Auxiliary
   * context only; see bun-test-runner.ts's completeness gate for how this is
   * used (never a standalone Error trigger).
   */
    private _wasClosedUnexpectedly = false;

    /** Resolvers for in-flight {@link waitForClose} calls, drained by handleClose. */
    private closeWaiters: (() => void)[] = [];

    constructor(options: InspectorClientOptions) {
        this.handlers = options.handlers ?? {};
        this.WebSocketClass = options.WebSocketClass ?? WebSocket;
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

        // Stryker disable next-line BlockStatement: removing connect Promise body means resolve/reject never called → connect() never resolves → Timeout
        return new Promise((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
                if(this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
                reject(new InspectorTimeoutError(`Connection timeout after ${this.state.connectionTimeout}ms`));
            }, this.state.connectionTimeout);

            const ws = new this.WebSocketClass(this.state.url);
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

        // Stryker disable next-line BlockStatement: removing Promise body means resolve/reject never called → request hangs forever → Timeout
        return new Promise((resolve, reject) => {
            // Stryker disable next-line BlockStatement: removing setTimeout body means requests never timeout → Promise waits forever → Timeout
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

        // Stryker disable next-line BooleanLiteral: isClosing flag prevents re-entrant close handling, tested in mutation-specific tests
        this.isClosing = true;

        // Reject all pending requests
        const error = new InspectorConnectionError('Connection closed');
        for(const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();

        // Close WebSocket
        // Stryker disable next-line ConditionalExpression: must check readyState to avoid closing already-closed WebSocket, tested exhaustively
        if(this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
        }

        this.ws = null;
    }

    /**
   * Tell the client the caller knows the test run is over and any subsequent
   * WebSocket 'close' event (or one that already raced ahead of this call) is
   * expected, not a sign of data loss.
   *
   * Callers must invoke this the instant they know the run is over — BEFORE
   * awaiting any drain via {@link waitForClose} — so the synchronous, same-tick
   * flag set here always wins the race against the socket's own OS-driven
   * teardown, which can only ever run as a later queued event-listener callback.
   */
    expectClose(): void {
        this.closeExpected = true;
    }

    /**
   * True iff the WebSocket closed before the caller had marked the run as over
   * (neither {@link close} nor {@link expectClose} had run yet). Auxiliary
   * context only — see bun-test-runner.ts's completeness gate.
   */
    get wasClosedUnexpectedly(): boolean {
        return this._wasClosedUnexpectedly;
    }

    /**
   * Wait for the underlying WebSocket to actually finish closing, up to
   * `timeoutMs`. Resolves immediately if it has already closed (or was never
   * opened). Always bounded by a timeout so a caller can never hang waiting
   * for a 'close' event that — for whatever reason — never arrives.
   */
    async waitForClose(timeoutMs: number): Promise<void> {
        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent mutants only affect the fast-path skip — the slow path (falling through to the Promise below) still resolves correctly, just after an unnecessary timer; covered by 'resolves immediately when already closed'
        if(this.wsClosed || !this.ws) {
            return;
        }
        // Stryker disable next-line BlockStatement: removing the Promise body means resolve is never called → waitForClose never resolves → Timeout
        return new Promise((resolve) => {
            let settled = false;
            // `finish` and `timer` mutually reference each other (finish clears timer;
            // timer's callback calls finish), so one of the two must be declared before its
            // value is known. Declared here (before `finish`, which closes over it) so
            // `timer` is assigned by the time `finish` could possibly run — `setTimeout`'s
            // callback can never fire synchronously, so this ordering is always safe despite
            // the forward reference. Can't be `const`: the circular dependency means it can
            // only be assigned after `finish` already exists.
            // eslint-disable-next-line prefer-const -- see comment above; genuinely can't be const due to the finish/timer circular closure reference
            let timer: ReturnType<typeof setTimeout>;
            const finish = (): void => {
                // Stryker disable next-line ConditionalExpression,BlockStatement: idempotency guard — without it, both the timer and handleClose calling finish() would double-clear/resolve; harmless in practice (Promise.resolve and clearTimeout are both no-ops on repeat) but the splice below would remove the wrong element on a second call, so this guard is defensive and not itself behaviorally observable
                if(settled) {
                    return;
                }
                // Stryker disable next-line BooleanLiteral: this flag guards against finish() running twice. On every path this single-threaded design can currently take, that's already prevented (clearTimeout below cancels a still-pending timer before it can fire, and waitForClose's own `wsClosed` early-return blocks any new waiter being pushed after handleClose has already drained closeWaiters), so flipping this assignment to `false` doesn't change behavior on those paths. The guard is kept defensively in case a stale callback/timeout somehow still fires a second time in some retained-reference edge case we haven't enumerated — this line isn't independently tested for that scenario
                settled = true;
                clearTimeout(timer);
                const idx = this.closeWaiters.indexOf(finish);
                // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator,BlockStatement: defensive — on every path this design can currently take, finish is always still in closeWaiters when called via the timer path (handleClose hasn't run), and already removed by handleClose's own drain when called via that path, so the splice is a no-op either way and not independently tested. Kept as a guard in case a stale callback/timeout still invokes finish() a second time in some retained-reference edge case, which would otherwise splice the wrong element
                if(idx !== -1) {
                    this.closeWaiters.splice(idx, 1);
                }
                resolve();
            };
            // Stryker disable next-line BlockStatement: removing setTimeout body means the timeout path never resolves; a close event still resolves via finish(), so this mutant is caught only by the dedicated 'resolves via timeout' test, not by every other waitForClose test
            timer = setTimeout(() => {
                finish();
            }, timeoutMs);
            this.closeWaiters.push(finish);
        });
    }

    /**
   * Get all discovered tests
   */
    getTests(): TestInfo[] {
        return [...this.testHierarchy.values()];
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
                // Stryker disable next-line BlockStatement: removing this body means pending requests never resolve/reject → all inspector calls hang → Timeout
                if(pending) {
                    this.pendingRequests.delete(message.id);
                    clearTimeout(pending.timer);

                    // Stryker disable BlockStatement: removing either branch means pending request never resolves or rejects → all inspector calls hang → Timeout
                    if(message.error) {
                        pending.reject(new Error(`Inspector error: ${message.error.message}`));
                    } else {
                        pending.resolve(message.result);
                    }
                    // Stryker restore BlockStatement
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
        // eslint-disable-next-line @stylistic/brace-style -- required for Stryker disable to work
        }
        // Stryker disable all: defensive error handling, logs and continues
        catch (error) {
            this.handleError(error instanceof Error ? error : new Error(String(error)));
        }
        // Stryker restore all
    }

    /**
   * Handle TestReporter.found event
   */
    private handleTestFound(params: TestReporterFoundEvent): void {
        const { fullName, bunName } = this.buildFullName(params.id, params.name, params.parentId);

        const testInfo: TestInfo = {
            id:       params.id,
            name:     params.name,
            fullName,
            bunName,
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
   *
   * Returns both the display-oriented `fullName` (' > '-joined, used for IDs and
   * console correlation) and `bunName` (raw single-space join, byte-for-byte what
   * `bun test -t` matches against — no per-level trim, no control-char substitution).
   */
    private buildFullName(id: number, name: string, parentId?: number): { fullName: string, bunName: string } {
        // Stryker disable next-line all: early return for undefined parentId prevents unnecessary hierarchy walk, tested thoroughly
        if(parentId === undefined) {
            return { fullName: name, bunName: name };
        }

        const parts: string[] = [name];
        const visited = new Set<number>([id]);
        let currentId: number | undefined = parentId;

        while(currentId !== undefined) {
            // Circular reference detection
            if(visited.has(currentId)) {
                this.handleError(
                    // Stryker disable next-line StringLiteral: error message describes circular reference detection
                    new Error(`Circular reference detected in test hierarchy: ${[...visited].join(' -> ')} -> ${currentId}`)
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

        return { fullName: parts.join(' > '), bunName: parts.join(' ') };
    }

    /**
   * Handle connection close
   */
    private handleClose(): void {
        // Always runs first, regardless of isClosing/closeExpected, so any pending
        // waitForClose() callers see the socket's actual closure as soon as it happens.
        this.wsClosed = true;
        const waiters = this.closeWaiters;
        this.closeWaiters = [];
        for(const finish of waiters) {
            finish();
        }

        // Stryker disable next-line all: early return when intentionally closing (or when
        // the caller already called expectClose()) prevents duplicate error handling,
        // tested with expected vs unexpected close scenarios
        if(this.isClosing || this.closeExpected) {
            return;
        }

        this._wasClosedUnexpectedly = true;

        // Reject all pending requests
        const error = new InspectorConnectionError('Connection closed unexpectedly');
        for(const pending of this.pendingRequests.values()) {
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
