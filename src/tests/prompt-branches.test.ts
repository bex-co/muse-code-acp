import { methods } from "@agentclientprotocol/sdk";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, fakeMuseBinary, fixturesDir, initialized } from "./helpers.js";

// Characterizes prompt() branches that other suites do not reach in process.
const fakeMsp = join(fixturesDir, "fake-msp.cjs");

function sdkClient(extraEnv: Record<string, string> = {}, museBinary = fakeMsp, skipCheck = true) {
  chmodSync(fakeMsp, 0o755);
  const root = mkdtempSync(join(tmpdir(), "prompt-branches-"));
  const capture = join(root, "msp.jsonl");
  const client = connectTestClient({
    backend: "sdk",
    museBinary,
    skipSdkHostCheck: skipCheck,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_CAPTURE: capture,
      ...extraEnv,
    },
  });
  const requests = () =>
    existsSync(capture)
      ? readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method: string; params: unknown })
      : [];
  return { client, root, requests };
}

async function open(client: ReturnType<typeof connectTestClient>, cwd: string) {
  const ctx = await initialized(client);
  const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
  const prompt = (text: string) =>
    ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const replies = () =>
    client.updates
      .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
      .map((n) => JSON.stringify(n.update));
  return { ctx, sessionId, prompt, replies };
}

describe("prompt() branches", () => {
  it("answers /tasks locally, with and without a live host", async () => {
    const { client, root, requests } = sdkClient();
    const { prompt, replies } = await open(client, root);
    await expect(prompt("/tasks")).resolves.toEqual({ stopReason: "end_turn" });
    expect(replies().at(-1)).toContain("No live Muse host reports background tasks");
    expect(requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
  });

  it("keeps the adapter title when Muse refuses the native rename", async () => {
    const { client, root } = sdkClient({ FAKE_MSP_RENAME_REJECT: "1" });
    const { prompt, replies } = await open(client, root);
    await prompt("/rename before host");
    expect(replies().at(-1)).toContain("will be set when this session's host next starts");
    await prompt("open the host");
    await prompt("/rename Second Title");
    expect(replies().at(-1)).toContain("Session title saved by this adapter: Second Title");
    expect(replies().at(-1)).toContain("Muse kept its own session name");
  });

  it("refuses host-version-gated commands on an older host without sending anything", async () => {
    const wrapper = join(mkdtempSync(join(tmpdir(), "old-muse-")), "muse");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "Muse Code 1.1.1 (1.1.1-R2514.1)"; exit 0; fi\nexec "${process.execPath}" "${fakeMsp}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const { client, root, requests } = sdkClient({}, wrapper, false);
    const { prompt, replies } = await open(client, root);
    await expect(prompt("/recap")).resolves.toEqual({ stopReason: "end_turn" });
    expect(replies().at(-1)).toContain(
      "This Muse command is verified from Muse 1.4.7; this host is not supported",
    );
    await expect(prompt("/goal set ship it")).resolves.toEqual({ stopReason: "end_turn" });
    expect(replies().at(-1)).toContain("Native goal controls are verified from Muse 1.4.6");
    expect(requests().filter((r) => r.method !== "initialize")).toEqual([]);
  });

  it("prefixes the planning instruction to every prompt in plan mode", async () => {
    const { client, root, requests } = sdkClient();
    const { ctx, sessionId, prompt } = await open(client, root);
    await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "plan" });
    await prompt("add a feature");
    const input = JSON.stringify(requests().find((r) => r.method === "turn/start")?.params);
    expect(input).toContain("Planning mode: inspect and propose a plan. Do not implement changes.");
    expect(input).toContain("add a feature");
  });

  it("rejects the echo provider on the SDK backend before starting a host", async () => {
    chmodSync(fakeMsp, 0o755);
    const root = mkdtempSync(join(tmpdir(), "prompt-branches-"));
    const client = connectTestClient({
      backend: "sdk",
      provider: "echo",
      museBinary: fakeMsp,
      skipSdkHostCheck: true,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
    });
    const { prompt } = await open(client, root);
    await expect(prompt("hello")).rejects.toThrow(
      "The SDK backend requires a configured Muse provider",
    );
  });

  it("reports an exec usage error with the rejected argv", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-branches-"));
    const client = connectTestClient({
      backend: "exec",
      museBinary: fakeMuseBinary(),
      env: { ...process.env, HOME: root, FAKE_MUSE_MODE: "exit2" },
    });
    const { prompt } = await open(client, root);
    await expect(prompt("hello")).rejects.toThrow(/muse exec rejected the invocation \(exit 2\)/);
  });
});
