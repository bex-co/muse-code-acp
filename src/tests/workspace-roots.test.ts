import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectTestClient, ensureExecutable, fixturesDir, initialized } from "./helpers.js";

function rootsClient() {
  const binary = join(fixturesDir, "fake-msp.cjs");
  ensureExecutable(binary);
  const root = mkdtempSync(join(tmpdir(), "roots-"));
  const capture = join(root, "msp.jsonl");
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_CAPTURE: capture,
      XDG_DATA_HOME: root,
    },
  });
  const sent = (method: string) =>
    existsSync(capture)
      ? readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
          .filter((r) => r.method === method)
      : [];
  return { client, root, sent };
}

it("advertises additional directories and sends canonical roots with every turn", async () => {
  const { client, sent } = rootsClient();
  const ctx = await client.connect();
  const init = await ctx.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ additionalDirectories: {} });
  const cwd = mkdtempSync(join(tmpdir(), "roots-ws-"));
  const extra = mkdtempSync(join(tmpdir(), "roots-extra-"));
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
    additionalDirectories: [extra, extra, cwd],
  });
  await ctx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "x" }],
  });
  expect(sent("turn/start").at(-1)?.params.workspaceRoots).toEqual([
    realpathSync(cwd),
    realpathSync(extra),
  ]);
  // Load without the field: ACP means "no extra roots", so the next turn clears them.
  await ctx.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
  await ctx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "y" }],
  });
  expect(sent("turn/start").at(-1)?.params.workspaceRoots).toEqual([realpathSync(cwd)]);
  await client.agent.dispose();
});

it("rejects relative or missing directories before any Muse work", async () => {
  const { client, sent } = rootsClient();
  const ctx = await initialized(client);
  const cwd = mkdtempSync(join(tmpdir(), "roots-ws-"));
  for (const additionalDirectories of [["relative/dir"], [join(cwd, "missing")]])
    await expect(
      ctx.request(methods.agent.session.new, { cwd, mcpServers: [], additionalDirectories }),
    ).rejects.toMatchObject({ code: -32602 });
  expect(sent("session/start")).toEqual([]);
  await client.agent.dispose();
});

it("refuses a goal until a prompt has applied the session's extra roots", async () => {
  const { client } = rootsClient();
  const ctx = await initialized(client);
  const cwd = mkdtempSync(join(tmpdir(), "roots-ws-"));
  const extra = mkdtempSync(join(tmpdir(), "roots-extra-"));
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
    additionalDirectories: [extra],
  });
  const said = () =>
    JSON.stringify(client.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk"));
  await ctx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "/goal set ship it" }],
  });
  expect(said()).toContain("Send a prompt first, then start the goal");
  await ctx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });
  const before = said().length;
  await ctx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "/goal set ship it" }],
  });
  expect(said().slice(before)).not.toContain("Send a prompt first");
  await client.agent.dispose();
});
