import { methods, type McpServer } from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, fakeMuseBinary, museAvailable, newTestSession } from "./helpers.js";

const refreshedMcpServers: McpServer[] = [
  {
    name: "turn-tools",
    command: "/usr/bin/turn-tools",
    args: ["--stdio"],
    env: [{ name: "TURN_CLAIM", value: "claim-1" }],
  },
];

function fakeClient(mode = "exit0") {
  return connectTestClient({
    museBinary: fakeMuseBinary(),
    env: { ...process.env, FAKE_MUSE_MODE: mode },
  });
}

describe("session/resume", () => {
  it("preserves live mode and config while replacing MCP servers", async () => {
    const testClient = fakeClient();
    const { ctx, sessionId, cwd } = await newTestSession(testClient);
    await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "low",
    });

    const resumed = await ctx.request(methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: refreshedMcpServers,
    });

    expect(resumed.modes?.currentModeId).toBe("readOnly");
    expect(
      resumed.configOptions?.find((option) => option.id === "reasoningEffort")?.currentValue,
    ).toBe("low");
    expect(testClient.agent.sessions.get(sessionId)?.mcpServers).toEqual(refreshedMcpServers);
  });

  it("accepts a symlink-equivalent workspace", async () => {
    const testClient = fakeClient();
    const ctx = await testClient.connect();
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const root = mkdtempSync(join(tmpdir(), "muse-resume-cwd-"));
    const realCwd = join(root, "real");
    const linkedCwd = join(root, "linked");
    mkdirSync(realCwd);
    symlinkSync(realCwd, linkedCwd, "junction");
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: realCwd,
      mcpServers: [],
    });

    await expect(
      ctx.request(methods.agent.session.resume, { sessionId, cwd: linkedCwd, mcpServers: [] }),
    ).resolves.toMatchObject({ modes: expect.any(Object) });
  });

  it("rejects workspace changes with the stored path and next step", async () => {
    const testClient = fakeClient();
    const { ctx, sessionId, cwd } = await newTestSession(testClient);
    const otherCwd = mkdtempSync(join(tmpdir(), "muse-resume-other-"));

    await expect(
      ctx.request(methods.agent.session.resume, { sessionId, cwd: otherCwd, mcpServers: [] }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(new RegExp(`${cwd}.*resume from that directory`)),
    });
  });

  it("rejects a missing requested workspace as invalid input", async () => {
    const testClient = fakeClient();
    const { ctx, sessionId } = await newTestSession(testClient);
    const missingCwd = join(tmpdir(), `missing-muse-resume-${crypto.randomUUID()}`);

    await expect(
      ctx.request(methods.agent.session.resume, { sessionId, cwd: missingCwd, mcpServers: [] }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/workspace directory does not exist.*missing-muse-resume/),
    });
  });

  it("rejects a deleted stored workspace with a new-session next step", async () => {
    const testClient = fakeClient();
    const { ctx, sessionId, cwd } = await newTestSession(testClient);
    rmSync(cwd, { recursive: true, force: true });

    await expect(
      ctx.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/stored workspace directory is unavailable.*new session/),
    });
  });

  it("rejects additional workspace directories visibly", async () => {
    const testClient = fakeClient();
    const { ctx, sessionId, cwd } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        additionalDirectories: [mkdtempSync(join(tmpdir(), "muse-resume-extra-"))],
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/one workspace root/) });
  });

  it("rejects resume during a turn without changing MCP state", async () => {
    const testClient = fakeClient("block");
    const { ctx, sessionId, cwd } = await newTestSession(testClient);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "Wait for cancellation." }],
    });
    while (!testClient.agent.sessions.get(sessionId)?.activeTurn) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await expect(
      ctx.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: refreshedMcpServers,
      }),
    ).rejects.toMatchObject({ code: -32600, message: expect.stringMatching(/prompt turn/) });
    expect(testClient.agent.sessions.get(sessionId)?.mcpServers).toEqual([]);

    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it.skipIf(!museAvailable())("recreates a closed session without replaying history", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-resume-xdg-"));
    const testClient = connectTestClient({
      provider: "echo",
      env: { ...process.env, XDG_DATA_HOME: xdg },
    });
    const { ctx, sessionId, cwd } = await newTestSession(testClient);
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat first-resume-token" }],
    });
    await ctx.request(methods.agent.session.close, { sessionId });
    testClient.updates.length = 0;
    const linkRoot = mkdtempSync(join(tmpdir(), "muse-resume-link-"));
    const linkedCwd = join(linkRoot, "workspace");
    symlinkSync(cwd, linkedCwd, "junction");

    const resumed = await ctx.request(methods.agent.session.resume, {
      sessionId,
      cwd: linkedCwd,
      mcpServers: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resumed.modes?.currentModeId).toBe("default");
    expect(resumed.configOptions?.length).toBeGreaterThan(0);
    expect(testClient.agent.sessions.get(sessionId)?.cwd).toBe(realpathSync(cwd));
    expect(
      testClient.updates.some((update) => update.update.sessionUpdate === "agent_message_chunk"),
    ).toBe(false);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "repeat second-resume-token" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("rejects unknown sessions and relative workspaces", async () => {
    const testClient = fakeClient();
    const ctx = await testClient.connect();
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });

    await expect(
      ctx.request(methods.agent.session.resume, {
        sessionId: crypto.randomUUID(),
        cwd: mkdtempSync(join(tmpdir(), "muse-resume-unknown-")),
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/not found/) });
    await expect(
      ctx.request(methods.agent.session.resume, {
        sessionId: crypto.randomUUID(),
        cwd: "relative/path",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/absolute path/) });
  });
});
