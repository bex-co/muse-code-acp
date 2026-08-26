import { describe, expect, it } from "vitest";
import { MuseEnvelope } from "../muse-events.js";
import { TurnTranslator } from "../translate.js";
import { silentLogger } from "./helpers.js";

export function envelope(payloadType: string, payload: Record<string, unknown>): MuseEnvelope {
  return {
    schema_version: 1,
    id: "test-id",
    stream: { kind: "session", id: "session-1" },
    sequence: 1,
    recorded_at: 0,
    record_type: "status",
    durability: "ephemeral",
    causation_id: "cause-1",
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  };
}

function translator(): TurnTranslator {
  return new TurnTranslator("acp-session", silentLogger());
}

describe("TurnTranslator text deltas", () => {
  it("maps run.output.delta to an agent_message_chunk", () => {
    const updates = translator().toUpdates(
      envelope("run.output.delta", { kind: "run_output_delta", text: "hi there" }),
    );

    expect(updates).toEqual([
      {
        sessionId: "acp-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi there" },
        },
      },
    ]);
  });

  it("drops empty text deltas", () => {
    const updates = translator().toUpdates(
      envelope("run.output.delta", { kind: "run_output_delta", text: "" }),
    );
    expect(updates).toEqual([]);
  });

  it("drops malformed run.output.delta payloads instead of throwing", () => {
    const updates = translator().toUpdates(
      envelope("run.output.delta", { kind: "run_output_delta", text: 42 }),
    );
    expect(updates).toEqual([]);
  });

  it("translates unknown payload types to nothing", () => {
    for (const type of [
      "task.lifecycle.started",
      "runtime.command.accepted",
      "something.new.from.muse-0.9",
    ]) {
      expect(translator().toUpdates(envelope(type, { kind: "x" }))).toEqual([]);
    }
  });
});
