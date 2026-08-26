import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";

/** Finds per-session directories in an isolated muse data dir. */
function sessionDirs(xdgDataHome: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(dir, entry.name);
      // Layout: <xdg>/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl
      if (depth === 4) {
        results.push(path);
      } else {
        walk(path, depth + 1);
      }
    }
  };
  walk(join(xdgDataHome, "muse", "sessions"), 1);
  return results;
}

describe.skipIf(!museAvailable())("multi-turn continuity (live echo provider)", () => {
  it("consecutive prompts share one muse session log with continuing sequences", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-continuity-xdg-"));
    const testClient = connectTestClient({
      provider: "echo",
      env: { ...process.env, XDG_DATA_HOME: xdg },
    });
    const ctx = await initialized(testClient);
    const cwd = mkdtempSync(join(tmpdir(), "muse-continuity-cwd-"));
    const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });

    const first = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat token one" }],
    });
    const second = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat token two" }],
    });

    expect(first.stopReason).toBe("end_turn");
    expect(second.stopReason).toBe("end_turn");

    const dirs = sessionDirs(xdg);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].endsWith(sessionId)).toBe(true);

    const log = readFileSync(join(dirs[0], "session.jsonl"), "utf8").trim().split("\n");
    const sequences = log.map((line) => JSON.parse(line).sequence as number);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
    // The durable log uses the runtime.* vocabulary (differs from the stdout
    // stream): one settled command intake per prompt turn.
    const settledTurns = log.filter((line) =>
      line.includes('"payload_type":"runtime.command_intake.settled"'),
    );
    expect(settledTurns.length).toBe(2);
  }, 60_000);

  it("a killed turn resumes cleanly on the next prompt", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-continuity-xdg-"));
    const testClient = connectTestClient({
      provider: "echo",
      env: { ...process.env, XDG_DATA_HOME: xdg },
    });
    const ctx = await initialized(testClient);
    const cwd = mkdtempSync(join(tmpdir(), "muse-continuity-cwd-"));
    const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });

    // Cancel immediately — the SIGINT lands during muse startup or mid-run;
    // muse's intent journal makes either safe to resume.
    const first = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat token cancelme" }],
    });
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    expect((await first).stopReason).toBe("cancelled");

    const second = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat token after-cancel" }],
    });
    expect(second.stopReason).toBe("end_turn");

    const chunks = testClient.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(chunks).toContain("echo: repeat token after-cancel");
  }, 60_000);
});
