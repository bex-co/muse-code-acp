import { describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { exportToUpdates } from "../session-export.js";
import { silentLogger } from "./helpers.js";

const wrap = (payload: Record<string, unknown>) => ({ envelope: { payload } });

describe("session history replay", () => {
  it("replays multi-turn history with tools and Unicode once, in order", () => {
    const doc = {
      export_schema_version: 1,
      events: [
        wrap({ kind: "run", event: { kind: "started", prompt: "first 你好" } }),
        wrap({
          kind: "task",
          task_id: "t1",
          event: {
            kind: "side_effect_intent",
            operation: "tool:bash",
            idempotency_key: "tool:call_a",
          },
        }),
        wrap({ kind: "task", task_id: "t1", event: { kind: "completed" } }),
        wrap({ kind: "run", event: { kind: "assistant_message_committed", text: "done 1" } }),
        wrap({ kind: "run", event: { kind: "started", prompt: "second" } }),
        wrap({
          kind: "task",
          task_id: "t2",
          event: {
            kind: "failed",
            operation: "tool:write_file",
            idempotency_key: "tool:call_b",
          },
        }),
        wrap({ kind: "run", event: { kind: "assistant_message_committed", text: "done 2" } }),
      ],
    };

    const updates = exportToUpdates("s1", doc, silentLogger()).map((n) => n.update);
    expect(updates).toMatchObject([
      { sessionUpdate: "user_message_chunk", content: { text: "first 你好" } },
      { sessionUpdate: "tool_call", toolCallId: "call_a", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "call_a", status: "completed" },
      { sessionUpdate: "agent_message_chunk", content: { text: "done 1" } },
      { sessionUpdate: "user_message_chunk", content: { text: "second" } },
      { sessionUpdate: "tool_call", toolCallId: "call_b", status: "failed" },
      { sessionUpdate: "agent_message_chunk", content: { text: "done 2" } },
    ]);
  });

  it("rejects unsupported export schemas instead of partial success", () => {
    expect(() =>
      exportToUpdates(
        "s1",
        {
          export_schema_version: 2,
          events: [wrap({ kind: "run", event: { kind: "started", prompt: "x" } })],
        },
        silentLogger(),
      ),
    ).toThrow(RequestError);
  });

  it("treats empty history as a successful empty replay", () => {
    expect(exportToUpdates("s1", { export_schema_version: 1, events: [] }, silentLogger())).toEqual(
      [],
    );
  });
});
