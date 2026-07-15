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
    onTestFound?:       (test: TestInfo) => void
    /** Called when a test begins execution */
    onTestStart?:       (test: TestInfo) => void
    /** Called when a test completes execution */
    onTestEnd?:         (test: TestInfo) => void
    /** Called when an error occurs */
    onError?:           (error: Error) => void
    /** Called when the WebSocket closes while neither {@link InspectorClient.close} nor {@link InspectorClient.expectClose} had run yet */
    onUnexpectedClose?: (context: UnexpectedCloseContext) => void
    /**
     * Called when a specific request (e.g. TestReporter.enable) has gone
     * unanswered for {@link REQUEST_STALL_WARN_MS} while OTHER frames are still
     * arriving on the connection — a protocol-level stall distinct from total
     * silence (see {@link InspectorClient.getMsSinceLastFrame}): the read side
     * is alive and receiving something, just not a reply to this specific
     * request. Opt-in — scheduling the watchdog timer this requires is skipped
     * entirely for callers that never set this handler.
     */
    onRequestStall?:    (info: RequestStallInfo) => void
}

/**
 * Snapshot of the flags governing close-handling, passed to
 * {@link InspectorEventHandlers.onUnexpectedClose} so a logger can explain
 * why a given close was treated as unexpected without re-deriving the state
 * from InspectorClient internals. Also carries the raw WebSocket close
 * code/reason/wasClean and the close-relative-to-last-frame gap (see
 * {@link InspectorClient.getCloseInfo}) so an unexpected close can be
 * correlated against a confirmed Bun bug where idleTimeout:0 websockets are
 * force-closed on a ~252s ping cycle (ERR_WEBSOCKET_TIMEOUT) — see
 * INSPECTOR-PRODUCER-LOSS.md.
 */
export interface UnexpectedCloseContext {
    wsClosed:               boolean
    closeExpected:          boolean
    isClosing:              boolean
    /** WebSocket close code from the same close event that triggered this callback. */
    closeCode:              number | undefined
    /** WebSocket close reason from the same close event. */
    closeReason:            string | undefined
    /** WebSocket wasClean flag from the same close event. */
    closeWasClean:          boolean | undefined
    /** ms between the last received frame and this close event — see {@link InspectorClient.getCloseInfo}. */
    msFromLastFrameToClose: number | undefined
}

/**
 * WebSocket close code/reason/wasClean, and the gap between the last
 * received frame and the close event — see {@link InspectorClient.getCloseInfo}.
 * All fields undefined until the socket has actually closed.
 */
export interface InspectorCloseInfo {
    code:                   number | undefined
    reason:                 string | undefined
    wasClean:               boolean | undefined
    msFromLastFrameToClose: number | undefined
}

/**
 * Raw TestReporter.found event count vs. unique ids assigned, plus the
 * derived duplicate count — see {@link InspectorClient.getFoundIdCollisionStats}.
 */
export interface FoundIdCollisionStats {
    rawFoundCount:         number
    uniqueFoundIdCount:    number
    duplicateFoundIdCount: number
}

/** Payload for {@link InspectorEventHandlers.onRequestStall}. */
export interface RequestStallInfo {
    /** The inspector protocol method that has gone unanswered (e.g. 'TestReporter.enable'). */
    method:           string
    /** The request's correlation id. */
    id:               number
    /** How long the request had gone unanswered when this fired — always {@link REQUEST_STALL_WARN_MS}. */
    msUnanswered:     number
    /** {@link InspectorClient.getMsSinceLastFrame} at the moment this fired — proves other traffic was still arriving. */
    msSinceLastFrame: number
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
 * How long a request may go unanswered, while other frames are still
 * arriving, before {@link InspectorEventHandlers.onRequestStall} fires. Not
 * related to {@link InspectorClientOptions.requestTimeout} — this is an
 * early diagnostic signal, not a give-up bound; the request keeps waiting for
 * its own (usually much longer) timeout regardless of whether this fires.
 */
const REQUEST_STALL_WARN_MS = 2000;

/**
 * Pending request tracking
 */
interface PendingRequest {
    resolve:    (result: unknown) => void
    reject:     (error: Error) => void
    timer:      ReturnType<typeof setTimeout>
    /** Diagnostic watchdog timer for {@link InspectorEventHandlers.onRequestStall} — undefined when no such handler is registered. */
    stallTimer: ReturnType<typeof setTimeout> | undefined
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

    /**
   * Timestamp (ms, {@link Date.now}) of the last frame of ANY kind received on
   * this connection. Initialized at construction and refreshed on 'open' and
   * on every inbound message (including malformed ones) — proves the read
   * side of the socket is alive and making progress. See
   * {@link getMsSinceLastFrame}.
   */
    private lastFrameReceivedAt = Date.now();

