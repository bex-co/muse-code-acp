import { methods } from "@agentclientprotocol/sdk";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeSdkHost, supportsSessionCommands } from "../muse-host.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for native command acceptance");

describe.skipIf(!available || !supportsSessionCommands(probeSdkHost().version))(
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
      };
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
