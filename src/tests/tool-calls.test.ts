import { describe, expect, it } from "vitest";
import { SessionUpdate } from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseLineParser, MuseEnvelope } from "../muse-events.js";
import { TurnTranslator } from "../translate.js";
import { fixturesDir, silentLogger } from "./helpers.js";
import { envelope } from "./translate.test.js";

/**
 * Replays the recorded real-provider turn (write_file + bash cat + bash false,
 * muse 0.2.1) through the translator and returns the emitted updates.
 */
function replayFixture(): SessionUpdate[] {
  const envelopes: MuseEnvelope[] = [];
  const parser = new MuseLineParser((e) => envelopes.push(e));
  parser.push(readFileSync(join(fixturesDir, "real-tools.jsonl"), "utf8"));
  parser.end();

  const translator = new TurnTranslator("acp-session", silentLogger());
  return envelopes.flatMap((e) => translator.toUpdates(e).map((n) => n.update));
}

type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
type ToolCallUpdateUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;

describe("tool-call translation (real fixture)", () => {
  const updates = replayFixture();
  const toolCalls = updates.filter((u): u is ToolCallUpdate => u.sessionUpdate === "tool_call");
  const toolUpdates = updates.filter(
    (u): u is ToolCallUpdateUpdate => u.sessionUpdate === "tool_call_update",
  );

  it("opens a pending tool_call per tool side-effect intent", () => {
    const pending = toolCalls.filter((u) => u.status === "pending");
    expect(pending.map((u) => u.title).sort()).toEqual(["bash", "bash", "write_file"]);
    const kinds = new Map(pending.map((u) => [u.title, u.kind]));
    expect(kinds.get("bash")).toBe("execute");
    expect(kinds.get("write_file")).toBe("edit");
    for (const call of pending) {
      expect(call._meta).toEqual({ musePolicyDecision: "allow:policy" });
    }
  });

  it("completes the bash cat call with command title and output content", () => {
    const catUpdate = toolUpdates.find(
      (u) => u.title === "cat notes" || u.title === "cat notes.txt",
    );
    expect(catUpdate).toBeDefined();
    expect(catUpdate?.status).toBe("completed");
    const text = catUpdate?.content?.map((c) => (c.type === "content" ? c : null)).filter(Boolean);
    expect(JSON.stringify(text)).toContain("alpha");
  });

  it("marks the failing bash command failed", () => {
    const falseUpdate = toolUpdates.find((u) => u.title === "run false" || u.title === "false");
    expect(falseUpdate).toBeDefined();
    expect(falseUpdate?.status).toBe("failed");
  });

  it("upgrades the write_file call with the path and a location", () => {
    const writeUpdate = toolUpdates.find((u) => u.title?.startsWith("write_file: "));
    expect(writeUpdate).toBeDefined();
    expect(writeUpdate?.status).toBe("completed");
    expect(writeUpdate?.locations?.[0]?.path).toMatch(/notes\.txt$/);
  });

  it("surfaces argument-validation failures as one-shot failed tool_calls", () => {
    const rejected = toolCalls.filter((u) => u.status === "failed");
    expect(rejected.length).toBe(4);
    for (const call of rejected) {
      expect(JSON.stringify(call.content)).toContain("tool failed");
    }
  });

  it("emits nothing for model responses and observer tasks", () => {
    // 3 pending + 4 rejected tool_calls, 3 tool_call_updates, rest are text
    // chunks — nothing else leaks through from 231 envelopes.
    const other = updates.filter(
      (u) => u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update",
    );
    expect(new Set(other.map((u) => u.sessionUpdate))).toEqual(new Set(["agent_message_chunk"]));
  });
});

