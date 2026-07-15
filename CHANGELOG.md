# Changelog

## 1.3.7

Diagnostics-only release: no behavior changes to gates, retries, or waits — the
dry-run completeness gate, drain handshake bounds, and all thresholds are
untouched. This release exists to close the two evidence gaps identified in the
forensic review of the CI "inspector producer loss" incident (see
`INSPECTOR-PRODUCER-LOSS.md`), so the next occurrence yields decisive evidence
about the two suspected Bun bugs.

### Added

- **WebSocket close code/reason capture** — `InspectorClient` now records the
  inspector socket's close `code`, `reason`, and `wasClean` (previously
  discarded), plus the elapsed ms between the last received frame and the close
  event. Exposed via `InspectorClient.getCloseInfo()`, included in the
  `onUnexpectedClose` handler context (and its DEBUG log line), logged in the
  new WARN-level `Post-drain inspector close/collision diagnostics` line, and
  appended to the completeness gate's error message when the socket closed
  unexpectedly. Purpose: a confirmed Bun bug force-closes `idleTimeout: 0`
  websockets on a ~252-second ping cycle (`ERR_WEBSOCKET_TIMEOUT`); capturing
  the close code/reason confirms or kills that attribution instantly on the
  next incident.
- **Collision-aware found counters** — `InspectorClient` now tracks the raw
  `TestReporter.found` event count separately from the unique-id count and
  derives a duplicate-id count (`getFoundIdCollisionStats()`), all logged in
  the same post-drain diagnostics line. A nonzero duplicate count is direct
  in-the-wild evidence of the confirmed Bun TestReporter id-collision bug (two
  interleaved `1..N` id sequences when `TestReporter.enable` lands
  mid-collection), which the existing found-id-gap metric structurally cannot
  detect — collisions keep ids dense while silently merging distinct tests
  under one shared id. The gap metric is retained but its log line now states
  explicitly that density does not prove losslessness under collisions.
- **Request-stall watchdog** — a new opt-in `onRequestStall` handler on
  `InspectorClient` fires when an inspector protocol request (e.g.
  `TestReporter.enable`) goes unanswered for more than 2 seconds while other
  frames are still arriving on the same connection; the runner wires it to a
  WARN log line. This distinguishes a protocol-level stall (read side alive,
  requests ignored) from the total-silence give-up the drain handshake already
  detects.
