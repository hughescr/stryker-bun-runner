import { describe, it, expect } from 'bun:test';
import {
    isTestReporterFoundEvent,
    isTestReporterStartEvent,
    isTestReporterEndEvent,
    type InspectorMessage,
    type TestReporterFoundEvent,
    type TestReporterStartEvent,
    type TestReporterEndEvent
} from '../../src/inspector/types.js';

describe('Inspector Type Guards', () => {
    describe('isTestReporterFoundEvent', () => {
        it('should return true for valid TestReporter.found event', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                params: {
                    id:   1,
                    name: 'test name',
                    type: 'test'
                } as TestReporterFoundEvent
            };
            expect(isTestReporterFoundEvent(message)).toBe(true);
        });

        it('should return true for TestReporter.found event with all optional fields', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                params: {
                    id:       1,
                    name:     'test name',
                    type:     'describe',
                    parentId: 0,
                    url:      'file:///test.ts',
                    line:     42
                } as TestReporterFoundEvent
            };
            expect(isTestReporterFoundEvent(message)).toBe(true);
        });

        it('should return false when method is wrong', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.start',
                params: {
                    id:   1,
                    name: 'test name',
                    type: 'test'
                }
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });

        it('should return false when method is missing', () => {
            const message: InspectorMessage = {
                params: {
                    id:   1,
                    name: 'test name',
                    type: 'test'
                }
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });

        it('should return false when params is undefined', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                params: undefined
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });

        it('should return false when params is missing', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found'
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });

        it('should return false for TestReporter.end method', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.end',
                params: {
                    id:      1,
                    status:  'pass',
                    elapsed: 100
                }
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });

        it('should return false for completely different method', () => {
            const message: InspectorMessage = {
                method: 'SomeOther.method',
                params: { data: 'value' }
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });
    });

    describe('isTestReporterStartEvent', () => {
        it('should return true for valid TestReporter.start event', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.start',
                params: {
                    id: 1
                } as TestReporterStartEvent
            };
            expect(isTestReporterStartEvent(message)).toBe(true);
        });

        it('should return false when method is wrong', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                params: { id: 1 }
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });

        it('should return false when method is missing', () => {
            const message: InspectorMessage = {
                params: { id: 1 }
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });

        it('should return false when params is undefined', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.start',
                params: undefined
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });

        it('should return false when params is missing', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.start'
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });

        it('should return false for TestReporter.end method', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.end',
                params: {
                    id:      1,
                    status:  'pass',
                    elapsed: 100
                }
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });

        it('should return false for completely different method', () => {
            const message: InspectorMessage = {
                method: 'SomeOther.method',
                params: { data: 'value' }
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });
    });

    describe('isTestReporterEndEvent', () => {
        it('should return true for valid TestReporter.end event', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.end',
                params: {
                    id:      1,
                    status:  'pass',
                    elapsed: 100
                } as TestReporterEndEvent
            };
            expect(isTestReporterEndEvent(message)).toBe(true);
        });

        it('should return true for TestReporter.end event with error', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.end',
                params: {
                    id:      1,
                    status:  'fail',
                    elapsed: 100,
                    error:   {
                        message: 'Test failed',
                        stack:   'Error: Test failed\n  at ...'
                    }
                } as TestReporterEndEvent
            };
            expect(isTestReporterEndEvent(message)).toBe(true);
        });

        it('should return true for different test statuses', () => {
            const statuses: ('pass' | 'fail' | 'skip' | 'todo')[] = ['pass', 'fail', 'skip', 'todo'];
            statuses.forEach((status) => {
                const message: InspectorMessage = {
                    method: 'TestReporter.end',
                    params: {
                        id:      1,
                        status,
                        elapsed: 100
                    } as TestReporterEndEvent
                };
                expect(isTestReporterEndEvent(message)).toBe(true);
            });
        });

        it('should return false when method is wrong', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.start',
                params: {
                    id:      1,
                    status:  'pass',
                    elapsed: 100
                }
            };
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should return false when method is missing', () => {
            const message: InspectorMessage = {
                params: {
                    id:      1,
                    status:  'pass',
                    elapsed: 100
                }
            };
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should return false when params is undefined', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.end',
                params: undefined
            };
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should return false when params is missing', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.end'
            };
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should return false for TestReporter.found method', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                params: {
                    id:   1,
                    name: 'test name',
                    type: 'test'
                }
            };
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should return false for completely different method', () => {
            const message: InspectorMessage = {
                method: 'SomeOther.method',
                params: { data: 'value' }
            };
            expect(isTestReporterEndEvent(message)).toBe(false);
        });
    });

    describe('Edge cases for all type guards', () => {
        it('should handle empty object as message', () => {
            const message: InspectorMessage = {};
            expect(isTestReporterFoundEvent(message)).toBe(false);
            expect(isTestReporterStartEvent(message)).toBe(false);
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should handle message with only id field', () => {
            const message: InspectorMessage = { id: 1 };
            expect(isTestReporterFoundEvent(message)).toBe(false);
            expect(isTestReporterStartEvent(message)).toBe(false);
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should handle message with empty string method', () => {
            const message: InspectorMessage = {
                method: '',
                params: { id: 1 }
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
            expect(isTestReporterStartEvent(message)).toBe(false);
            expect(isTestReporterEndEvent(message)).toBe(false);
        });

        it('should handle message with null params', () => {
            // Note: The type guards check !== undefined, so null passes the check
            // This is arguably a bug, but matches current implementation
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                params: null
            };
            expect(isTestReporterFoundEvent(message)).toBe(true);

            const message2: InspectorMessage = {
                method: 'TestReporter.start',
                params: null
            };
            expect(isTestReporterStartEvent(message2)).toBe(true);

            const message3: InspectorMessage = {
                method: 'TestReporter.end',
                params: null
            };
            expect(isTestReporterEndEvent(message3)).toBe(true);
        });

        it('should handle message with result instead of params', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.found',
                result: { id: 1 }
            };
            expect(isTestReporterFoundEvent(message)).toBe(false);
        });

        it('should handle message with error instead of params', () => {
            const message: InspectorMessage = {
                method: 'TestReporter.start',
                error:  {
                    code:    1,
                    message: 'Error'
                }
            };
            expect(isTestReporterStartEvent(message)).toBe(false);
        });

        it('should handle message with similar but wrong method names', () => {
            const similarMethods = [
                'TestReporter.Found',  // Wrong case
                'TestReporter.FOUND',  // All caps
                'testReporter.found',  // Wrong case
                'TestReporter.founded', // Extra chars
                'TestReporte.found',   // Missing char
                'TestReporter.foun',   // Truncated
                ' TestReporter.found', // Leading space
                'TestReporter.found ', // Trailing space
            ];

            similarMethods.forEach((method) => {
                const message: InspectorMessage = {
                    method,
                    params: { id: 1 }
                };
                expect(isTestReporterFoundEvent(message)).toBe(false);
            });
        });
    });
});
