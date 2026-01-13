/**
 * Bun Inspector Protocol client
 * Provides WebSocket-based test discovery and execution tracking
 */

export {
  InspectorClient,
  InspectorTimeoutError,
  InspectorConnectionError,
} from './inspector-client.js';

export type {
  InspectorClientOptions,
  InspectorEventHandlers,
} from './inspector-client.js';

export type {
  InspectorMessage,
  TestInfo,
  TestStatus,
  TestEntityType,
  TestReporterFoundEvent,
  TestReporterStartEvent,
  TestReporterEndEvent,
} from './types.js';

export {
  isTestReporterFoundEvent,
  isTestReporterStartEvent,
  isTestReporterEndEvent,
} from './types.js';
