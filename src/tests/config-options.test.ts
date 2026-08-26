import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSessionConfig } from "../config-options.js";
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
    expect(defaultSessionConfig({ reasoningEffort: "bogus" })).toEqual({
      model: "muse-spark-1.2",
      reasoningEffort: "high",
    });
  });
});

describe("session config options over ACP", () => {
  it("advertises options from settings defaults and injects unknown models", async () => {
    const env = settingsEnv(
      JSON.stringify({ schema_version: 1, model: "muse-spark-9.9-beta", reasoning_effort: "low" }),
    );
    const testClient = connectTestClient({ museBinary: fakeMuseBinary(), env });
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
    const testClient = connectTestClient({ museBinary: fakeMuseBinary(), env: settingsEnv(null) });
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
