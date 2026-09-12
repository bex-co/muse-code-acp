import { methods } from "@agentclientprotocol/sdk";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseSdkTranslator } from "../muse-sdk-events.js";
import { connectTestClient, fixturesDir, newTestSession, silentLogger } from "./helpers.js";

function sdkClient(mode = "complete") {
  const binary = join(fixturesDir, "fake-msp.cjs");
  chmodSync(binary, 0o755);
  const capture = join(mkdtempSync(join(tmpdir(), "muse-sdk-test-")), "requests.jsonl");
  const testClient = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: mode,
      FAKE_MSP_CAPTURE: capture,
      XDG_DATA_HOME: join(dirname(capture), "data"),
    },
  });
  return {
    ...testClient,
    requests: () =>
      readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

describe("SDK backend over ACP", () => {
  it("preserves image order and bytes through MSP", async () => {
    const client = sdkClient();
    const { ctx, sessionId } = await newTestSession(client);
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "before" },
        { type: "image", mimeType: "image/png", data: "YQ==" },
        { type: "text", text: "after" },
      ],
    });
    expect(client.requests().find((r) => r.method === "turn/start").params.input).toEqual([
      { type: "text", text: "before" },
      { type: "image", mediaType: "image/png", base64Data: "YQ==" },
      { type: "text", text: "after" },
    ]);
  });

  it("uses UUIDv7 sessions and streams each text segment once, including completion before ack", async () => {
    const client = sdkClient();
    const { ctx, sessionId, modes } = await newTestSession(client);
    expect(sessionId.split("-")[2][0]).toBe("7");
    expect(modes?.availableModes.map((mode) => mode.id)).toEqual(["default", "readOnly"]);
    await expect(
      ctx.request(methods.agent.session.setMode, { sessionId, modeId: "bypassApprovals" }),
    ).rejects.toMatchObject({ code: -32602 });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "test-model",
    });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "low",
    });
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "test prompt" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    const chunks = client.updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunks.map((u) => (u.content.type === "text" ? u.content.text : "")).join("")).toBe(
      "hello world",
    );
    const requests = client.requests();
    expect(requests.find((r) => r.method === "session/start").params.modelId).toBe("test-model");
    expect(requests.find((r) => r.method === "turn/start").params).toMatchObject({
      sessionId,
      reasoningEffort: "low",
      input: [{ type: "text", text: "test prompt" }],
    });
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  });

  it("cancels through turn/cancel and settles the ACP prompt", async () => {
    const client = sdkClient("block");
    const { ctx, sessionId } = await newTestSession(client);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "block" }],
    });
    await expect
      .poll(() => client.updates.some((u) => u.update.sessionUpdate === "agent_message_chunk"))
      .toBe(true);
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(client.requests().some((r) => r.method === "turn/cancel")).toBe(true);
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  });

  it("settles cancellation during startup", async () => {
    const client = sdkClient("block");
    const { ctx, sessionId } = await newTestSession(client);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "block" }],
    });
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it.each([
    ["autherr", /not logged in.*muse login/],
    ["gap", /gap fill failed|gap in the turn stream|reload the session/],
    ["gapFail", /gap fill failed|reload the session/],
    ["exit", /disconnected|connection reached EOF|exited abnormally/],
    ["disabled", /experimental SDK tier is disabled/],
    ["inUse", /session is in use/],
    ["busy", /unfinished turn or pending input/],
    ["wrongWorkspace", /different workspace/],
  ])("reports %s instead of hanging or creating a replacement session", async (mode, message) => {
    const client = sdkClient(mode);
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(message) });
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
    if (["inUse", "busy", "wrongWorkspace"].includes(mode)) {
      expect(client.requests().some((r) => r.method === "session/start")).toBe(false);
      expect(client.requests().some((r) => r.method === "turn/start")).toBe(false);
    }
  });

  it("maps typed step-limit failures to ACP's turn limit", async () => {
    const client = sdkClient("stepLimit");
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      }),
    ).resolves.toEqual({ stopReason: "max_turn_requests" });
  });

  it("passes read-only flags and the private MCP overlay to serve, then removes the overlay", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sdk-mcp-"));
    const capture = join(root, "capture.json");
    const binary = join(fixturesDir, "fake-msp.cjs");
    chmodSync(binary, 0o755);
    const client = connectTestClient({
      backend: "sdk",
      museBinary: binary,
      skipSdkHostCheck: true,
      env: { ...process.env, XDG_CONFIG_HOME: root, FAKE_MSP_SETTINGS_CAPTURE: capture },
    });
    const { ctx } = await newTestSession(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: root,
      mcpServers: [{ name: "test", command: "test-mcp", args: [], env: [] }],
    });
    await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "test" }],
    });
    const captured = JSON.parse(readFileSync(capture, "utf8"));
    expect(captured.args).toEqual(["serve", "--disable-write", "--disable-shell"]);
    expect(captured.settings.mcp_servers.test.command).toBe("test-mcp");
    expect(existsSync(captured.configHome)).toBe(false);
  });
});

describe("MSP tool translation", () => {
  it("preserves arguments and normalized results, including completion without a start", () => {
    const translator = new MuseSdkTranslator("s1", silentLogger());
    const item = {
      itemId: "i1",
      callId: "c1",
      kind: "toolCall" as const,
      tool: "bash",
      revision: 1,
      status: "inProgress" as const,
      args: JSON.stringify({ command: "pwd", description: "Show directory" }),
    };
    expect(translator.fromItem(item)[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Show directory",
      kind: "execute",
      rawInput: { command: "pwd" },
      status: "in_progress",
    });
    const finished = {
      ...item,
      revision: 2,
      status: "completed" as const,
      visibleOutput: JSON.stringify({ command: "pwd", output: "/workspace" }),
    };
    expect(translator.fromItem(finished)[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: { formatted_output: "/workspace" },
    });
    expect(translator.fromItem(finished)).toEqual([]);
    expect(new MuseSdkTranslator("s1", silentLogger()).fromItem(finished)[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      status: "completed",
    });
  });

  it("forwards slash-command prompts on the SDK turn input", async () => {
    const client = sdkClient();
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/plan do the thing" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(client.requests().find((r) => r.method === "turn/start").params.input).toEqual([
      { type: "text", text: "/plan do the thing" },
    ]);
  });

  it("defaults to the SDK backend when MUSE_CODE_ACP_BACKEND is unset", () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      FAKE_MSP_MODE: "complete",
    };
    delete env.MUSE_CODE_ACP_BACKEND;
    const binary = join(fixturesDir, "fake-msp.cjs");
    chmodSync(binary, 0o755);
    const client = connectTestClient({
      museBinary: binary,
      skipSdkHostCheck: true,
      env,
    });
    expect(client.agent.backend).toBe("sdk");
  });

  it("maps extreme effort labels onto MSP low/medium/high", async () => {
    const { sdkReasoningEffort } = await import("../muse-sdk.js");
    expect(sdkReasoningEffort("none")).toBe("low");
    expect(sdkReasoningEffort("xhigh")).toBe("high");
    expect(sdkReasoningEffort("medium")).toBe("medium");
    expect(sdkReasoningEffort("bogus")).toBeUndefined();
  });
});