describe("tool-call translation (synthetic edges)", () => {
  it("handles a tool.result for an unknown call id without an intent", () => {
    const translator = new TurnTranslator("acp-session", silentLogger());
    const updates = translator.toUpdates(
      envelope("tool.result", {
        kind: "tool_result",
        call_id: "call_unseen",
        text: "tool failed: bad arguments",
      }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "call_unseen",
      status: "failed",
    });
  });

  it("treats a result with success outcome but no intent as completed", () => {
    const translator = new TurnTranslator("acp-session", silentLogger());
    const updates = translator.toUpdates(
      envelope("tool.result", {
        kind: "tool_result",
        call_id: "call_x",
        text: "plain output",
        correlation_facts: { tool_name: "read_file", outcome: "success" },
      }),
    );
    expect(updates[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      status: "completed",
      kind: "read",
    });
  });

  it("presents a write_file result as diff content read back from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-diff-test-"));
    const path = join(dir, "created.txt");
    writeFileSync(path, "fresh content\n");

    const translator = new TurnTranslator("acp-session", silentLogger());
    translator.toUpdates(
      envelope("task.lifecycle.side_effect_intent", {
        kind: "task_lifecycle",
        task_id: "t9",
        event: {
          kind: "side_effect_intent",
          task_id: "t9",
          operation: "tool:write_file",
          idempotency_key: "tool:call_w1",
          policy_decision: "allow:policy",
        },
      }),
    );
    const updates = translator.toUpdates(
      envelope("tool.result", {
        kind: "tool_result",
        call_id: "call_w1",
        text: `wrote 14 bytes to ${path}`,
        correlation_facts: { tool_name: "write_file", outcome: "success" },
      }),
    );

    expect(updates[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      content: [{ type: "diff", path, oldText: null, newText: "fresh content\n" }],
      locations: [{ path }],
    });
  });

  it("falls back to text content when the written file cannot be read", () => {
    const translator = new TurnTranslator("acp-session", silentLogger());
    const updates = translator.toUpdates(
      envelope("tool.result", {
        kind: "tool_result",
        call_id: "call_w2",
        text: "wrote 5 bytes to /nonexistent/path/gone.txt",
        correlation_facts: { tool_name: "write_file", outcome: "success" },
      }),
    );
    const update = updates[0].update as { content?: { type: string }[] };
    expect(update.content?.[0]?.type).toBe("content");
  });

  it("correlates interleaved parallel tool calls by call id", () => {
    const translator = new TurnTranslator("acp-session", silentLogger());
    const intent = (task: string, call: string, tool: string) =>
      envelope("task.lifecycle.side_effect_intent", {
        kind: "task_lifecycle",
        task_id: task,
        event: {
          kind: "side_effect_intent",
          task_id: task,
          operation: `tool:${tool}`,
          idempotency_key: `tool:${call}`,
          policy_decision: "allow:policy",
        },
      });
    const result = (call: string, tool: string, outcome: string) =>
      envelope("tool.result", {
        kind: "tool_result",
        call_id: call,
        text: JSON.stringify({ command: `${tool}-cmd`, description: "", output: "out" }),
        correlation_facts: { tool_name: tool, outcome },
      });

    // Both calls open before either settles; results arrive out of order.
    const opened = [
      ...translator.toUpdates(intent("tA", "call_A", "bash")),
      ...translator.toUpdates(intent("tB", "call_B", "bash")),
    ];
    const settled = [
      ...translator.toUpdates(result("call_B", "bash", "failure")),
      ...translator.toUpdates(result("call_A", "bash", "success")),
    ];

    expect(opened.map((n) => n.update)).toMatchObject([
      { sessionUpdate: "tool_call", toolCallId: "call_A", status: "pending" },
      { sessionUpdate: "tool_call", toolCallId: "call_B", status: "pending" },
    ]);
    expect(settled.map((n) => n.update)).toMatchObject([
      { sessionUpdate: "tool_call_update", toolCallId: "call_B", status: "failed" },
      { sessionUpdate: "tool_call_update", toolCallId: "call_A", status: "completed" },
    ]);
  });

  it("ignores non-tool side-effect intents", () => {
    const translator = new TurnTranslator("acp-session", silentLogger());
    const updates = translator.toUpdates(
      envelope("task.lifecycle.side_effect_intent", {
        kind: "task_lifecycle",
        task_id: "t1",
        event: {
          kind: "side_effect_intent",
          task_id: "t1",
          operation: "model.meta.response",
          idempotency_key: "model:x:y",
          policy_decision: "not_applicable",
        },
      }),
    );
    expect(updates).toEqual([]);
  });
});
