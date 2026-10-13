import { join } from "node:path";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { startLoopbackProvider } from "./loopback-provider.js";
import { connectTestClient, museAvailable, capturingLogger } from "./helpers.js";
import { probeSdkHost, supportsGoalControls } from "../muse-host.js";
const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for goal acceptance");

describe.skipIf(!available)("real Muse goal observation", () => {
  it("observes autonomous progress after prompt completion, restores history, and permits later prompts", async () => {
    const progress = Promise.withResolvers<void>();
    let calls = 0;
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: [],
      scriptedToolCallCommand: "",
      holdMs: 100,
      scriptedToolCallForRequest: async (request) => {
        if (!JSON.stringify(request.tools).includes('"name":"create_goal"')) return;
        calls++;
        if (calls === 1)
          return { name: "create_goal", arguments: { objective: "m18-live-objective" } };
        if (calls === 3) {
          await progress.promise;
          return {
            name: "report_progress",
            arguments: { current_work: "verified work", next_work: "finish", percent_complete: 75 },
          };
        }
        if (calls === 4) return { name: "update_goal", arguments: { status: "complete" } };
      },
    });
    const env = {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    };
    const lines: string[] = [];
    const client = connectTestClient({ backend: "sdk", env }, capturingLogger(lines));
    let restored: ReturnType<typeof connectTestClient> | undefined;
    try {
      const ctx = await client.connect();
      const init = await ctx.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "muse/goal": 1 } },
      });
      expect(init._meta?.["muse/goal"]).toEqual({
        version: 1,
        observation: true,
        controls: supportsGoalControls(probeSdkHost().version)
          ? ["set", "edit", "pause", "resume", "clear"]
          : [],
      });
      const { sessionId } = await ctx.request(methods.agent.session.new, {
        cwd: provider.root,
        mcpServers: [],
      });
      expect(
        await ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Create goal m18-live-objective" }],
        }),
      ).toEqual({ stopReason: "end_turn" });
      await expect
        .poll(() => client.agent.sessions.get(sessionId)?.goal)
        .toMatchObject({
          status: "known",
          goal: { objective: "m18-live-objective", status: "active" },
        });
      const owner = client.agent.sessions.get(sessionId)!.sdkHost!.owner;
      await expect.poll(() => owner.hasActiveTurn).toBe(true);
      const before = calls;
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/goal" }],
      });
      expect(calls).toBe(before);
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "ordinary prompt while native work runs" }],
        }),
      ).rejects.toMatchObject({ code: -32600 });
      expect(owner.closed).toBe(false);
      progress.resolve();
      await expect
        .poll(() => client.agent.sessions.get(sessionId)?.goal, { timeout: 10_000 })
        .toMatchObject({ status: "known", goal: { status: "complete" } });
      expect(
        client.updates.some(
          (n) =>
            n.update.sessionUpdate === "session_info_update" &&
            JSON.stringify(n.update._meta ?? {}).includes('"percentComplete":75'),
        ),
      ).toBe(true);
      await expect.poll(() => owner.hasActiveTurn, { timeout: 10_000 }).toBe(false);
      expect(
        await ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Continue ordinary work after goal" }],
        }),
      ).toEqual({ stopReason: "end_turn" });
      expect(lines.filter((l) => l.startsWith("muse-sdk spawn:")).length).toBe(1);
      await client.agent.dispose();
      restored = connectTestClient({ backend: "sdk", env });
      const next = await restored.connect();
      await next.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "muse/goal": 1 } },
      });
      await next.request(methods.agent.session.resume, { sessionId, cwd: provider.root });
      expect(restored.agent.sessions.get(sessionId)?.goal).toMatchObject({
        status: "known",
        goal: { status: "complete", objective: "m18-live-objective" },
      });
      const priorCalls = calls;
      await next.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/goal status" }],
      });
      expect(calls).toBe(priorCalls);
      expect(JSON.stringify(restored.updates)).toContain("m18-live-objective");
    } finally {
      progress.resolve();
      await client.agent.dispose();
      await restored?.agent.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 30_000);
});
