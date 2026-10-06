import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectTestClient, initialized } from "./helpers.js";
import { startLoopbackProvider, type LoopbackProvider } from "./loopback-provider.js";
import { probeSdkHost } from "../muse-host.js";

function env(provider: LoopbackProvider) {
  return {
    HOME: provider.home,
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: join(provider.root, "config"),
    XDG_DATA_HOME: join(provider.root, "data"),
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
  };
}
function mainRequests(provider: LoopbackProvider, marker: string) {
  return provider
    .requests()
    .filter(
      (request) =>
        Array.isArray(request.input) &&
        request.input.some(
          (message: { role?: string; content?: unknown }) =>
            message.role === "user" && message.content === marker,
        ),
    );
}
const providerOptions = {
  scriptedToolCallWhen: ["unused"],
  scriptedToolCallCommand: "unused",
  holdMs: 20,
};
it("isolates two explicit gateways and credentials in one ACP agent", async () => {
  const [a, b] = await Promise.all([
    startLoopbackProvider(providerOptions),
    startLoopbackProvider(providerOptions),
  ]);
  const cwd = join(a.root, "workspace");
  mkdirSync(cwd);
  const client = connectTestClient({ backend: "sdk", env: env(a) });
  try {
    const ctx = await initialized(client, {
      _meta: { "muse/provider": 1, "muse/configRecommendations": 1 },
    });
    const bindings = [
      { providerId: "meta", baseUrl: a.baseUrl, apiKey: "gateway-a-key" },
      { providerId: "meta", baseUrl: b.baseUrl, apiKey: "gateway-b-key" },
    ];
    const sessions = await Promise.all(
      bindings.map((provider) =>
        ctx.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
          _meta: { "muse/provider": provider },
        }),
      ),
    );
    await Promise.all(
      sessions.map(({ sessionId }, index) =>
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: `gateway-${index}-main` }],
        }),
      ),
    );
    expect(mainRequests(a, "gateway-0-main").length).toBeGreaterThan(0);
    expect(mainRequests(a, "gateway-1-main")).toHaveLength(0);
    expect(mainRequests(b, "gateway-1-main").length).toBeGreaterThan(0);
    expect(mainRequests(b, "gateway-0-main")).toHaveLength(0);
    expect(new Set(a.authorizations())).toEqual(new Set(["Bearer gateway-a-key"]));
    expect(new Set(b.authorizations())).toEqual(new Set(["Bearer gateway-b-key"]));
    expect(JSON.stringify(client.updates)).not.toMatch(/gateway-[ab]-key/);
    expect(sessions[0].configOptions?.find((o) => o.id === "model")?._meta).toHaveProperty(
      "muse/configRecommendations",
    );
    const { sessionId } = sessions[1];
    await ctx.request(methods.agent.session.close, { sessionId });
    await expect(
      ctx.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });
    await ctx.request(methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: { "muse/provider": { ...bindings[1], apiKey: "gateway-b-rotated" } },
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "rotated-main" }],
    });
    expect(mainRequests(b, "rotated-main").length).toBeGreaterThan(0);
    expect(b.authorizations()).toContain("Bearer gateway-b-rotated");
    expect(mainRequests(a, "rotated-main")).toHaveLength(0);
  } finally {
    await client.agent.dispose();
    await Promise.all([a.close(), b.close()]);
    await Promise.all([a, b].map((p) => rm(p.root, { recursive: true, force: true })));
  }
}, 90_000);

