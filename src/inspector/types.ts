/**
 * TypeScript types for Bun Inspector Protocol
 * Based on the actual inspector events observed from bun-25986
 */

/**
 * Test status as reported by Bun's test runner
 */
export type TestStatus = 'pass' | 'fail' | 'skip' | 'todo';

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
