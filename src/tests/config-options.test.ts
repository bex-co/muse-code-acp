import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogDefaultModel, defaultSessionConfig, effortLevels } from "../config-options.js";
import { readSessionEffort } from "../session-preferences.js";
import { readMuseSettings } from "../muse-settings.js";
import {
  capturingLogger,
  connectTestClient,
  fakeMuseBinary,
  initialized,
  silentLogger,
} from "./helpers.js";

function settingsEnv(contents: string | null): Record<string, string | undefined> {
  const configHome = mkdtempSync(join(tmpdir(), "muse-config-test-"));
  if (contents !== null) {
    mkdirSync(join(configHome, "muse"), { recursive: true });
    writeFileSync(join(configHome, "muse", "settings.json"), contents);
  }
  return { ...process.env, XDG_CONFIG_HOME: configHome };
}

describe("readMuseSettings", () => {
  it("reads provider, model, and reasoning effort", () => {
    const env = settingsEnv(
      JSON.stringify({
        schema_version: 1,
        provider: "meta",
        model: "muse-spark-1.2-contributor",
        reasoning_effort: "ultra",
      }),
    );
    expect(readMuseSettings(env, silentLogger())).toEqual({
      provider: "meta",
      model: "muse-spark-1.2-contributor",
      reasoningEffort: "ultra",
    });
  });

  it("logs an unknown reasoning effort and keeps reading the rest", () => {
    const lines: string[] = [];
    const env = settingsEnv(
      JSON.stringify({ model: "muse-spark-1.3", reasoning_effort: "maximum" }),
    );
    expect(readMuseSettings(env, capturingLogger(lines))).toEqual({
      model: "muse-spark-1.3",
      reasoningEffort: "maximum",
    });
    expect(lines).toEqual([expect.stringContaining('unknown reasoning_effort "maximum"')]);
  });

  it("accepts max without a warning", () => {
    const lines: string[] = [];
    const env = settingsEnv(JSON.stringify({ reasoning_effort: "max" }));
    expect(readMuseSettings(env, capturingLogger(lines))).toEqual({ reasoningEffort: "max" });
    expect(lines).toEqual([]);
  });

  it("returns empty settings when the file is absent", () => {
    expect(readMuseSettings(settingsEnv(null), silentLogger())).toEqual({});
  });

  it("returns empty settings on malformed JSON without crashing", () => {
    expect(readMuseSettings(settingsEnv("{nope"), silentLogger())).toEqual({});
  });
});

describe("defaultSessionConfig", () => {
  it("prefers user settings over built-ins and validates effort", () => {
    expect(
      defaultSessionConfig({ model: "muse-spark-1.2-contributor", reasoningEffort: "ultra" }),
    ).toEqual({ model: "muse-spark-1.2-contributor", reasoningEffort: "ultra" });
    expect(defaultSessionConfig({ reasoningEffort: "max" }).reasoningEffort).toBe("max");
    expect(defaultSessionConfig({ reasoningEffort: "bogus" })).toEqual({
      model: "muse-spark-1.2",
      reasoningEffort: "high",
    });
  });
});

describe("catalogDefaultModel", () => {
  const row = (id: string, isDefault = false) => ({
    id,
    name: id,
    providerId: "meta",
    profileId: "tbh",
    ...(isDefault ? { isDefault } : {}),
  });
  const catalog = (...models: ReturnType<typeof row>[]) => ({
    status: "available" as const,
    source: "providerCatalog",
    models,
  });

  it("prefers the non-contributor sibling of a contributor default", () => {
    expect(
      catalogDefaultModel(catalog(row("muse-spark-1.3"), row("muse-spark-1.3-contributor", true))),
    ).toMatchObject({ id: "muse-spark-1.3", profileId: "tbh" });
  });

  it("keeps a contributor default without a listed sibling", () => {
    expect(
      catalogDefaultModel(catalog(row("muse-spark-1.2"), row("muse-spark-1.3-contributor", true))),
    ).toMatchObject({ id: "muse-spark-1.3-contributor" });
  });

  it("uses a plain catalog default and has none without a catalog default", () => {
    expect(catalogDefaultModel(catalog(row("a"), row("b", true)))).toMatchObject({ id: "b" });
    expect(catalogDefaultModel(catalog(row("a")))).toBeUndefined();
    expect(catalogDefaultModel({ status: "fallback", models: [], reason: "offline" })).toBe(
      undefined,
    );
  });
});

