import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectTestClient, fixturesDir, initialized, ensureExecutable } from "./helpers.js";

it("requests native recaps and syncs /rename to Muse's session name", async () => {
  const binary = join(fixturesDir, "fake-msp.cjs");
  ensureExecutable(binary);
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_USAGE: "1",
      XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "native-commands-")),
    },
  });
  const ctx = await initialized(client);
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const prompt = (text: string) =>
    ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const said = () =>
    JSON.stringify(client.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk"));
  // No host is open yet: the rename is recorded and applied by the next turn.
  await prompt("/rename Pending Name");
  expect(said()).toContain("will be set when this session's host next starts");
  await prompt("hello");
  expect(client.agent.sessions.get(sessionId)?.pendingNativeName).toBeUndefined();
  await expect(prompt("/recap")).resolves.toEqual({ stopReason: "end_turn" });
  expect(said()).toContain("fake recap of the session");
  await prompt("/status");
  expect(said()).toContain("tier pro; current window 42%");
  expect(said()).toContain("weekly 7%");
  await prompt("/skills disable lint");
  expect(said()).toContain("Skill lint (user): on → off");
  await prompt("/skills enable missing");
  expect(said()).toContain("No Muse skill named missing");
  await prompt("/skills import claude");
  expect(said()).toContain("nothing written");
  expect(said()).toContain("Would install: imported-skill");
  await prompt("/skills import claude --apply");
  expect(said()).toContain("Installed: imported-skill");
  await prompt("/plugins");
  expect(said()).toContain("fake-plugin 1.0.0 [enabled, nativeLocal]");
  await prompt("/plugins install /tmp/some-plugin");
  expect(said()).toContain("Installed Muse plugin fake-plugin 1.0.0 from /tmp/some-plugin");
  await prompt("/plugins install relative/path");
  expect(said()).toContain("Muse rejected installing the plugin at relative/path: internal");
  await prompt("/hooks");
  expect(said()).toContain("preToolUse: lint [user, enabled]");
  await prompt("/feedback good nice work");
  expect(said()).toContain("Feedback outcome: recorded");
  expect(said()).toContain("No files or session record were attached");
  // The host is open now: the rename applies immediately, normalized by Muse.
  await prompt("/rename Live Name");
  expect(said()).toContain('Muse session name set to \\"live name\\"');
  await client.agent.dispose();
});
