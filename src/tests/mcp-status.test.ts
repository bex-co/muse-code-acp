import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mcpStatus } from "../mcp-status.js";
import { connectTestClient, initialized, fakeMuseBinary } from "./helpers.js";

it("reports inventory without disclosing configuration values or inventing connectivity", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-status-"));
  mkdirSync(join(root, "muse"));
  const file = join(root, "muse/settings.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        mcp_servers: { local: { transport: "stdio", command: "secret-command" } },
        mcpServers: {
          remote: {
            type: "http",
            url: "https://secret-host/?key=secret",
            headers: { authorization: "secret-token" },
          },
        },
      }),
    );
    const status = mcpStatus([], { XDG_CONFIG_HOME: root });
    expect(status).toContain('"local": stdio; configured; connection unknown');
    expect(status).toContain('"remote": http; configured; connection unknown');
    expect(status).not.toContain("secret");
    writeFileSync(file, "secret-malformed-json");
    expect(mcpStatus([], { XDG_CONFIG_HOME: root })).toContain("configuration unavailable");
    expect(mcpStatus([], { XDG_CONFIG_HOME: root })).not.toContain("secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("handles /mcp locally, reserves its name and rejects malformed inputs before session creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-command-"));
  const client = connectTestClient({
    backend: "sdk",
    museBinary: fakeMuseBinary(),
    skipSdkHostCheck: true,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root },
  });
  try {
    const ctx = await initialized(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: root,
      mcpServers: [],
    });
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/mcp status" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(JSON.stringify(client.updates)).toContain("No MCP servers configured");
    // Local: no turn ran (the session's host may already be prewarmed).
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
    await expect
      .poll(() =>
        client.updates.some(
          (n) =>
            n.update.sessionUpdate === "available_commands_update" &&
            n.update.availableCommands.some((c) => c.name === "mcp"),
        ),
      )
      .toBe(true);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "/mcp status" },
          { type: "resource", resource: { uri: "file:///context", text: "context" } },
        ],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
    await expect(
      ctx.request(methods.agent.session.new, {
        cwd: root,
        mcpServers: [{ type: "http", name: "bad", url: "file:///secret", headers: [] }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(client.agent.sessions.size).toBe(1);
    await expect(
      ctx.request(methods.agent.session.resume, {
        sessionId,
        cwd: root,
        mcpServers: [{ type: "sse", name: "bad", url: "http://localhost", headers: [] }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(client.agent.sessions.get(sessionId)?.mcpServers).toEqual([]);
  } finally {
    await client.agent.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("close waits for a local MCP response and prevents another prompt from overtaking it", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-close-"));
  const client = connectTestClient({
    backend: "sdk",
    museBinary: fakeMuseBinary(),
    skipSdkHostCheck: true,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root },
  });
  const release = Promise.withResolvers<void>();
  try {
    const ctx = await initialized(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: root,
      mcpServers: [],
    });
    const original = client.agent.client.sessionUpdate.bind(client.agent.client);
    let delivering = false;
    client.agent.client.sessionUpdate = async (notification) => {
      if (notification.update.sessionUpdate === "agent_message_chunk") {
        delivering = true;
        await release.promise;
      }
      return original(notification);
    };
    const prompt = client.agent.prompt({ sessionId, prompt: [{ type: "text", text: "/mcp" }] });
    await expect.poll(() => delivering).toBe(true);
    await expect(
      client.agent.prompt({ sessionId, prompt: [{ type: "text", text: "/mcp" }] }),
    ).rejects.toMatchObject({ code: -32600 });
    let closed = false;
    const close = client.agent.closeSession({ sessionId }).then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect(await prompt).toEqual({ stopReason: "cancelled" });
    await close;
    expect(client.agent.sessions.has(sessionId)).toBe(false);
  } finally {
    release.resolve();
    await client.agent.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