describe("session config options over ACP", () => {
  it("advertises effective SDK efforts and persists explicit selections across clients", async () => {
    const env = {
      ...settingsEnv(JSON.stringify({ reasoning_effort: "ultra" })),
      XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "muse-config-data-")),
    };
    const testClient = connectTestClient({ backend: "sdk", museBinary: fakeMuseBinary(), env });
    const ctx = await initialized(testClient);
    const { sessionId, configOptions } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-config-cwd-")),
      mcpServers: [],
    });
    expect(configOptions?.find((o) => o.id === "reasoningEffort")).toMatchObject({
      currentValue: "ultra",
      options: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
        (value) => ({
          value,
        }),
      ),
    });
    await expect(
      ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "reasoningEffort",
        value: "unsupported-effort",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "medium",
    });
    expect(readSessionEffort(sessionId, env)).toBe("medium");
    expect(readSessionEffort("unrelated-session", env)).toBeUndefined();
    expect(testClient.agent.sessions.get(sessionId)?.config.reasoningEffort).toBe("medium");
    await testClient.agent.dispose();
  });
  it("advertises options from settings defaults and injects unknown models", async () => {
    const env = settingsEnv(
      JSON.stringify({ schema_version: 1, model: "muse-spark-9.9-beta", reasoning_effort: "low" }),
    );
    const testClient = connectTestClient({ backend: "exec", museBinary: fakeMuseBinary(), env });
    const ctx = await initialized(testClient);

    const { configOptions } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-config-test-")),
      mcpServers: [],
    });

    const model = configOptions?.find((o) => o.id === "model");
    expect(model).toMatchObject({ type: "select", currentValue: "muse-spark-9.9-beta" });
    expect(
      model?.type === "select" ? model.options.flatMap((o) => ("value" in o ? [o.value] : [])) : [],
    ).toContain("muse-spark-1.2");
    const effort = configOptions?.find((o) => o.id === "reasoningEffort");
    expect(effort).toMatchObject({ currentValue: "low" });
  });

  it("applies set_config_option to the next spawn's argv", async () => {
    const lines: string[] = [];
    const testClient = connectTestClient(
      {
        backend: "exec",
        museBinary: fakeMuseBinary(),
        env: { ...settingsEnv(null), FAKE_MUSE_MODE: "exit1" },
      },
      capturingLogger(lines),
    );
    const ctx = await initialized(testClient);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-config-test-")),
      mcpServers: [],
    });

    const response = await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "muse-spark-1.2-contributor",
    });
    expect(response.configOptions.find((o) => o.id === "model")).toMatchObject({
      currentValue: "muse-spark-1.2-contributor",
    });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "minimal",
    });

    await ctx
      .request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] })
      .catch(() => {});

    const spawnLine = lines.find((l) => l.includes("muse-exec spawn:"));
    expect(spawnLine).toMatch(/--model muse-spark-1\.2-contributor/);
    expect(spawnLine).toMatch(/--reasoning-effort minimal/);
  });

  it("rejects unknown config ids and invalid efforts", async () => {
    const testClient = connectTestClient({
      backend: "exec",
      museBinary: fakeMuseBinary(),
      env: settingsEnv(null),
    });
    const ctx = await initialized(testClient);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-config-test-")),
      mcpServers: [],
    });

    await expect(
      ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "nope",
        value: "x",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "reasoningEffort",
        value: "warp-speed",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("exec effort choices", () => {
  it("omits none for provider models, which muse exec 1.4.x refuses", () => {
    expect(effortLevels("exec", "meta")).not.toContain("none");
    expect(effortLevels("exec")).not.toContain("none");
    expect(effortLevels("exec", "echo")).toContain("none");
    expect(effortLevels("sdk")).toContain("none");
  });

  it("rejects none and logs a settings none on exec with the meta provider", async () => {
    const lines: string[] = [];
    const env = settingsEnv(JSON.stringify({ reasoning_effort: "none" }));
    const testClient = connectTestClient(
      { backend: "exec", provider: "meta", museBinary: fakeMuseBinary(), env },
      capturingLogger(lines),
    );
    const ctx = await initialized(testClient);
    const { sessionId, configOptions } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-exec-effort-")),
      mcpServers: [],
    });
    const effort = configOptions?.find((o) => o.id === "reasoningEffort");
    expect(effort).toMatchObject({ currentValue: "high" });
    expect(JSON.stringify(effort)).not.toContain('"value":"none"');
    expect(lines).toEqual(
      expect.arrayContaining([expect.stringContaining('reasoning_effort "none" is not accepted')]),
    );
    await expect(
      ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "reasoningEffort",
        value: "none",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await testClient.agent.dispose();
  });
});
