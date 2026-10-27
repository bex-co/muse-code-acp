import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, hostSupports, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for notice acceptance");

const env = (provider: { home: string; root: string }) => ({
  HOME: provider.home,
  PATH: process.env.PATH,
  MUSE_CODE_EXECUTABLE: process.env.MUSE_CODE_EXECUTABLE,
  XDG_CONFIG_HOME: join(provider.root, "config"),
  XDG_DATA_HOME: join(provider.root, "data"),
  TBH_CREDENTIAL_BACKEND: "file",
  TBH_DISABLE_TELEMETRY: "1",
});

// Muse 1.4.8 reports model retries and 1.4.12 reviewer holds; one gate covers both.
describe.skipIf(!available || !hostSupports("compaction"))("ACP notices (real Muse host)", () => {
  it("reports provider retries as warnings to a client advertising notices", async () => {
    const provider = await startLoopbackProvider({
      statusCode: 503,
      scriptedToolCallWhen: [],
      scriptedToolCallCommand: "",
    });
    const client = connectTestClient({ backend: "sdk", env: env(provider) });
    try {
      const ctx = await initialized(client, { session: { notices: {} } });
      const { sessionId } = await ctx.request(methods.agent.session.new, {
        cwd: provider.root,
        mcpServers: [],
      });
      await ctx
        .request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] })
        .catch(() => {});
      const notices = client.updates.flatMap((n) =>
        n.update.sessionUpdate === "notice" ? [n.update] : [],
      );
      expect(notices.length).toBeGreaterThan(0);
      expect(notices[0]).toMatchObject({
        severity: "warning",
        title: expect.stringMatching(
          /^Model request failed \(server 503\); retrying, attempt 2 of \d+$/,
        ),
      });
    } finally {
      await client.agent.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("reports the reviewer holding a tool call before the permission request", async () => {
    const artifact = "reviewed.txt";
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: [artifact, `"bash"`],
      scriptedToolCallCommand: `printf yes > ${artifact}`,
      replyText: "done",
      reviewerOutcome: "escalate",
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const client = connectTestClient({ backend: "sdk", env: env(provider) });
    client.setPermissionResponder(() => ({ outcome: { outcome: "cancelled" } }));
    try {
      const ctx = await initialized(client, { session: { notices: {} } });
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: `Create ${artifact} with bash` }],
      });
      const notices = client.updates.flatMap((n) =>
        n.update.sessionUpdate === "notice" ? [n.update] : [],
      );
      expect(notices).toContainEqual(
        expect.objectContaining({
          severity: "info",
          title: "Muse's reviewer is checking bash before it runs",
        }),
      );
    } finally {
      await client.agent.dispose();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 120_000);
});
