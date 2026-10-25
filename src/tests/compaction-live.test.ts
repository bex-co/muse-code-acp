import { methods } from "@agentclientprotocol/sdk";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, hostSupports, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for compaction acceptance");

// The loopback provider never gets compaction: Muse 1.4.12 refuses it with
// compaction_unavailable there, while a real provider completes it (w3/m9).
// This suite proves the refusal path end to end; the fake MSP covers completion.
describe.skipIf(!available || !hostSupports("compaction"))(
  "native /compact (real Muse host)",
  () => {
    it("advertises /compact, reports Muse's answer verbatim and keeps the session usable", async () => {
      const provider = await startLoopbackProvider({
        holdMs: 20,
        scriptedToolCallWhen: [],
        scriptedToolCallCommand: "",
        scriptedToolCallForRequest: () => undefined,
        replyText: "live-compaction-marker",
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
        const ctx = await initialized(client, { session: { compaction: {} } });
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
        await expect
          .poll(() =>
            client.updates.some(
              (n) =>
                n.update.sessionUpdate === "available_commands_update" &&
                n.update.availableCommands.some((c) => c.name === "compact"),
            ),
          )
          .toBe(true);
        for (const turn of ["first", "second", "third"]) await prompt(`${turn} live turn`);
        await expect(prompt("/compact")).resolves.toEqual({ stopReason: "end_turn" });
        const reply = said();
        if (reply.includes("Muse rejected the compaction")) {
          expect(reply).toContain("compaction_unavailable");
          expect(client.updates.some((n) => n.update.sessionUpdate === "compaction_update")).toBe(
            false,
          );
        } else {
          // A host that does compact over the loopback must report it in full.
          expect(reply).toMatch(/Muse compacted this session's context|Muse did not compact/);
          expect(
            client.updates.filter((n) => n.update.sessionUpdate === "compaction_update").at(-1)
              ?.update,
          ).toMatchObject({ status: expect.stringMatching(/completed|failed/) });
        }
        // No model turn ran for /compact, and the session continues afterwards.
        const before = provider.requests().length;
        await expect(prompt("after compaction")).resolves.toEqual({ stopReason: "end_turn" });
        expect(said()).toContain("live-compaction-marker");
        expect(provider.requests().length).toBeGreaterThan(before);
      } finally {
        await client.agent.dispose();
        await provider.close();
        rmSync(provider.root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
