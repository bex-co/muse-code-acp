import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportToUpdates, runMuseExport } from "../session-export.js";
import {
  connectTestClient,
  fakeMuseBinary,
  initialized,
  museAvailable,
  silentLogger,
} from "./helpers.js";

describe("exportToUpdates", () => {
  const wrap = (payload: Record<string, unknown>) => ({ envelope: { payload } });

  it("replays prompts, replies, and tool calls in order", () => {
    const doc = {
      export_schema_version: 1,
      events: [
        wrap({ kind: "run", event: { kind: "started", prompt: "do the thing" } }),
        wrap({
          kind: "task",
          task_id: "t1",
          event: {
            kind: "side_effect_intent",
            operation: "tool:bash",
            idempotency_key: "tool:call_1",
          },
        }),
        wrap({ kind: "task", task_id: "t1", event: { kind: "completed" } }),
        wrap({ kind: "run", event: { kind: "assistant_message_committed", text: "done" } }),
      ],
    };

    const updates = exportToUpdates("s1", doc, silentLogger()).map((n) => n.update);
    expect(updates).toMatchObject([
      { sessionUpdate: "user_message_chunk", content: { text: "do the thing" } },
      { sessionUpdate: "tool_call", toolCallId: "call_1", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" },
      { sessionUpdate: "agent_message_chunk", content: { text: "done" } },
    ]);
  });

  it("replays under a drifted export schema with a warning instead of failing", () => {
    const doc = {
      export_schema_version: 2,
      events: [wrap({ kind: "run", event: { kind: "started", prompt: "still works" } })],
    };
    const logged: string[] = [];
    const updates = exportToUpdates("s1", doc, {
      log: (...a) => logged.push(a.join(" ")),
      error: () => {},
    });
    expect(updates).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/schema 2/);
  });

  it("skips model tasks and unknown kinds silently", () => {
    const doc = {
      export_schema_version: 1,
      events: [
        wrap({
          kind: "task",
          task_id: "t2",
          event: { kind: "side_effect_intent", operation: "model.meta.response" },
        }),
        wrap({ kind: "task", task_id: "t2", event: { kind: "completed" } }),
        wrap({ kind: "run", event: { kind: "context_block_diagnostic" } }),
        wrap({}),
      ],
    };
    expect(exportToUpdates("s1", doc, silentLogger())).toEqual([]);
  });
});

describe("runMuseExport failure", () => {
  it("rejects with the export error detail", async () => {
    await expect(runMuseExport(crypto.randomUUID(), process.env, fakeMuseBinary())).rejects.toThrow(
      /muse export exited 2: no session found/,
    );
  });
});

describe.skipIf(!museAvailable())("session list + load round trip (live echo)", () => {
  it("lists a finished session and replays it on load, then continues", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-load-xdg-"));
    const env = { ...process.env, XDG_DATA_HOME: xdg };
    const cwd = mkdtempSync(join(tmpdir(), "muse-load-cwd-"));

    // Session 1: create history.
    const first = connectTestClient({ provider: "echo", env });
    const firstCtx = await initialized(first);
    const { sessionId } = await firstCtx.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    await firstCtx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat token history" }],
    });

    // Fresh client: list, load, continue.
    const second = connectTestClient({ provider: "echo", env });
    const ctx = await initialized(second);

    const { sessions } = await ctx.request(methods.agent.session.list, { cwd });
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);
    expect(sessions.find((s) => s.sessionId === sessionId)?.title).toContain(
      "repeat token history",
    );

    const loadResponse = await ctx.request(methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    });
    expect(loadResponse.modes?.currentModeId).toBe("default");

    const replayed = second.updates.map((u) => u.update);
    expect(JSON.stringify(replayed)).toContain("repeat token history");
    expect(JSON.stringify(replayed)).toContain("echo: repeat token history");

    const continued = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat token resumed" }],
    });
    expect(continued.stopReason).toBe("end_turn");
    const chunks = second.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(chunks).toContain("echo: repeat token resumed");
  }, 120_000);

  it("rejects loading a session that is not in the store", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-load-xdg-"));
    const testClient = connectTestClient({
      provider: "echo",
      env: { ...process.env, XDG_DATA_HOME: xdg },
    });
    const ctx = await initialized(testClient);

    await expect(
      ctx.request(methods.agent.session.load, {
        sessionId: crypto.randomUUID(),
        cwd: mkdtempSync(join(tmpdir(), "muse-load-cwd-")),
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
