import { modelChoice } from "../config-options.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { methods } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
import { forkCutLatestOnly, spawnAcpAgent } from "./acp-real-host-helpers.js";
import { ALTERNATE_MODEL_ID, startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for fork acceptance");
describe.skipIf(!available)("native Muse fork continuity", () => {
  it("copies the requested completed history and continues independent branches across ACP restart", async () => {
    const provider = await startLoopbackProvider({
      holdMs: 20,
      scriptedToolCallWhen: [],
      scriptedToolCallCommand: "",
      scriptedToolCallForRequest: () => undefined,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const env = {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    };
    const first = connectTestClient({ backend: "sdk", env });
    let restarted: Awaited<ReturnType<typeof spawnAcpAgent>> | undefined;
    try {
      const ctx = await initialized(first, { _meta: { "muse/fork": 1, "muse/steering": 1 } });
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: ALTERNATE_MODEL_ID,
      });
      await ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "reasoningEffort",
        value: "medium",
      });
      await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
      const prompt = (id: string, text: string) =>
        ctx.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text }],
        });
      await prompt(sessionId, "m12-source-first");
      const turnIds = () => [
        ...new Set(
          first.updates
            .map((n) => n.update._meta?.["muse/activeTurnId"])
            .filter((v): v is string => typeof v === "string"),
        ),
      ];
      const [firstTurn] = turnIds();
      expect(firstTurn).toBeTypeOf("string");
      await prompt(sessionId, "m12-source-second");
      const latestTurn = turnIds()[1];
      expect(latestTurn).toBeTypeOf("string");
      await expect(
        ctx.request(methods.agent.session.fork, {
          sessionId,
          cwd,
          _meta: { "muse/fork": { lastTurnId: randomUUID() } },
        }),
      ).rejects.toThrow("forkBoundaryInvalid");
      // Hosts that accept only the latest boundary get an actionable rejection
      // and the branch is cut at the latest turn instead.
      const latestOnly = forkCutLatestOnly();
      if (latestOnly)
        await expect(
          ctx.request(methods.agent.session.fork, {
            sessionId,
            cwd,
            _meta: { "muse/fork": { lastTurnId: firstTurn } },
          }),
        ).rejects.toThrow(`accept only the latest one (${latestTurn})`);
      const fork = await ctx.request(methods.agent.session.fork, {
        sessionId,
        cwd,
        _meta: { "muse/fork": { lastTurnId: latestOnly ? latestTurn : firstTurn } },
      });
      expect(fork.sessionId).not.toBe(sessionId);
      expect(fork.modes?.currentModeId).toBe("default");
      expect(fork.configOptions?.find((o) => o.id === "model")?.currentValue).toBe(
        modelChoice({ id: ALTERNATE_MODEL_ID, name: ALTERNATE_MODEL_ID, providerId: "meta" }),
      );
      expect(fork.configOptions?.find((o) => o.id === "reasoningEffort")?.currentValue).toBe(
        "medium",
      );
      expect(fork._meta?.["muse/fork"]).toMatchObject({
        sourceSessionId: sessionId,
        explicitBoundary: true,
      });
      const full = await ctx.request(methods.agent.session.fork, { sessionId, cwd });
      expect(new Set([sessionId, fork.sessionId, full.sessionId]).size).toBe(3);
      await prompt(full.sessionId, "m12-full-branch");
      const fullInput = JSON.stringify(
        provider.requests().findLast((r) => JSON.stringify(r.input).includes("m12-full-branch"))
          ?.input,
      );
      expect(fullInput).toContain("m12-source-first");
      expect(fullInput).toContain("m12-source-second");
      await first.agent.dispose();
      restarted = await spawnAcpAgent({ env, cwd });
      for (const [id, method] of [
        [fork.sessionId, "load"],
        [sessionId, "resume"],
      ] as const) {
        const restored = await restarted.ctx.request(methods.agent.session[method], {
          sessionId: id,
          cwd,
          mcpServers: [],
        });
        expect(restored.configOptions?.find((o) => o.id === "model")?.currentValue).toBe(
          modelChoice({ id: ALTERNATE_MODEL_ID, name: ALTERNATE_MODEL_ID, providerId: "meta" }),
        );
        expect(restored.configOptions?.find((o) => o.id === "reasoningEffort")?.currentValue).toBe(
          "medium",
        );
        expect(restored.modes?.currentModeId).toBe(id === sessionId ? "readOnly" : "default");
        await expect(
          restarted.ctx.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: [
              {
                type: "text",
                text: id === sessionId ? "m12-source-after-restart" : "m12-cut-branch",
              },
            ],
          }),
        ).resolves.toEqual({ stopReason: "end_turn" });
      }
      const branchInput = JSON.stringify(
        provider.requests().findLast((r) => JSON.stringify(r.input).includes("m12-cut-branch"))
          ?.input,
      );
      expect(branchInput).toContain("m12-source-first");
      if (latestOnly) expect(branchInput).toContain("m12-source-second");
      else expect(branchInput).not.toContain("m12-source-second");
      const sourceInput = JSON.stringify(
        provider
          .requests()
          .findLast((r) => JSON.stringify(r.input).includes("m12-source-after-restart"))?.input,
      );
      expect(sourceInput).toContain("m12-source-second");
      expect(sourceInput).not.toContain("m12-cut-branch");
      expect(sourceInput).not.toContain("m12-full-branch");
    } finally {
      await first.agent.dispose();
      await restarted?.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 45000);
});
