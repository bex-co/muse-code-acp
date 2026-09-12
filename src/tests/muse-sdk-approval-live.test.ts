import { methods } from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { museCliPath } from "../muse-cli.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const ARTIFACT = "approved.txt";
const COMMAND = `printf yes > ${ARTIFACT}`;
const PROMPT = `Create a file called ${ARTIFACT} containing the word yes`;

const serveHelp =
  museAvailable() && spawnSync(museCliPath(), ["serve", "--help"], { encoding: "utf8" });
const museReady = Boolean(serveHelp && serveHelp.status === 0);

function liveEnv(provider: { home: string; root: string }) {
  return {
    HOME: provider.home,
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: join(provider.root, "config"),
    XDG_DATA_HOME: join(provider.root, "data"),
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
    MUSE_CODE_ACP_BACKEND: "sdk",
  };
}

describe("SDK live approval gating (real Muse host)", () => {
  it("requires a local muse serve host for execution-gating proof", () => {
    expect(
      museReady,
      "muse serve ≥1.1.1 must be installed; m5 DoD forbids skipping required approval effect tests",
    ).toBe(true);
  });

  it("allow writes the marker", async () => {
    expect(museReady).toBe(true);

    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: [ARTIFACT, `"bash"`],
      scriptedToolCallCommand: COMMAND,
      replyText: "done",
      holdMs: 1_500,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const marker = join(cwd, ARTIFACT);
    const client = connectTestClient({ env: liveEnv(provider) });

    try {
      let release!: (value: { outcome: { outcome: "selected"; optionId: string } }) => void;
      const gate = new Promise<{ outcome: { outcome: "selected"; optionId: string } }>(
        (resolve) => {
          release = resolve;
        },
      );
      client.setPermissionResponder(() => gate);

      const ctx = await initialized(client);
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const prompt = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: PROMPT }],
      });
      await expect.poll(() => client.permissionRequests.length, { timeout: 30_000 }).toBe(1);
      expect(existsSync(marker)).toBe(false);

      const allow = client.permissionRequests[0].options?.find((o) => o.optionId.includes("allow"));
      expect(
        allow,
        `expected allow among ${JSON.stringify(client.permissionRequests[0].options)}`,
      ).toBeTruthy();
      release({ outcome: { outcome: "selected", optionId: allow!.optionId } });
      await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        existsSync(marker),
        `approved command did not write its marker; tool updates: ${JSON.stringify(
          client.updates.filter(({ update }) => update.sessionUpdate === "tool_call_update"),
        )}`,
      ).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe("yes");
      expect(provider.scriptedToolCalls()).toBe(1);
    } finally {
      await client.agent.dispose();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);

  it("deny does not create the marker", async () => {
    expect(museReady).toBe(true);

    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: [ARTIFACT, `"bash"`],
      scriptedToolCallCommand: COMMAND,
      replyText: "denied",
      holdMs: 1_000,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const marker = join(cwd, ARTIFACT);
    const client = connectTestClient({ env: liveEnv(provider) });

    try {
      client.setPermissionResponder((params) => {
        const deny =
          params.options?.find((o) => o.kind === "reject_once") ??
          params.options?.find((o) => /deny|abort|reject/i.test(o.optionId));
        if (!deny) {
          throw new Error(`no deny option in ${JSON.stringify(params.options)}`);
        }
        return { outcome: { outcome: "selected", optionId: deny.optionId } };
      });
      const ctx = await initialized(client);
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: PROMPT }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(existsSync(marker)).toBe(false);
      expect(provider.scriptedToolCalls()).toBe(1);
    } finally {
      await client.agent.dispose();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);

  it("cancel while pending blocks the tool; a later prompt still works", async () => {
    expect(museReady).toBe(true);

    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: [ARTIFACT, `"bash"`],
      scriptedToolCallCommand: COMMAND,
      replyText: "after-cancel",
      holdMs: 2_000,
    });
    const cwd = join(provider.root, "workspace");
    mkdirSync(cwd);
    const marker = join(cwd, ARTIFACT);
    const client = connectTestClient({ env: liveEnv(provider) });

    try {
      let lateAllow = false;
      client.setPermissionResponder(async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        lateAllow = true;
        const allow = params.options?.find((o) => o.optionId.includes("allow"));
        return {
          outcome: {
            outcome: "selected",
            optionId: allow?.optionId ?? params.options?.[0]?.optionId ?? "allow_once",
          },
        };
      });
      const ctx = await initialized(client);
      const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const prompt = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: PROMPT }],
      });
      await expect.poll(() => client.permissionRequests.length, { timeout: 30_000 }).toBe(1);
      expect(existsSync(marker)).toBe(false);
      await ctx.notify(methods.agent.session.cancel, { sessionId });
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(lateAllow).toBe(true);
      expect(existsSync(marker)).toBe(false);

      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "say hello without tools" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
    } finally {
      await client.agent.dispose();
      await provider.close();
      await rm(provider.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);
});
