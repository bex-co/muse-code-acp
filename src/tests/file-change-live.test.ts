import { join } from "node:path";
import { mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { startLoopbackProvider } from "./loopback-provider.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for file-change acceptance");
describe.skipIf(!available)("real Muse file-change evidence", () => {
  it("shows observed preimages, keeps reports partial, and preserves baseline diffs without extra model turns", async () => {
    let stage = 0;
    let baseline = false;
    const provider = await startLoopbackProvider({
      holdMs: 20,
      scriptedToolCallWhen: [],
      scriptedToolCallCommand: "",
      scriptedToolCallForRequest: (request) => {
        if (!JSON.stringify(request.tools).includes('"name":"write_file"')) return;
        const text = JSON.stringify(request.input);
        if (text.includes("m13-baseline-final") && !baseline) {
          baseline = true;
          return {
            name: "write_file",
            arguments: { path: "target.txt", content: "baseline edit" },
          };
        }
        if (!text.includes("m13-observed-change")) return;
        if (stage++ === 0)
          return {
            name: "write_file",
            arguments: { path: "target.txt", content: "agent overwrite" },
          };
        if (stage === 2)
          return {
            name: "write_file",
            arguments: { path: "created.txt", content: "agent create" },
          };
        if (stage === 3)
          return { name: "bash", arguments: { command: "printf generated > generated.txt" } };
      },
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const git = (...args: string[]) => execFileSync("git", args, { cwd });
    git("init", "-q");
    for (const path of ["target.txt", "created.txt", "unrelated.txt"])
      writeFileSync(join(cwd, path), "index base");
    git("add", ".");
    writeFileSync(join(cwd, "target.txt"), "dirty user preimage");
    writeFileSync(join(cwd, "unrelated.txt"), "unrelated user edit");
    unlinkSync(join(cwd, "created.txt"));
    const env = {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    };
    const first = connectTestClient({ backend: "sdk", env });
    const second = connectTestClient({ backend: "sdk", env });
    first.setPermissionResponder((request) => ({
      outcome: {
        outcome: "selected",
        optionId: request.options.find((o) => o.kind === "allow_once")!.optionId,
      },
    }));
    try {
      const ctx = await initialized(first, {
        _meta: { jetbrains: { air: { version: 1, capabilities: ["agentFileChangeReport"] } } },
      });
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "m13-observed-change" }],
          _meta: {
            jetbrains: {
              air: { agentFileChangeReportRequest: { version: 1, requestId: "m13-report" } },
            },
          },
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(stage).toBe(4); // Three tool requests and the final reply; no audit turn.
      const diffs = first.updates.flatMap((n) =>
        "content" in n.update && Array.isArray(n.update.content)
          ? n.update.content.filter((c) => c.type === "diff")
          : [],
      );
      expect(diffs).toContainEqual(
        expect.objectContaining({ oldText: "dirty user preimage", newText: "agent overwrite" }),
      );
      expect(diffs).toContainEqual(
        expect.objectContaining({ oldText: null, newText: "agent create" }),
      );
      const reports = first.updates.flatMap((n) => {
        const meta = n.update._meta as
          { jetbrains?: { air?: { agentFileChangeReport?: unknown } } } | undefined;
        return meta?.jetbrains?.air?.agentFileChangeReport
          ? [meta.jetbrains.air.agentFileChangeReport]
          : [];
      });
      expect(reports).toEqual([
        {
          version: 1,
          requestId: "m13-report",
          status: "reported",
          paths: [realpathSync(join(cwd, "target.txt")), realpathSync(join(cwd, "created.txt"))],
          declaredComplete: false,
          truncated: false,
          uncertainty: expect.stringContaining("Shell, generated and child changes may be missing"),
        },
      ]);
      expect(readFileSync(join(cwd, "generated.txt"), "utf8")).toBe("generated");
      expect(readFileSync(join(cwd, "unrelated.txt"), "utf8")).toBe("unrelated user edit");
      await first.agent.dispose();
      const baselineCtx = await initialized(second);
      const created = await baselineCtx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await baselineCtx.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "m13-baseline-final" }],
      });
      expect(JSON.stringify(second.updates)).not.toContain("agentFileChangeReport");
      expect(
        second.updates.flatMap((n): unknown[] =>
          "content" in n.update && Array.isArray(n.update.content) ? n.update.content : [],
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "diff",
          oldText: "agent overwrite",
          newText: "baseline edit",
        }),
      );
    } finally {
      await first.agent.dispose();
      await second.agent.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 45000);
});
