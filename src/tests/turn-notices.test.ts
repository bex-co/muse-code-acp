import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectTestClient, ensureExecutable, fixturesDir, initialized } from "./helpers.js";

async function promptWithNotices(clientCapabilities?: Record<string, unknown>) {
  const binary = join(fixturesDir, "fake-msp.cjs");
  ensureExecutable(binary);
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_NOTICES: "1",
      XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "notices-")),
    },
  });
  const ctx = await initialized(client, clientCapabilities);
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  await expect(
    ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] }),
  ).resolves.toEqual({ stopReason: "end_turn" });
  const notices = client.updates.flatMap((n) =>
    n.update.sessionUpdate === "notice" ? [n.update] : [],
  );
  await client.agent.dispose();
  return notices;
}

it("shows the current turn's model retries and reviewer holds as ACP notices", async () => {
  const notices = await promptWithNotices({ session: { notices: {} } });
  expect(notices).toEqual([
    expect.objectContaining({
      severity: "warning",
      title: "Model request failed (server 503); retrying, attempt 2 of 10",
      description: expect.stringContaining("in 2 s"),
    }),
    expect.objectContaining({
      severity: "info",
      title: "Muse's reviewer is checking bash before it runs",
    }),
  ]);
});

it("sends no notices to clients that did not advertise them", async () => {
  expect(await promptWithNotices()).toEqual([]);
});
