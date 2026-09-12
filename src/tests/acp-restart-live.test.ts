/**
 * Real ACP process restart + session continuity against local muse serve.
 * Fail-closed when Muse is missing — required m6 integration evidence.
 */
import { methods } from "@agentclientprotocol/sdk";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { museCliPath } from "../muse-cli.js";
import { agentEntrypoint } from "./acp-wire-helpers.js";
import { spawnAcpAgent } from "./acp-real-host-helpers.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
import { ALTERNATE_MODEL_ID, startLoopbackProvider } from "./loopback-provider.js";

const serveHelp =
  museAvailable() && spawnSync(museCliPath(), ["serve", "--help"], { encoding: "utf8" });
const museReady = Boolean(serveHelp && serveHelp.status === 0);

describe("ACP process restart continuity (real Muse host)", () => {
  it("requires a local muse serve host for restart proof", () => {
    expect(
      museReady,
      "muse serve ≥1.1.1 must be installed; m6 DoD forbids skipping required restart tests",
    ).toBe(true);
    expect(existsSync(agentEntrypoint), "dist/index.js must be built before this suite").toBe(true);
  });

  it("restarts the ACP process, reloads history, and continues the same session", async () => {
    expect(museReady).toBe(true);

    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: ["__never_match_tool__"],
      scriptedToolCallCommand: "true",
      replyText: "restart-live-reply",
      holdMs: 200,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const sharedEnv = {
      HOME: provider.home,
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
      MUSE_CODE_EXECUTABLE: museCliPath(),
    };

    let sessionId = "";
    try {
      const agent1 = await spawnAcpAgent({ env: sharedEnv, cwd });
      try {
        const created = await agent1.ctx.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        sessionId = created.sessionId;
        expect(sessionId.split("-")[2][0]).toBe("7");
        await agent1.ctx.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: "model",
          value: ALTERNATE_MODEL_ID,
        });
        await agent1.ctx.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: "reasoningEffort",
          value: "medium",
        });
        await expect(
          agent1.ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "say restart-token-one" }],
          }),
        ).resolves.toEqual({ stopReason: "end_turn" });
        const text1 = agent1.updates
          .map((u) => u.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u.content.type === "text" ? u.content.text : ""))
          .join("");
        expect(text1).toContain("restart-live-reply");
        expect(
          provider
            .requests()
            .filter((r) => JSON.stringify(r.input).includes("restart-token-one"))
            .map((r) => r.model),
        ).toContain(ALTERNATE_MODEL_ID);
      } finally {
        await agent1.dispose();
      }

      const agent2 = await spawnAcpAgent({ env: sharedEnv, cwd });
      try {
        const listing = await agent2.ctx.request(methods.agent.session.list, { cwd });
        expect(listing.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
        const loaded = await agent2.ctx.request(methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers: [],
        });
        expect(loaded.configOptions?.find((o) => o.id === "model")?.currentValue).toBe(
          ALTERNATE_MODEL_ID,
        );
        expect(loaded.configOptions?.find((o) => o.id === "reasoningEffort")?.currentValue).toBe(
          "medium",
        );
        expect(JSON.stringify(agent2.updates)).toContain("restart-token-one");
        await expect(
          agent2.ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "say restart-token-two" }],
          }),
        ).resolves.toEqual({ stopReason: "end_turn" });
        const text2 = agent2.updates
          .map((u) => u.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u.content.type === "text" ? u.content.text : ""))
          .join("");
        expect(text2).toContain("restart-live-reply");
        const continued = provider
          .requests()
          .findLast((r) => JSON.stringify(r.input).includes("restart-token-two"))!;
        expect(continued.model).toBe(ALTERNATE_MODEL_ID);
        expect(JSON.stringify(continued.input)).toContain("restart-token-one");
        expect(JSON.stringify(continued.input)).toContain("restart-live-reply");
        expect(JSON.stringify(continued.input)).toContain("restart-token-two");
      } finally {
        await agent2.dispose();
      }

      const legacy = connectTestClient({
        backend: "exec",
        provider: "echo",
        env: sharedEnv,
      });
      try {
        const ctx = await initialized(legacy);
        const old = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        expect(old.sessionId.split("-")[2][0]).toBe("4");
        await ctx.request(methods.agent.session.prompt, {
          sessionId: old.sessionId,
          prompt: [{ type: "text", text: "repeat token legacy-restart" }],
        });
        const agent3 = await spawnAcpAgent({ env: sharedEnv, cwd });
        try {
          await agent3.ctx.request(methods.agent.session.load, {
            sessionId: old.sessionId,
            cwd,
            mcpServers: [],
          });
          await expect(
            agent3.ctx.request(methods.agent.session.prompt, {
              sessionId: old.sessionId,
              prompt: [{ type: "text", text: "continue legacy" }],
            }),
          ).resolves.toEqual({ stopReason: "end_turn" });
        } finally {
          await agent3.dispose();
        }
      } finally {
        await legacy.agent.dispose();
      }
    } finally {
      await provider.close();
      await rm(provider.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 180_000);
});
