#!/usr/bin/env node
// Stands in for `muse exec --json` in cancellation tests: emits one envelope,
// then blocks until signalled, exiting with muse's conventional signal codes.
// A Node script (not sh) because signal dispositions inherited as SIG_IGN —
// e.g. inside vitest fork workers — cannot be trapped by POSIX shells, while
// Node installs handlers regardless.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const envelope = {
  schema_version: 1,
  id: "fake-1",
  stream: { kind: "session", id: "11111111-1111-4111-8111-111111111111" },
  sequence: 1,
  recorded_at: 0,
  record_type: "event",
  durability: "durable",
  causation_id: "22222222-2222-4222-8222-222222222222",
  payload_type: "run.lifecycle.started",
  payload_schema_version: 1,
  payload: { kind: "run_started", prompt: "fake" },
};
console.log(JSON.stringify(envelope));

// Keep the event loop alive until a signal arrives.
setInterval(() => {}, 1000);
