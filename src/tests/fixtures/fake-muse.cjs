#!/usr/bin/env node
// Stands in for `muse exec --json` in cancellation/failure tests: emits one
// envelope (+ a text delta), then acts per FAKE_MUSE_MODE:
//   block (default) — wait for a signal; exit 130/143 like muse
//   exit1           — fail like a mid-turn muse error (no terminal event)
//   exit2           — usage error, nothing on stdout after the envelopes
// A Node script (not sh) because signal dispositions inherited as SIG_IGN —
// e.g. inside vitest fork workers — cannot be trapped by POSIX shells, while
// Node installs handlers regardless.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const mode = process.env.FAKE_MUSE_MODE ?? "block";
if (mode === "exit2") {
  process.stderr.write("usage: muse exec [OPTIONS] [PROMPT]\n");
  process.exit(2);
}

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
console.log(
  JSON.stringify({
    ...envelope,
    id: "fake-2",
    sequence: 2,
    record_type: "status",
    durability: "ephemeral",
    payload_type: "run.output.delta",
    payload: { kind: "run_output_delta", text: "thinking forever" },
  }),
);

if (mode === "exit1") {
  process.exit(1);
}

// Keep the event loop alive until a signal arrives.
setInterval(() => {}, 1000);
