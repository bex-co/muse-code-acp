import { describe, expect, it } from "vitest";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import { connectTestClient, initialized } from "./helpers.js";

describe("initialize", () => {
  it("returns protocol version, identity, and only implemented capabilities", async () => {
    const testClient = connectTestClient();
    const ctx = await testClient.connect();

    const response = await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentInfo).toEqual({
      name: packageJson.name,
      version: packageJson.version,
    });
    // Advertised capabilities must match what is implemented.
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities).toEqual({ list: {}, close: {} });
    expect(response._meta?.["bex.security/capabilities"]).toEqual({
      delegatedWorkers: false,
      usage: "unavailable",
      interactivePermissions: false,
    });
    expect(response.authMethods?.length).toBe(2);
  });

  it("clamps future client protocol versions to our own", async () => {
    const testClient = connectTestClient();
    const ctx = await testClient.connect();

    const response = await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION + 5,
    });

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("session/new", () => {
  it("mints a fresh session per call, bound to the cwd", async () => {
    const testClient = connectTestClient();
    const ctx = await initialized(testClient);

    const first = await ctx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
    const second = await ctx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(testClient.agent.sessions.get(first.sessionId)?.cwd).toBe("/tmp");
    expect(testClient.agent.sessions.get(first.sessionId)?.museSessionId).toBe(first.sessionId);
  });

  it("rejects a relative cwd", async () => {
    const testClient = connectTestClient();
    const ctx = await initialized(testClient);

    await expect(
      ctx.request(methods.agent.session.new, { cwd: "relative/path", mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("session/prompt (pre-t005)", () => {
  it("rejects prompts for unknown sessions", async () => {
    const testClient = connectTestClient();
    const ctx = await initialized(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId: "does-not-exist",
        prompt: [{ type: "text", text: "hi" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
