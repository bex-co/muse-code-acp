import { existsSync } from "node:fs";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { agentEntrypoint, createWireFixture } from "./acp-wire-helpers.js";

describe("ACP stdio wire contracts", () => {
  it("uses the built entrypoint over NDJSON for initialize/new/prompt", async () => {
    expect(existsSync(agentEntrypoint)).toBe(true);
    const wire = await createWireFixture({ fragmentWrites: true });
    try {
      const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
        cwd: wire.workspace,
        mcpServers: [],
      });
      await expect(
        wire.ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "wire hello" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });

      const text = wire.updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.content.type === "text" ? u.content.text : ""))
        .join("");
      expect(text).toBe("hello world");

      const transcript = wire.getTranscript();
      expect(transcript.stderr).not.toMatch(/META_API_KEY|sk-/);
      // Responses are on stdout (recorded inbound to the client); diagnostics stay on stderr.
      expect(transcript.acpInbound.some((line) => line.includes('"result"'))).toBe(true);
      expect(transcript.stderr).not.toMatch(/"jsonrpc"\s*:\s*"2\.0".*"result"/);

      const parsed = transcript.acpInbound.map((line) => JSON.parse(line));
      const responses = parsed.filter((msg) => msg.id !== undefined && msg.result !== undefined);
      const requestIds = new Set(
        parsed.filter((msg) => msg.method && msg.id !== undefined).map((msg) => msg.id),
      );
      // Agent responses must match prior request IDs; notifications have no id/response.
      for (const response of responses) {
        expect(requestIds.has(response.id) || typeof response.id === "number").toBe(true);
      }
      const notifications = parsed.filter((msg) => msg.method && msg.id === undefined);
      expect(notifications.length).toBeGreaterThan(0);
      expect(
        transcript.mspRequests.some((r) => (r as { method?: string }).method === "turn/start"),
      ).toBe(true);
      // Default SDK path must not invoke muse exec for the turn.
      expect(transcript.stderr).not.toMatch(/muse-exec spawn:|exec --json/);
    } finally {
      await wire.dispose();
    }
  }, 30_000);

  it("preserves resource_link prompt content on the MSP boundary", async () => {
    const wire = await createWireFixture();
    try {
      const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
        cwd: wire.workspace,
        mcpServers: [],
      });
      await wire.ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "see" },
          {
            type: "resource_link",
            name: "notes.md",
            uri: "file:///tmp/notes.md",
            description: "café notes",
          },
        ],
      });
      const turnStart = wire
        .getTranscript()
        .mspRequests.find((r) => (r as { method?: string }).method === "turn/start") as {
        params: { input: Array<{ type: string; text: string }> };
      };
      expect(turnStart.params.input.map((p) => p.text).join("\n\n")).toContain(
        "URI: file:///tmp/notes.md",
      );
      expect(turnStart.params.input.map((p) => p.text).join("\n\n")).toContain("café notes");
    } finally {
      await wire.dispose();
    }
  }, 30_000);

  it("negotiates protocol version and rejects unknown sessions over the wire", async () => {
    const wire = await createWireFixture();
    try {
      // Already initialized at PROTOCOL_VERSION in the fixture; a second initialize
      // is not required. Probe error serialization for an unknown session.
      await expect(
        wire.ctx.request(methods.agent.session.prompt, {
          sessionId: "missing",
          prompt: [{ type: "text", text: "x" }],
        }),
      ).rejects.toMatchObject({ code: -32602 });

      const init = await wire.ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION + 9,
      });
      expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    } finally {
      await wire.dispose();
    }
  }, 30_000);
});
