/**
 * TypeScript types for Bun Inspector Protocol
 * Based on the actual inspector events available in Bun 1.3.7+
 */

/**
 * Every status Bun's inspector reports in a TestReporter.end event (its
 * TestReporter.TestStatus protocol enum; the same six on bun 1.3.7, 1.3.14 and
 * 1.4.2):
 * - `pass` and `fail`;
 * - `timeout`: the test ran past its timeout. Bun counts it on its ' N fail'
 *   line, and it carries no error. It is a FAILED test;
 * - `skip` and the status of a pending test: skipped and pending tests;
 * - `skipped_because_label`: the test was filtered out by name (`-t`); bun's
 *   ' N filtered out' line counts it.
 * A status outside this list is a protocol change the runner does not know how
 * to score, and the dry-run completeness gate reports it.
 */
export const TEST_STATUSES = ['pass', 'fail', 'timeout', 'skip', 'todo', 'skipped_because_label'] as const;

/**
 * Test status as reported by Bun's test runner
 */
export type TestStatus = typeof TEST_STATUSES[number];

/**
 * Type of test entity
 */
export type TestEntityType = 'describe' | 'test';

/**
 * Base inspector message structure
 * All inspector protocol messages follow this structure
 */
export interface InspectorMessage {
    /** Message ID for request/response correlation */
    id?:     number
    /** Method name for events and requests */
    method?: string
    /** Parameters for methods and events */
    params?: unknown
    /** Result payload for responses */
    result?: unknown
    /** Error information if the request failed */
    error?: {
        code:    number
        message: string
        data?:   unknown
    }
}

/**
 * TestReporter.found event parameters
 * Emitted when a test or describe block is discovered
 */
export interface TestReporterFoundEvent {
    /** Unique identifier for this test entity */
    id:        number
    /** Display name of the test or describe block */
    name:      string
    /** Type of entity (test or describe block) */
    type:      TestEntityType
    /** Parent describe block ID (undefined for top-level entities) */
    parentId?: number
    /** File path where the test is defined */
    url?:      string
    /** Line number where the test is defined */
    line?:     number
}

/**
 * TestReporter.start event parameters
 * Emitted when a test begins execution
 */
export interface TestReporterStartEvent {
    /** ID of the test that is starting */
    id: number
}

/**
 * TestReporter.end event parameters
 * Emitted when a test completes execution
 */
export interface TestReporterEndEvent {
    /** ID of the test that completed */
    id:      number
    /** Final status of the test */
    status:  TestStatus
    /** Execution time in nanoseconds (Bun uses nanosecond precision) */
    elapsed: number
    /** Error information if the test failed */
    error?: {
        message: string
        stack?:  string
    }
}

/**
 * Internal representation of test information
 * Combines data from found, start, and end events
 */
export interface TestInfo {
    /** Unique identifier for this test entity */
    id:        number
    /** Display name of the test or describe block */
    name:      string
    /** Full hierarchical name (e.g., "Suite > Nested > Test") */
    fullName:  string
    /** Bun's exact internal matching name: raw per-level titles joined with a single
     *  space. NOT trimmed, control chars NOT substituted — byte-for-byte what
     *  `bun test -t` matches against (verified empirically, bun 1.3.14). */
    bunName?:  string
    /** Type of entity (test or describe block) */
    type:      TestEntityType
    /** Parent describe block ID (undefined for top-level entities) */
    parentId?: number
    /** File path where the test is defined */
    url?:      string
    /** Line number where the test is defined */
    line?:     number
    /** Current status (undefined if not started) */
    status?:   TestStatus
    /** Execution time in nanoseconds (undefined if not completed) */
    elapsed?:  number
    /** Error information if the test failed */
    error?: {
        message: string
        stack?:  string
    }
}

/**
 * Type guard to check if a message is a TestReporter.found event
 */
export function isTestReporterFoundEvent(
    message: InspectorMessage
): message is InspectorMessage & { params: TestReporterFoundEvent } {
    return message.method === 'TestReporter.found' && message.params !== undefined;
}

/**
 * Type guard to check if a message is a TestReporter.start event
 */
export function isTestReporterStartEvent(
    message: InspectorMessage
): message is InspectorMessage & { params: TestReporterStartEvent } {
    return message.method === 'TestReporter.start' && message.params !== undefined;
}

/**
 * Type guard to check if a message is a TestReporter.end event
 */
export function isTestReporterEndEvent(
    message: InspectorMessage
): message is InspectorMessage & { params: TestReporterEndEvent } {
    return message.method === 'TestReporter.end' && message.params !== undefined;
}
