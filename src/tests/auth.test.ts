import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthenticated, museAuthMethods } from "../auth.js";
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

describe("isAuthenticated", () => {
  it("is true with META_API_KEY regardless of stored state", () => {
    expect(isAuthenticated({ ...isolatedEnv(false), META_API_KEY: "k" })).toBe(true);
  });

  it("is true with a non-trivial auth.json", () => {
    expect(isAuthenticated(isolatedEnv(true))).toBe(true);
  });

  it("is false with neither", () => {
    expect(isAuthenticated(isolatedEnv(false))).toBe(false);
  });
});

describe("auth over ACP", () => {
  it("initialize advertises both auth methods and the logout capability", async () => {
    const testClient = connectTestClient();
    const ctx = await testClient.connect();
    const response = await ctx.request(methods.agent.initialize, { protocolVersion: 1 });

    expect(response.authMethods?.map((m) => m.id)).toEqual(["muse-login", "meta-api-key"]);
    expect(response.agentCapabilities?.auth).toEqual({ logout: {} });
    const login = response.authMethods?.[0];
    expect(login && "args" in login ? login.args : []).toEqual(["--cli", "login"]);
  });

  it("authenticate verifies credentials and rejects when absent", async () => {
    const unauthenticated = connectTestClient({ env: isolatedEnv(false) });
    const ctx1 = await unauthenticated.connect();
    await ctx1.request(methods.agent.initialize, { protocolVersion: 1 });
    await expect(
      ctx1.request(methods.agent.authenticate, { methodId: "meta-api-key" }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/META_API_KEY/) });

    const authenticated = connectTestClient({
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
      museBinary: fakeMuseBinary(),
      env: { ...isolatedEnv(true), FAKE_MUSE_MODE: "exit0" },
    });
    const ctx = await testClient.connect();
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    await expect(ctx.request(methods.agent.logout, {})).resolves.toEqual({});
  });

  it("logout surfaces a failing muse logout", async () => {
    const testClient = connectTestClient({
      museBinary: fakeMuseBinary(),
      env: { ...isolatedEnv(true), FAKE_MUSE_MODE: "exit2" },
    });
    const ctx = await testClient.connect();
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    await expect(ctx.request(methods.agent.logout, {})).rejects.toMatchObject({
      message: expect.stringMatching(/muse logout exited 2/),
    });
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
