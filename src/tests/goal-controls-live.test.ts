import { methods } from "@agentclientprotocol/sdk";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, hostSupports, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for goal control acceptance");

describe.skipIf(!available || !hostSupports("goal-controls"))(
  "native goal controls (real Muse host)",
  () => {
    it("sets, edits, resumes and clears the native goal through /goal", async () => {
      const provider = await startLoopbackProvider({
        holdMs: 20,
        scriptedToolCallWhen: [],
        scriptedToolCallCommand: "",
        scriptedToolCallForRequest: () => undefined,
      });
      const env = {
        PATH: process.env.PATH,
        HOME: provider.home,
        XDG_CONFIG_HOME: join(provider.root, "config"),
        XDG_DATA_HOME: join(provider.root, "data"),
        TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1",
      };
      const client = connectTestClient({ backend: "sdk", env });
      try {
        const ctx = await initialized(client, { _meta: { "muse/goal": 1 } });
        const { sessionId } = await ctx.request(methods.agent.session.new, {
          cwd: provider.root,
          mcpServers: [],
        });
        const goal = (text: string) =>
          ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text }],
          });
        const observed = () => client.agent.sessions.get(sessionId)?.goal;
        // Goal turns continue host-owned after the streamed one; wait until idle.
        const idle = () =>
          expect
            .poll(
              () => client.agent.sessions.get(sessionId)?.sdkHost?.owner.hasActiveTurn ?? false,
              {
                timeout: 30_000,
              },
            )
            .toBe(false);

        await expect(goal("/goal set live-goal-one")).resolves.toEqual({ stopReason: "end_turn" });
        await expect.poll(observed).toMatchObject({ goal: { objective: "live-goal-one" } });
        const goalTurns = provider
          .requests()
          .filter((r) => JSON.stringify(r.input).includes("live-goal-one")).length;
        expect(goalTurns).toBeGreaterThan(0);
        await idle();
        await goal("/goal edit live-goal-two");
        await expect.poll(observed).toMatchObject({ goal: { objective: "live-goal-two" } });
        const current = observed();
        if (current?.status === "known" && current.goal?.status === "paused") {
          await expect(goal("/goal resume")).resolves.toEqual({ stopReason: "end_turn" });
          await idle();
        }
        await goal("/goal clear");
        await expect.poll(observed).toEqual({ status: "known", goal: null });
        await expect(goal("/goal edit after-clear")).rejects.toThrow("missing_goal");
      } finally {
        await client.agent.dispose();
        await provider.close();
        rmSync(provider.root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
