import { methods } from "@agentclientprotocol/sdk";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectTestClient, fixturesDir, initialized, ensureExecutable } from "./helpers.js";

function prewarmClient() {
  const root = mkdtempSync(join(tmpdir(), "prewarm-"));
  // A private copy: other suites chmod the shared fixture, which changes its
  // ctime and therefore the host identity mid-test.
  const binary = join(root, "fake-msp.cjs");
  copyFileSync(join(fixturesDir, "fake-msp.cjs"), binary);
  ensureExecutable(binary);
  const capture = join(root, "msp.jsonl");
  // A profiled Meta catalog, as Muse 1.4.x reports it.
  const catalog = join(root, "catalog.json");
  writeFileSync(
    catalog,
    JSON.stringify({
      source: "providerCatalog",
      models: [
        {
          modelId: "fake-model",
          displayLabel: "Fake",
          providerId: "meta",
          profileId: "tbh",
          isDefault: true,
        },
      ],
    }),
  );
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    prewarm: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_CAPTURE: capture,
      FAKE_MSP_MODELS: catalog,
      XDG_DATA_HOME: root,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
    },
  });
  const methodsSent = () =>
    existsSync(capture)
      ? readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { method: string }).method)
      : [];
  return { client, methodsSent };
}

it("opens the session's host and reads the catalog before the first prompt", async () => {
  const { client, methodsSent } = prewarmClient();
  const ctx = await initialized(client);
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const poll = { timeout: 10_000 };
  await expect
    .poll(methodsSent, poll)
    .toEqual(expect.arrayContaining(["session/start", "model/list"]));
  await expect
    .poll(() => client.agent.sessions.get(sessionId)?.modelDiscovery?.status, poll)
    .toBe("available");
  expect(methodsSent()).not.toContain("turn/start");
  // The catalog settled a profile, so the host reopened once with that route;
  // the first prompt reuses it instead of starting Muse again.
  await expect.poll(() => methodsSent().filter((m) => m === "initialize").length, poll).toBe(2);
  // …and finished opening (the first may close before applying its model).
  await expect
    .poll(
      () => methodsSent().lastIndexOf("session/setModel") > methodsSent().lastIndexOf("initialize"),
      poll,
    )
    .toBe(true);
  const owner = client.agent.sessions.get(sessionId)!.sdkHost!.owner;
  await expect(
    ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    }),
  ).resolves.toEqual({ stopReason: "end_turn" });
  expect(client.agent.sessions.get(sessionId)!.sdkHost!.owner).toBe(owner);
  expect(methodsSent().filter((m) => m === "initialize")).toHaveLength(2);
  await client.agent.dispose();
});

it("reopens in the background after an idle configuration change", async () => {
  const { client, methodsSent } = prewarmClient();
  const ctx = await initialized(client);
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const poll = { timeout: 10_000 };
  const starts = () => methodsSent().filter((m) => m === "initialize").length;
  const opened = () =>
    methodsSent().lastIndexOf("session/setModel") > methodsSent().lastIndexOf("initialize");
  // Let the catalog settle the route (one reopen), then change the mode.
  await expect.poll(starts, poll).toBe(2);
  await expect.poll(opened, poll).toBe(true);
  const first = client.agent.sessions.get(sessionId)!.sdkHost!.owner;
  await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
  await expect.poll(() => first.closed, poll).toBe(true);
  await expect.poll(starts, poll).toBe(3);
  await expect.poll(opened, poll).toBe(true);
  const second = client.agent.sessions.get(sessionId)!.sdkHost!.owner;
  expect(second).not.toBe(first);
  await expect(
    ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    }),
  ).resolves.toEqual({ stopReason: "end_turn" });
  expect(client.agent.sessions.get(sessionId)!.sdkHost!.owner).toBe(second);
  expect(methodsSent().filter((m) => m === "initialize")).toHaveLength(3);
  await client.agent.dispose();
});

it("closes an unused prewarmed host on dispose", async () => {
  const { client, methodsSent } = prewarmClient();
  const ctx = await initialized(client);
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  await expect.poll(methodsSent, { timeout: 10_000 }).toContain("session/start");
  const owner = client.agent.sessions.get(sessionId)!.sdkHost!.owner;
  await client.agent.dispose();
  expect(owner.closed).toBe(true);
});
