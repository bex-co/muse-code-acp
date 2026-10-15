import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, hostSupports, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for native command acceptance");

describe.skipIf(!available || !hostSupports("session-commands"))(
  "native recap and rename (real Muse host)",
  () => {
    it("returns Muse's recap and sets its normalized session name", async () => {
      const provider = await startLoopbackProvider({
        holdMs: 20,
        scriptedToolCallWhen: [],
        scriptedToolCallCommand: "",
        scriptedToolCallForRequest: () => undefined,
        replyText: "Recap headline\nlive-recap-marker summary line",
      });
      const env = {
        PATH: process.env.PATH,
        HOME: provider.home,
        XDG_CONFIG_HOME: join(provider.root, "config"),
        XDG_DATA_HOME: join(provider.root, "data"),
        TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1",
        // /feedback must not reach Meta from a test: dead proxy for anything remote.
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      };
      const foreign = join(provider.home, ".claude", "skills", "live-probe-skill");
      mkdirSync(foreign, { recursive: true });
      writeFileSync(
        join(foreign, "SKILL.md"),
        "---\nname: live-probe-skill\ndescription: Live import probe\n---\n\nSay hello.\n",
      );
      const client = connectTestClient({ backend: "sdk", env });
      try {
        const ctx = await initialized(client);
        const { sessionId } = await ctx.request(methods.agent.session.new, {
          cwd: provider.root,
          mcpServers: [],
        });
        const prompt = (text: string) =>
          ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text }],
          });
        const said = () =>
          JSON.stringify(
            client.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk").at(-1),
          );
        await prompt("discuss the live topic");
        await expect(prompt("/recap")).resolves.toEqual({ stopReason: "end_turn" });
        expect(said()).toContain("live-recap-marker");
        await prompt("/rename Live Native Name");
        expect(said()).toContain('Muse session name set to \\"live native name\\"');
        await prompt("/skills import claude");
        expect(said()).toContain("Would install: live-probe-skill");
        await prompt("/skills import claude --apply");
        expect(said()).toContain("Installed: live-probe-skill");
        await prompt("/skills disable live-probe-skill");
        expect(said()).toContain("Skill live-probe-skill (user): on → off");
        await prompt("/skills enable live-probe-skill");
        expect(said()).toContain("off → on");
        await prompt("/status");
        expect(JSON.stringify(client.updates)).toContain(
          "Subscription usage: not reported by Muse",
        );
        await prompt("/feedback other adapter live test; ignore");
        expect(said()).toContain("Feedback outcome: failed");
        expect(said()).toContain("No files or session record were attached");
        await expect
          .poll(
            () =>
              client.agent.sessions.get(sessionId)?.sdkHost?.owner &&
              provider.requests().length > 0,
          )
          .toBe(true);
      } finally {
        await client.agent.dispose();
        await provider.close();
        rmSync(provider.root, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
