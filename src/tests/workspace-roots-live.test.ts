import { methods } from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, hostSupports, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for workspace-root acceptance");

describe.skipIf(!available || !hostSupports("workspace-roots"))(
  "additional directories (real Muse host)",
  () => {
    it("lets the agent write in an extra root, not outside, and clears the root on resume without it", async () => {
      // The sandbox always allows /tmp and $TMPDIR, so the probe dirs live elsewhere.
      const cache = join(homedir(), ".cache");
      mkdirSync(cache, { recursive: true });
      const scratch = mkdtempSync(join(cache, "muse-acp-roots-"));
      const extra = join(scratch, "extra");
      const outside = join(scratch, "outside");
      mkdirSync(extra);
      mkdirSync(outside);
      const target = (tag: string) =>
        tag.startsWith("extra") ? join(extra, `${tag}.txt`) : join(outside, `${tag}.txt`);
      const provider = await startLoopbackProvider({
        scriptedToolCallWhen: [],
        scriptedToolCallCommand: "",
        replyText: "done",
        scriptedToolCallForRequest: (req) => {
          const last = (req.input as { role?: string; content?: unknown }[] | undefined)?.at(-1);
          if (!last || last.role !== "user") return undefined;
          const tag = /qa-write-(\w+)/.exec(JSON.stringify(last.content))?.[1];
          return tag
            ? {
                name: "bash",
                arguments: { command: `printf ok > ${target(tag)}`, description: tag },
              }
            : undefined;
        },
      });
      const env = {
        HOME: provider.home,
        PATH: process.env.PATH,
        MUSE_CODE_EXECUTABLE: process.env.MUSE_CODE_EXECUTABLE,
        XDG_CONFIG_HOME: join(provider.root, "config"),
        XDG_DATA_HOME: join(provider.root, "data"),
        TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1",
      };
      const client = connectTestClient({ backend: "sdk", env });
      client.setPermissionResponder((r) => ({
        outcome: {
          outcome: "selected",
          optionId: r.options.find((o) => o.kind === "allow_once")!.optionId,
        },
      }));
      try {
        const ctx = await initialized(client);
        const cwd = join(provider.root, "workspace");
        mkdirSync(cwd);
        const { sessionId } = await ctx.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
          additionalDirectories: [extra],
        });
        const prompt = (text: string) =>
          ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text }],
          });
        await prompt("qa-write-extra1");
        expect(existsSync(target("extra1"))).toBe(true);
        await prompt("qa-write-outside1");
        expect(existsSync(target("outside1"))).toBe(false);
        // ACP: a resume without additionalDirectories means no extra roots.
        await ctx.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
        await prompt("qa-write-extra2");
        expect(existsSync(target("extra2"))).toBe(false);
      } finally {
        await client.agent.dispose();
        await provider.close();
        rmSync(provider.root, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
