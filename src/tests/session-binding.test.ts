import { describe, it, expect, vi } from "vitest";
import * as store from "../session-store.js";
import * as history from "../session-export.js";
import { connectTestClient, fakeMuseBinary, newTestSession } from "./helpers.js";

describe("session binding races", () => {
  it("rejects close, prompt and duplicate load while history is being read", async () => {
    const client = connectTestClient({
      backend: "exec",
      museBinary: fakeMuseBinary(),
      env: { ...process.env, FAKE_MUSE_MODE: "exit0" },
    });
    const { sessionId, cwd } = await newTestSession(client);
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof history.runMuseExport>>>();
    const list = vi.spyOn(store, "listStoredSessions").mockReturnValue([
      {
        sessionId,
        cwd,
        logPath: "/unused/session.jsonl",
        title: "test",
        updatedAt: "2026-09-12T00:00:00Z",
      },
    ]);
    const read = vi.spyOn(history, "runMuseExport").mockReturnValue(gate.promise);
    try {
      const load = client.agent.loadSession({ sessionId, cwd, mcpServers: [] });
      await expect(client.agent.closeSession({ sessionId })).rejects.toMatchObject({
        code: -32600,
      });
      await expect(
        client.agent.prompt({ sessionId, prompt: [{ type: "text", text: "race" }] }),
      ).rejects.toMatchObject({ code: -32600 });
      await expect(
        client.agent.loadSession({ sessionId, cwd, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32600 });
      gate.resolve({ export_schema_version: 1, events: [] });
      await load;
      await expect(client.agent.closeSession({ sessionId })).resolves.toEqual({});
      expect(client.agent.sessions.has(sessionId)).toBe(false);
    } finally {
      read.mockRestore();
      list.mockRestore();
      await client.agent.dispose();
    }
  });
});
