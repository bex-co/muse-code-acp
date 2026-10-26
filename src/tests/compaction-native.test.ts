import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, fixturesDir, initialized, ensureExecutable } from "./helpers.js";

async function compactSession(compact: string, clientCapabilities?: Record<string, unknown>) {
  const binary = join(fixturesDir, "fake-msp.cjs");
  ensureExecutable(binary);
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_COMPACT: compact,
      XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "compaction-")),
    },
  });
  const ctx = await initialized(client, clientCapabilities);
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const prompt = (text: string) =>
    ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const said = () =>
    JSON.stringify(client.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk"));
  const compactions = () =>
    client.updates.flatMap((n) =>
      n.update.sessionUpdate === "compaction_update" ? [n.update] : [],
    );
  return { client, ctx, sessionId, prompt, said, compactions };
}

describe("native /compact", () => {
  it("reports a completed manual compaction as standard updates to negotiating clients", async () => {
    const s = await compactSession("completed", { session: { compaction: {} } });
    await expect(s.prompt("/compact")).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.said()).toContain("Muse compacted this session's context (3000 → 1200 tokens).");
    expect(s.compactions().map((u) => [u.compactionId, u.status])).toEqual([
      ["fake-compaction", "in_progress"],
      ["fake-compaction", "completed"],
    ]);
    expect(s.compactions()[1]._meta).toMatchObject({
      "muse/compaction": { trigger: "manual", outcome: "compacted", tokensAfter: 1200 },
    });
    // The session continues normally afterwards.
    await expect(s.prompt("hello")).resolves.toEqual({ stopReason: "end_turn" });
    await s.client.agent.dispose();
  });

  it("sends no compaction updates to clients that did not advertise them", async () => {
    const s = await compactSession("completed");
    await s.prompt("/compact");
    expect(s.said()).toContain("Muse compacted this session's context");
    expect(s.compactions()).toEqual([]);
    await s.client.agent.dispose();
  });

  it("reports failed compactions, noops and host refusals verbatim", async () => {
    const failed = await compactSession("failed", { session: { compaction: {} } });
    await failed.prompt("/compact");
    expect(failed.said()).toContain("Muse did not compact the context (failed: summarizer_failed)");
    expect(failed.compactions().at(-1)).toMatchObject({ status: "failed" });
    await failed.client.agent.dispose();

    const noop = await compactSession("noop", { session: { compaction: {} } });
    await noop.prompt("/compact");
    expect(noop.said()).toContain("Nothing to compact (no_compactable_history).");
    expect(noop.compactions()).toEqual([]);
    await noop.client.agent.dispose();

    const refused = await compactSession("reject");
    await refused.prompt("/compact");
    expect(refused.said()).toContain("Muse rejected the compaction: compaction_unavailable.");
    await refused.client.agent.dispose();
  });

  it("stops waiting on ACP cancel without claiming an outcome", async () => {
    const s = await compactSession("hang", { session: { compaction: {} } });
    const running = s.prompt("/compact");
    await expect.poll(() => s.compactions().length).toBe(1);
    await s.ctx.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    expect(s.said()).not.toContain("compacted");
    await s.client.agent.dispose();
  });

  it("rejects arguments without sending anything", async () => {
    const s = await compactSession("completed");
    await s.prompt("/compact now");
    expect(s.said()).toContain("Send /compact without arguments. Nothing was sent.");
    await s.client.agent.dispose();
  });
});
