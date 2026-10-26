import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_MESSAGE_BYTES, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { agentEntrypoint, createWireFixture } from "./acp-wire-helpers.js";
import { fixturesDir, ensureExecutable } from "./helpers.js";

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
        '"uri":"file:///tmp/notes.md"',
      );
      expect(turnStart.params.input.map((p) => p.text).join("\n\n")).toContain("café notes");
    } finally {
      await wire.dispose();
    }
  }, 30_000);

  it("accepts attributed embedded text and rejects binary resources before starting a turn", async () => {
    const wire = await createWireFixture();
    try {
      const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
        cwd: wire.workspace,
        mcpServers: [],
      });
      await expect(
        wire.ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "resource", resource: { uri: "file:///binary", blob: "YQ==" } }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(
        wire
          .getTranscript()
          .mspRequests.some((r) => (r as { method?: string }).method === "turn/start"),
      ).toBe(false);
      const resource = {
        uri: "untitled:///buffer.ts",
        mimeType: "text/typescript",
        text: '  unsaved\n"quoted"\n',
      };
      await expect(
        wire.ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "resource", resource }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      const turn = wire
        .getTranscript()
        .mspRequests.find((r) => (r as { method?: string }).method === "turn/start") as {
        params: { input: Array<{ text: string }> };
      };
      expect(
        JSON.parse(turn.params.input[0].text.slice("Embedded text resource: ".length)),
      ).toEqual({ resource });
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

  it("exits with the reason when a message exceeds the SDK's size limit", async () => {
    const fakeMsp = join(fixturesDir, "fake-msp.cjs");
    ensureExecutable(fakeMsp);
    const child = spawn(process.execPath, [agentEntrypoint], {
      env: { ...process.env, MUSE_CODE_EXECUTABLE: fakeMsp },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.write("x".repeat(DEFAULT_MAX_MESSAGE_BYTES + 1) + "\n");
    expect(await exited).toBe(1);
    expect(stderr).toContain(`exceeds the configured ${DEFAULT_MAX_MESSAGE_BYTES} byte limit`);
  }, 30_000);
});