it("keeps effort changes on the same host and exposes their observed mapping", async () => {
  const provider = await startLoopbackProvider(providerOptions);
  const client = connectTestClient({ backend: "sdk", env: env(provider) });
  try {
    const ctx = await initialized(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: provider.root,
      mcpServers: [],
    });
    let owner: unknown;
    const version = probeSdkHost().version;
    const legacy = version === "1.1.1" || version === "1.2.1";
    // 1.2.1 sent ultra as provider max; from 1.3 max is its own tier and ultra is
    // gated (closed in this isolated home), so it falls back to xhigh.
    const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"];
    for (const effort of [...efforts, ...(legacy ? [] : ["max"]), "ultra"]) {
      await ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "reasoningEffort",
        value: effort,
      });
      const marker = `settings-main-${effort}`;
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: marker }],
      });
      const current = client.agent.sessions.get(sessionId)!.sdkHost!.owner;
      if (owner) expect(current).toBe(owner);
      owner = current;
      const requests = mainRequests(provider, marker);
      expect(requests.length).toBeGreaterThan(0);
      const observed = requests.at(-1)?.reasoning as { effort?: string } | undefined;
      expect(observed?.effort).toBe(
        version === "1.1.1"
          ? undefined
          : effort === "none"
            ? "minimal"
            : effort === "ultra"
              ? version === "1.2.1"
                ? "max"
                : "xhigh"
              : effort,
      );
    }
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "fake-model-alternate",
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "changed-model-main" }],
    });
    expect(mainRequests(provider, "changed-model-main").at(-1)?.model).toBe("fake-model-alternate");
    const fresh = await ctx.request(methods.agent.session.new, {
      cwd: provider.root,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId: fresh.sessionId,
      configId: "model",
      value: "fake-model-alternate",
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId: fresh.sessionId,
      prompt: [{ type: "text", text: "alternate-model-main" }],
    });
    expect(mainRequests(provider, "alternate-model-main").at(-1)?.model).toBe(
      "fake-model-alternate",
    );
  } finally {
    await client.agent.dispose();
    await provider.close();
    await rm(provider.root, { recursive: true, force: true });
  }
}, 90_000);

it("a rejected explicit gateway cannot fall back to the default endpoint", async () => {
  const [a, b] = await Promise.all([
    startLoopbackProvider(providerOptions),
    startLoopbackProvider({ ...providerOptions, statusCode: 401 }),
  ]);
  const client = connectTestClient({ backend: "sdk", env: env(a) });
  try {
    const ctx = await initialized(client, { _meta: { "muse/provider": 1 } });
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: a.root,
      mcpServers: [],
      _meta: {
        "muse/provider": { providerId: "meta", baseUrl: b.baseUrl, apiKey: "rejected-key" },
      },
    });
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "rejection-main" }],
      }),
    ).rejects.toBeDefined();
    expect(b.requests().length).toBeGreaterThan(0);
    expect(a.requests()).toHaveLength(0);
    expect(JSON.stringify(client.updates)).not.toContain("rejected-key");
  } finally {
    await client.agent.dispose();
    await Promise.all([a.close(), b.close()]);
    await Promise.all([a, b].map((p) => rm(p.root, { recursive: true, force: true })));
  }
}, 45_000);

it("keeps the selected effort when steering an active model turn", async () => {
  const provider = await startLoopbackProvider({ ...providerOptions, holdMs: 1500 });
  const client = connectTestClient({ backend: "sdk", env: env(provider) });
  try {
    const ctx = await initialized(client, { _meta: { "muse/steering": 1 } });
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: provider.root,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      // Both reach the provider as max: ultra on 1.2.1, max itself from 1.3.
      value: probeSdkHost().version === "1.2.1" ? "ultra" : "max",
    });
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "initial-settings-main" }],
    });
    const terminal = expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    const active = () => {
      const handle = client.agent.sessions.get(sessionId)?.activeTurn;
      return handle && "activeTurnId" in handle ? handle.activeTurnId : undefined;
    };
    await expect
      .poll(() => mainRequests(provider, "initial-settings-main").length, { timeout: 10000 })
      .toBeGreaterThan(0);
    const turnId = active();
    expect(turnId).toBeTruthy();
    await expect(
      ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "reasoningEffort",
        value: "low",
      }),
    ).rejects.toMatchObject({ code: -32600 });
    const steered = await ctx.request("_muse/steer", {
      sessionId,
      expectedTurnId: turnId,
      prompt: [{ type: "text", text: "steered-settings-main" }],
    });
    expect(steered).toMatchObject({ turnId });
    await terminal;
    const requests = mainRequests(provider, "initial-settings-main").filter((r) =>
      JSON.stringify(r.input).includes("steered-settings-main"),
    );
    expect(requests.length).toBeGreaterThan(0);
    const expected = probeSdkHost().version === "1.1.1" ? undefined : "max";
    for (const request of requests)
      expect((request.reasoning as { effort?: string } | undefined)?.effort).toBe(expected);
  } finally {
    await client.agent.dispose();
    await provider.close();
    await rm(provider.root, { recursive: true, force: true });
  }
}, 45_000);
