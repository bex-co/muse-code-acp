import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import * as sdk from "../muse-sdk.js";
import * as fork from "../session-fork.js";
import { readSessionPreferences } from "../session-preferences.js";
import { connectTestClient, fakeMuseBinary, newTestSession } from "./helpers.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(meta = true) {
  vi.spyOn(sdk, "readMuseSdkSession").mockResolvedValue({ modelId: "source-model" });
  const env = { ...process.env, XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "fork-prefs-")) };
  temporaryRoots.push(env.XDG_DATA_HOME);
  const client = connectTestClient({
    backend: "sdk",
    museBinary: fakeMuseBinary(),
    skipSdkHostCheck: true,
    env,
  });
  return {
    client,
    env,
    ...(await newTestSession(client, meta ? { _meta: { "muse/fork": 1 } } : {})),
  };
}
function result(source: string, cwd: string) {
  return {
    session: {
      sessionId: "fork-id",
      workspaceRoot: cwd,
      modelId: "source-model",
      activeTurnId: null,
      status: "idle",
      forkedFrom: { sessionId: source, cutCursor: "cursor", cutExplicit: false },
    },
  };
}
describe("ACP fork binding", () => {
  it("uses separate configuration, explicit MCP inventory and reset safety preferences", async () => {
    const { client, env, ctx, sessionId, cwd } = await setup();
    const source = client.agent.sessions.get(sessionId)!;
    source.modeId = "plan";
    source.config.safety = {
      nativeApprovalPolicy: "allowAll",
      sandbox: "disabled",
      sandboxNetwork: "enabled",
      workspaceWrite: "enabled",
      shell: "enabled",
    };
    source.config.reasoningEffort = "high";
    const rpc = vi.spyOn(fork, "forkMuseSession").mockResolvedValue(result(sessionId, cwd));
    try {
      const response = await ctx.request(methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      expect(response.modes?.currentModeId).toBe("default");
      const branch = client.agent.sessions.get(response.sessionId)!;
      expect(branch.config).not.toBe(source.config);
      expect(branch.mcpServers).not.toBe(source.mcpServers);
      expect(branch.config.safety).toBeUndefined();
      expect(branch.config).toMatchObject({ model: "source-model", reasoningEffort: "high" });
      expect(readSessionPreferences(response.sessionId, env)).toMatchObject({
        reasoningEffort: "high",
        modeId: "default",
      });
      branch.config.reasoningEffort = "low";
      expect(source.config.reasoningEffort).toBe("high");
      expect(source.modeId).toBe("plan");
    } finally {
      rpc.mockRestore();
      await client.agent.dispose();
    }
  });
  it("rejects invalid boundaries, extra roots and wrong workspaces before native mutation", async () => {
    const { client, ctx, sessionId, cwd } = await setup(false);
    const rpc = vi.spyOn(fork, "forkMuseSession");
    try {
      for (const request of [
        { sessionId, cwd, _meta: { "muse/fork": { lastTurnId: "turn" } } },
        { sessionId, cwd, additionalDirectories: ["relative/extra"] },
        { sessionId, cwd: tmpdir() },
        { sessionId: "unknown", cwd },
      ])
        await expect(ctx.request(methods.agent.session.fork, request)).rejects.toMatchObject({
          code: -32602,
        });
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      rpc.mockRestore();
      await client.agent.dispose();
    }
  });
  it("serializes source operations and cannot bind a delayed fork after disposal", async () => {
    const { client, sessionId, cwd } = await setup();
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof fork.forkMuseSession>>>();
    const rpc = vi.spyOn(fork, "forkMuseSession").mockReturnValue(gate.promise);
    const pending = client.agent.forkSession({ sessionId, cwd });
    const rejected = expect(pending).rejects.toThrow("shutting down");
    try {
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
      await expect(client.agent.closeSession({ sessionId })).rejects.toMatchObject({
        code: -32600,
      });
      await expect(
        client.agent.prompt({ sessionId, prompt: [{ type: "text", text: "race" }] }),
      ).rejects.toMatchObject({ code: -32600 });
      await expect(client.agent.forkSession({ sessionId, cwd })).rejects.toMatchObject({
        code: -32600,
      });
      const disposed = client.agent.dispose();
      gate.resolve(result(sessionId, cwd));
      await rejected;
      await disposed;
      expect(client.agent.sessions.size).toBe(0);
    } finally {
      gate.resolve(result(sessionId, cwd));
      rpc.mockRestore();
      await client.agent.dispose();
    }
  });
});