    /** Running total of TestReporter.found events received. See {@link getEventCounts}. */
    private foundCount = 0;
    /** Running total of TestReporter.start events received. See {@link getEventCounts}. */
    private startCount = 0;
    /** Running total of TestReporter.end events received. See {@link getEventCounts}. */
    private endCount = 0;

    /**
   * WebSocket close code/reason/wasClean and the ms gap between the last
   * received frame and the close event, captured unconditionally the instant
   * {@link handleClose} runs (regardless of expected/unexpected) — see
   * {@link getCloseInfo}. Undefined until the socket has actually closed.
   */
    private closeCode:              number | undefined = undefined;
    private closeReason:            string | undefined = undefined;
    private closeWasClean:          boolean | undefined = undefined;
    private msFromLastFrameToClose: number | undefined = undefined;

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
                this.lastFrameReceivedAt = Date.now();
                resolve();
            });

            ws.addEventListener('error', () => {
                clearTimeout(timeoutTimer);
                const error = new InspectorConnectionError('WebSocket connection failed');
                this.handleError(error);
                reject(error);
            });

            ws.addEventListener('close', (event) => {
                this.handleClose(event.code, event.reason, event.wasClean);
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
   * @param timeoutMs Optional per-call override of the constructor-level requestTimeout — used by the
   * drain handshake, whose progress-extended wait must not be cut short by the fixed per-request timer
   * (see bun-test-runner.ts DRAIN_ACK_ABSOLUTE_CEILING_MS).
   * @returns Promise that resolves with the response result
   * @throws {InspectorTimeoutError} if request times out
   */
    async send(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- optional chain doesn't work here because null?.readyState === undefined, not !== OPEN
        if(!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new InspectorConnectionError('WebSocket not connected');
        }

        const id = ++this.messageId;
        const message: InspectorMessage = { id, method, params };

        // Stryker disable next-line BlockStatement: removing Promise body means resolve/reject never called → request hangs forever → Timeout
        return new Promise((resolve, reject) => {
            const effectiveTimeoutMs = timeoutMs ?? this.state.requestTimeout;

            // Diagnostic-only watchdog (see onRequestStall's doc comment) — strictly
            // opt-in, so this schedules nothing extra for any caller that hasn't
            // registered the handler. Declared before `timer` (which references it)
            // purely for definition order — `timer`'s callback is asynchronous and
            // cannot possibly run before this synchronous assignment completes.
            const stallTimer = this.handlers.onRequestStall
                ? setTimeout(() => {
                    // Guard: an already-settled request must not fire a stall warning —
                    // see 'does not fire onRequestStall once the request has already resolved'.
                    if(this.pendingRequests.has(id)) {
                        const msSinceLastFrame = this.getMsSinceLastFrame();
                        // Distinguishes "other traffic still arriving" (this signal) from total
                        // silence (a DIFFERENT signal, already covered by raceAgainstSilence in
                        // bun-test-runner.ts) — see 'does not fire onRequestStall when no frames
                        // have arrived at all'.
                        if(msSinceLastFrame < REQUEST_STALL_WARN_MS) {
                            this.handlers.onRequestStall!({ method, id, msUnanswered: REQUEST_STALL_WARN_MS, msSinceLastFrame });
                        }
                    }
                }, REQUEST_STALL_WARN_MS)
                : undefined;

            // Stryker disable next-line BlockStatement: removing setTimeout body means requests never timeout → Promise waits forever → Timeout
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                if(stallTimer) {
                    clearTimeout(stallTimer);
                }
                reject(new InspectorTimeoutError(`Request timeout after ${effectiveTimeoutMs}ms: ${method}`));
            }, effectiveTimeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timer, stallTimer });

            try {
                this.ws!.send(JSON.stringify(message));
            } catch (error) {
                this.pendingRequests.delete(id);
                clearTimeout(timer);
                if(stallTimer) {
                    clearTimeout(stallTimer);
                }
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
   * Clear both timers associated with a pending request — the request
   * timeout and, if scheduled, the {@link InspectorEventHandlers.onRequestStall}
   * watchdog. Extracted so every settlement path (response received,
   * explicit close, unexpected close) shares identical cleanup.
   */
    private clearPendingTimers(pending: PendingRequest): void {
        clearTimeout(pending.timer);
        if(pending.stallTimer) {
            clearTimeout(pending.stallTimer);
        }
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
            this.clearPendingTimers(pending);
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
   * Milliseconds since the last frame of ANY kind was received on this
   * connection (or since connect()/construction if none yet). Proves the
   * socket's read side is alive and making progress — consumed by the drain
   * handler's silence-based wait (bun-test-runner.ts step 6.5).
   */
    getMsSinceLastFrame(): number {
        return Date.now() - this.lastFrameReceivedAt;
    }

    /** Running totals of TestReporter.* events received, for computing backlog deltas around the drain handshake. */
    getEventCounts(): { found: number, start: number, end: number } {
        return { found: this.foundCount, start: this.startCount, end: this.endCount };
    }

    /**
   * WebSocket close code/reason/wasClean, and the ms gap between the last
   * received frame and the close event. All fields undefined until the
   * socket has actually closed. Recorded unconditionally — both expected and
   * unexpected closes — so a healthy close's code/reason establishes a
   * baseline to compare an unexpected one against. Exists to confirm or rule
   * out a confirmed Bun bug where idleTimeout:0 websockets are force-closed
   * on a ~252s ping cycle (ERR_WEBSOCKET_TIMEOUT) — see
   * INSPECTOR-PRODUCER-LOSS.md.
   */
    getCloseInfo(): InspectorCloseInfo {
        return {
            code:                   this.closeCode,
            reason:                 this.closeReason,
            wasClean:               this.closeWasClean,
            msFromLastFrameToClose: this.msFromLastFrameToClose,
        };
    }

    /**
   * Raw TestReporter.found event count vs. unique ids assigned. testHierarchy
   * is keyed by id, so a REPEATED id overwrites rather than growing the map —
   * the delta between raw and unique is exactly the count of found events
   * whose id had already been seen. A nonzero duplicate count is direct
   * in-the-wild evidence of Bun's confirmed TestReporter id-collision bug
   * (two interleaved 1..N id sequences when TestReporter.enable lands
   * mid-collection) — a DIFFERENT signal from {@link getFoundIdGaps}: a
   * collision keeps ids dense (it silently merges two tests under one shared
   * id), so density alone cannot detect it.
   */
    getFoundIdCollisionStats(): FoundIdCollisionStats {
        const uniqueFoundIdCount = this.testHierarchy.size;
        return {
            rawFoundCount:         this.foundCount,
            uniqueFoundIdCount,
            duplicateFoundIdCount: this.foundCount - uniqueFoundIdCount,
        };
    }

    /**
   * Ids strictly between the lowest and highest TestReporter.found ids received
   * that were themselves never received. ASSUMES Bun's inspector agent assigns
   * ids densely in discovery order — plausible from observed traces but NOT
   * verified against Bun internals, so treat a non-empty result as a diagnostic
   * signal (possible producer-side event drop), not ground truth. Derives
   * purely from testHierarchy; O(maxId-minId), no spread.
   */
    getFoundIdGaps(): number[] {
        if(this.testHierarchy.size === 0) {
            return [];
        }
        let min = Infinity;
        let max = -Infinity;
        for(const id of this.testHierarchy.keys()) {
            if(id < min) {
                min = id;
            }
            if(id > max) {
                max = id;
            }
        }
        const gaps: number[] = [];
        for(let id = min + 1; id < max; id++) {
            if(!this.testHierarchy.has(id)) {
                gaps.push(id);
            }
        }
        return gaps;
    }

    /**
   * Handle incoming WebSocket message
   */
    private handleMessage(data: string | Buffer): void {
        this.lastFrameReceivedAt = Date.now();
        try {
            const message = JSON.parse(data.toString()) as InspectorMessage;

            // Handle response to a request
            if(message.id !== undefined) {
                const pending = this.pendingRequests.get(message.id);
                // Stryker disable next-line BlockStatement: removing this body means pending requests never resolve/reject → all inspector calls hang → Timeout
                if(pending) {
                    this.pendingRequests.delete(message.id);
                    this.clearPendingTimers(pending);

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
        this.foundCount++;
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
        this.startCount++;
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
        this.endCount++;
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
    private handleClose(code?: number, reason?: string, wasClean?: boolean): void {
        // Always runs first, regardless of isClosing/closeExpected, so any pending
        // waitForClose() callers see the socket's actual closure as soon as it happens.
        this.wsClosed = true;

        // Recorded unconditionally (both expected and unexpected closes) — see
        // getCloseInfo's doc comment for why a healthy close's code/reason still matters
        // as a baseline. Computed here, before anything else can run, so it reflects the
        // gap between the close and the actual last frame, not any later activity.
        this.closeCode = code;
        this.closeReason = reason;
        this.closeWasClean = wasClean;
        this.msFromLastFrameToClose = Date.now() - this.lastFrameReceivedAt;

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

        if(this.handlers.onUnexpectedClose) {
            // At this call site wsClosed is always true and closeExpected/isClosing
            // always false (the guard above just failed) — passed anyway so the log is
            // self-explanatory and cannot silently go stale if the guard is refactored.
            this.handlers.onUnexpectedClose({
                wsClosed:               this.wsClosed,
                closeExpected:          this.closeExpected,
                isClosing:              this.isClosing,
                closeCode:              this.closeCode,
                closeReason:            this.closeReason,
                closeWasClean:          this.closeWasClean,
                msFromLastFrameToClose: this.msFromLastFrameToClose,
            });
        }

        // Reject all pending requests
        const error = new InspectorConnectionError('Connection closed unexpectedly');
        for(const pending of this.pendingRequests.values()) {
            this.clearPendingTimers(pending);
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
