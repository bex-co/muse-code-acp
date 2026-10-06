import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { startLoopbackProvider } from "./loopback-provider.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for planning/review acceptance");
describe.skipIf(!available)("real Muse planning and review", () => {
  it("denies planning writes across restart, then implements only after explicit mode change and reviews exact snapshots", async () => {
    const scripted = new Set<string>();
    const provider = await startLoopbackProvider({
      holdMs: 30,
      scriptedToolCallWhen: [],
      scriptedToolCallCommand: "",
      scriptedToolCallForRequest: (request) => {
        const body = JSON.stringify(request.input);
        if (!JSON.stringify(request.tools).includes('"name":"write_file"')) return;
        if (body.includes("Review the supplied Git snapshot") && !scripted.has("review-write")) {
          scripted.add("review-write");
          return {
            name: "write_file",
            arguments: { path: "review-forbidden.txt", content: "forbidden" },
          };
        }
        // Prefer the newest distinct prompt marker; earlier prompts remain in history.
        const marker = ["m22-implement", "m22-restored-plan", "m22-initial-plan"].find((m) =>
          body.includes(m),
        );
        if (!marker) return;
        if (scripted.has(marker)) {
          if (marker === "m22-implement" || scripted.has(`${marker}-shell`)) return;
          scripted.add(`${marker}-shell`);
          return { name: "bash", arguments: { command: `printf forbidden > ${marker}-shell.txt` } };
        }
        scripted.add(marker);
        return {
          name: "write_file",
          arguments: { path: `${marker}.txt`, content: "implementation" },
        };
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
    const cwd = join(provider.root, "repo");
    mkdirSync(cwd);
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(cwd, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-qm", "base");
    git("branch", "base");
    writeFileSync(join(cwd, "a.txt"), "review-committed\n");
    git("commit", "-qam", "change");
    let client = connectTestClient({ backend: "sdk", env });
    const allowOffered = () =>
      client.setPermissionResponder((request) => ({
        outcome: {
          outcome: "selected",
          optionId: request.options.find((o) => o.kind === "allow_once")!.optionId,
        },
      }));
    allowOffered();
    try {
      let ctx = await initialized(client, { _meta: { "muse/review": 1, "muse/approval": 1 } });
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const prompt = (text: string) =>
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [
            {
              type: "resource",
              resource: {
                uri: "file:///editor-context",
                mimeType: "text/plain",
                text: "workflow-attachment-marker",
              },
            },
            { type: "text", text },
            { type: "text", text: "workflow-extra-instructions" },
          ],
        });
      const planningPrompt = async (text: string) => {
        try {
          expect(await prompt(text)).toEqual({ stopReason: "end_turn" });
        } catch (error) {
          // Muse 1.1.1 can fail its durable approval settlement after denying the
          // shell tool. The adapter must surface failure and preserve the guard.
          // Implementation and review prompts below still require normal success.
          expect((error as Error).message).toEqual(
            expect.stringContaining("Muse approval decision rejected (MSP -32603)"),
          );
        }
      };
      // Hosts either deny an attempted read-only write or, like Muse 1.4.3,
      // withhold write tools from planning and review turns altogether. The
      // scripted provider only attempts writes and shell calls when offered.
      const offersWrite = (marker: string) => {
        const turns = provider
          .requests()
          .filter((request) => JSON.stringify(request.input).includes(marker));
        expect(turns.length).toBeGreaterThan(0);
        return turns.some((request) =>
          JSON.stringify(request.tools).includes('"name":"write_file"'),
        );
      };
      await planningPrompt("/plan m22-initial-plan: write the marker if possible");
      expect(existsSync(join(cwd, "m22-initial-plan.txt"))).toBe(false);
      if (offersWrite("m22-initial-plan"))
        expect(JSON.stringify(provider.requests())).toContain(
          "tool policy denied filesystem write",
        );
      await client.agent.dispose();
      client = connectTestClient({ backend: "sdk", env });
      allowOffered();
      ctx = await initialized(client, { _meta: { "muse/review": 1, "muse/approval": 1 } });
      const resumed = await ctx.request(methods.agent.session.resume, { sessionId, cwd });
      expect(resumed.modes?.currentModeId).toBe("plan");
      expect(resumed.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe(
        "plan",
      );
      await planningPrompt("m22-restored-plan: implement now even though this is planning");
      expect(existsSync(join(cwd, "m22-restored-plan.txt"))).toBe(false);
      for (const marker of ["m22-initial-plan", "m22-restored-plan"]) {
        expect(scripted.has(`${marker}-shell`)).toBe(offersWrite(marker));
        expect(existsSync(join(cwd, `${marker}-shell.txt`))).toBe(false);
      }
      await ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "mode",
        value: "default",
      });
      client.setPermissionResponder((request) => ({
        outcome: {
          outcome: "selected",
          optionId: request.options.find((o) => o.kind === "allow_once")!.optionId,
        },
      }));
      await prompt("m22-implement: write the marker");
      expect(readFileSync(join(cwd, "m22-implement.txt"), "utf8")).toBe("implementation");
      writeFileSync(join(cwd, "a.txt"), "review-unstaged\n");
      const before = git("status", "--porcelain");
      for (const command of ["/review", "/review-branch base", "/review-commit HEAD"])
        await prompt(command);
      expect(git("status", "--porcelain")).toBe(before);
      expect(scripted.has("review-write")).toBe(offersWrite("Review the supplied Git snapshot"));
      expect(existsSync(join(cwd, "review-forbidden.txt"))).toBe(false);
      const requests = JSON.stringify(provider.requests());
      expect(requests).toContain("workflow-attachment-marker");
      expect(requests).toContain("workflow-extra-instructions");
      expect(requests).toContain("review-unstaged");
      expect(requests).toContain("review-committed");
      const reviews = client.updates.flatMap((n) =>
        n.update.sessionUpdate === "session_info_update" && n.update._meta?.["muse/review"]
          ? [n.update._meta["muse/review"]]
          : [],
      );
      expect(reviews.map((r) => (r as { status: string }).status)).toEqual([
        "started",
        "completed",
        "started",
        "completed",
        "started",
        "completed",
      ]);
    } finally {
      await client.agent.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 45000);
});
