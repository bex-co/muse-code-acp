import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsConfigured, museAuthMethods } from "../auth.js";
import { connectTestClient, fakeMuseBinary } from "./helpers.js";

function isolatedEnv(withStoredAuth: boolean): Record<string, string | undefined> {
  const configHome = mkdtempSync(join(tmpdir(), "muse-auth-test-"));
  if (withStoredAuth) {
    mkdirSync(join(configHome, "muse"), { recursive: true });
    writeFileSync(join(configHome, "muse", "auth.json"), JSON.stringify({ some: "session" }));
  }
  // PATH is required so the fake binary's `env node` shebang resolves.
  return { PATH: process.env.PATH, XDG_CONFIG_HOME: configHome, HOME: configHome };
}

describe("credentialsConfigured", () => {
  it("is true with META_API_KEY regardless of stored state", () => {
    expect(credentialsConfigured({ ...isolatedEnv(false), META_API_KEY: "k" })).toBe(true);
  });

  it("is true with a non-trivial auth.json", () => {
    expect(credentialsConfigured(isolatedEnv(true))).toBe(true);
  });

  it("is false with neither", () => {
    expect(credentialsConfigured(isolatedEnv(false))).toBe(false);
  });
});

describe("auth over ACP", () => {
  it("initialize advertises both auth methods and the logout capability", async () => {
    const testClient = connectTestClient({ backend: "exec" });
    const ctx = await testClient.connect();
    const response = await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(response.authMethods?.map((m) => m.id)).toEqual(["muse-login", "meta-api-key"]);
    expect(response.agentCapabilities?.auth).toEqual({ logout: {} });
    const login = response.authMethods?.[0];
    expect(login && "args" in login ? login.args : []).toEqual(["--cli", "login"]);
  });

  it("omits terminal auth when the client does not advertise it", async () => {
    const testClient = connectTestClient({ backend: "exec" });
    const ctx = await testClient.connect();
    const response = await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    expect(response.authMethods?.map((m) => m.id)).toEqual(["meta-api-key"]);
    // ACP 1.8 has no env_var type; an agent method omits `type` and uses authenticate.
    expect(response.authMethods?.[0]).not.toHaveProperty("type");
  });

  it("authenticate confirms configuration only and rejects when absent", async () => {
    const unauthenticated = connectTestClient({ env: isolatedEnv(false) });
    const ctx1 = await unauthenticated.connect();
    await ctx1.request(methods.agent.initialize, { protocolVersion: 1 });
    await expect(
      ctx1.request(methods.agent.authenticate, { methodId: "meta-api-key" }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/META_API_KEY/) });

    const authenticated = connectTestClient({
      backend: "exec",
      env: { ...isolatedEnv(false), META_API_KEY: "k" },
    });
    const ctx2 = await authenticated.connect();
    await ctx2.request(methods.agent.initialize, { protocolVersion: 1 });
    await expect(
      ctx2.request(methods.agent.authenticate, { methodId: "meta-api-key" }),
    ).resolves.toEqual({});

    await expect(
      ctx2.request(methods.agent.authenticate, { methodId: "bogus" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("logout execs muse logout (fake binary) and resolves", async () => {
    const testClient = connectTestClient({
      backend: "exec",
      museBinary: fakeMuseBinary(),
      env: { ...isolatedEnv(true), FAKE_MUSE_MODE: "exit0" },
    });
    const ctx = await testClient.connect();
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    await expect(ctx.request(methods.agent.logout, {})).resolves.toEqual({});
  });

  it("logout surfaces a failing muse logout", async () => {
    const testClient = connectTestClient({
      backend: "exec",
      museBinary: fakeMuseBinary(),
      env: { ...isolatedEnv(true), FAKE_MUSE_MODE: "exit2" },
    });
    const ctx = await testClient.connect();
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const err = await ctx.request(methods.agent.logout, {}).catch((e) => e);
    expect(err.code).toBe(-32603);
    expect(`${err.message} ${JSON.stringify(err.data ?? "")}`).toContain("muse logout exited 2");
  });
});

describe("museAuthMethods", () => {
  it("carries the terminal-auth meta for meta-terminal clients", () => {
    const [login] = museAuthMethods();
    expect(login._meta).toMatchObject({
      "terminal-auth": { label: "Muse Login" },
    });
  });
});

it("reports stored credentials as unverified and retains environment configuration after logout", async () => {
  for (const withKey of [false, true]) {
    const client = connectTestClient({
      backend: "exec",
      museBinary: fakeMuseBinary(),
      env: {
        ...isolatedEnv(true),
        FAKE_MUSE_MODE: "exit0",
        ...(withKey ? { META_API_KEY: "expired-private-key" } : {}),
      },
    });
    try {
      const ctx = await client.connect();
      const init = await ctx.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "muse/authStatus": 1 } },
      });
      expect(init._meta?.["muse/authStatus"]).toMatchObject({
        configured: true,
        verification: "unknown",
        identity: "unknown",
        source: withKey ? "environment" : "stored",
      });
      const auth = await ctx.request(methods.agent.authenticate, { methodId: "muse-login" });
      expect(auth._meta?.["muse/authStatus"]).toMatchObject({ verification: "unknown" });
      const logout = await ctx.request(methods.agent.logout, {});
      if (withKey)
        expect(logout._meta?.["muse/authStatus"]).toMatchObject({
          configured: true,
          source: "environment",
          verification: "unknown",
        });
      expect(JSON.stringify([init, auth, logout])).not.toContain("expired-private-key");
    } finally {
      await client.agent.dispose();
    }
  }
});
