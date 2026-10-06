import { methods } from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { modelChoice } from "../config-options.js";
import { MuseModelDiscovery, type ModelDiscoveryResult } from "../model-discovery.js";
import { createWireFixture } from "./acp-wire-helpers.js";
import { connectTestClient, fixturesDir } from "./helpers.js";

it("advertises changed host rows over ACP while retaining selected models and effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-model-menu-"));
  const catalog = join(root, "catalog.json");
  const writeCatalog = (id: string) =>
    writeFileSync(
      catalog,
      JSON.stringify({
        source: "fakeCatalog",
        models: [{ modelId: id, displayLabel: `Host ${id}` }],
      }),
    );
  writeCatalog("first");
  const wire = await createWireFixture({ env: { FAKE_MSP_MODELS: catalog } });
  try {
    const first = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    expect(wire.getTranscript().mspRequests).toHaveLength(0);
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId: first.sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    const firstCatalog = wire.updates.findLast(
      (n) => n.update.sessionUpdate === "config_option_update",
    )?.update;
    expect(
      firstCatalog?.sessionUpdate === "config_option_update" &&
        firstCatalog.configOptions.find((o) => o.id === "model"),
    ).toMatchObject({
      options: expect.arrayContaining([{ value: "first", name: "Host first" }]),
    });
    await wire.ctx.request(methods.agent.session.setConfigOption, {
      sessionId: first.sessionId,
      configId: "model",
      value: "first",
    });
    await wire.ctx.request(methods.agent.session.setConfigOption, {
      sessionId: first.sessionId,
      configId: "reasoningEffort",
      value: "minimal",
    });
    const resumed = await wire.ctx.request(methods.agent.session.resume, {
      sessionId: first.sessionId,
      cwd: wire.workspace,
      mcpServers: [],
    });
    expect(resumed.configOptions?.find((o) => o.id === "reasoningEffort")?.currentValue).toBe(
      "minimal",
    );
    writeCatalog("next");
    mkdirSync(join(wire.workspace, "config", "muse"), { recursive: true });
    writeFileSync(
      join(wire.workspace, "config", "muse", "settings.json"),
      JSON.stringify({ model: "configured-next" }),
    );
    const second = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId: second.sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    const secondCatalog = wire.updates.findLast(
      (n) => n.update.sessionUpdate === "config_option_update",
    )?.update;
    expect(
      secondCatalog?.sessionUpdate === "config_option_update" &&
        secondCatalog.configOptions.find((o) => o.id === "model"),
    ).toMatchObject({
      currentValue: "configured-next",
      options: [
        { value: "configured-next", name: "configured-next" },
        { value: "next", name: "Host next" },
      ],
    });
    const selected = await wire.ctx.request(methods.agent.session.setConfigOption, {
      sessionId: first.sessionId,
      configId: "model",
      value: "custom-model",
    });
    expect(selected.configOptions.find((o) => o.id === "reasoningEffort")?.currentValue).toBe(
      "minimal",
    );
    expect(selected.configOptions.find((o) => o.id === "model")?.currentValue).toBe("custom-model");
    await expect(
      wire.ctx.request(methods.agent.session.setConfigOption, {
        sessionId: first.sessionId,
        configId: "reasoningEffort",
        value: "invented",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId: first.sessionId,
      prompt: [{ type: "text", text: "discovered config" }],
    });
    expect(wire.getTranscript().mspRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "turn/start",
          params: expect.objectContaining({ reasoningEffort: "minimal" }),
        }),
      ]),
    );
  } finally {
    await wire.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("labels unsupported discovery and retains only the current SDK model", async () => {
  const wire = await createWireFixture();
  try {
    const created = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const model = created.configOptions?.find((o) => o.id === "model");
    expect(model).toMatchObject({
      description: expect.stringContaining("/models"),
      options: [{ value: model?.currentValue, name: model?.currentValue }],
    });
    expect(wire.getTranscript().mspRequests).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "turn/start" })]),
    );
  } finally {
    await wire.dispose();
  }
});

it("shutdown drains an explicit catalog refresh without publishing stale state", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-discovery-race-"));
  const gate = Promise.withResolvers<ModelDiscoveryResult>();
  const entered = Promise.withResolvers<void>();
  const probe = vi.spyOn(MuseModelDiscovery.prototype, "discover").mockImplementation(() => {
    entered.resolve();
    return gate.promise;
  });
  const client = connectTestClient({
    backend: "sdk",
    museBinary: join(fixturesDir, "fake-msp.cjs"),
    skipSdkHostCheck: true,
  });
  try {
    const { sessionId } = await client.agent.newSession({ cwd: root, mcpServers: [] });
    const refreshing = client.agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    await entered.promise;
    let disposed = false;
    const disposal = client.agent.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    gate.resolve({ status: "available", source: "fakeCatalog", models: [] });
    await disposal;
    expect(await refreshing).toEqual({ stopReason: "cancelled" });
    expect(client.agent.sessions.size).toBe(0);
  } finally {
    gate.resolve({ status: "fallback", models: [], reason: "cleanup" });
    probe.mockRestore();
    await client.agent.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("returns sessions without initialization and refreshes a cancelled catalog without submitting a turn", async () => {
  const wire = await createWireFixture({ env: { FAKE_MSP_BARRIER: "handshake" } });
  try {
    const created = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    expect(wire.getTranscript().mspRequests).toHaveLength(0);
    const refreshing = wire.ctx.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    await expect.poll(() => wire.getTranscript().mspRequests.length).toBeGreaterThan(0);
    await wire.ctx.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
    expect(await refreshing).toEqual({ stopReason: "cancelled" });
    expect(wire.getTranscript().mspRequests).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "turn/start" })]),
    );
    expect(
      wire.updates.filter((n) => n.update.sessionUpdate === "config_option_update"),
    ).toHaveLength(0);
  } finally {
    await wire.dispose();
  }
});

it("keeps turns runnable and reuses the execution host while its optional catalog is unresponsive", async () => {
  const wire = await createWireFixture({ fakeMspMode: "model-timeout" });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    for (let i = 0; i < 2; i++) {
      expect(
        await wire.ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).toEqual({ stopReason: "end_turn" });
    }
    const requests = wire.getTranscript().mspRequests as { method: string }[];
    expect(requests.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "model/list")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
    const before = wire.updates.filter(
      (n) => n.update.sessionUpdate === "config_option_update",
    ).length;
    await wire.ctx.request(methods.agent.session.close, { sessionId });
    expect(
      wire.updates.filter((n) => n.update.sessionUpdate === "config_option_update"),
    ).toHaveLength(before);
  } finally {
    await wire.dispose();
  }
});

it("observes execution catalogs without an extra host and keeps the requested provider route", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-execution-catalog-"));
  const catalog = join(root, "catalog.json");
  writeFileSync(
    catalog,
    JSON.stringify({
      source: "test",
      models: [
        { modelId: "muse-spark-1.2", displayLabel: "Other provider", providerId: "other" },
        { modelId: "alternative", displayLabel: "Alternative", providerId: "meta" },
      ],
    }),
  );
  const wire = await createWireFixture({ env: { FAKE_MSP_MODELS: catalog } });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    for (let i = 0; i < 2; i++)
      await wire.ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
    await expect
      .poll(() =>
        wire.updates.some(
          (n) =>
            n.update.sessionUpdate === "config_option_update" &&
            JSON.stringify(n).includes("Alternative"),
        ),
      )
      .toBe(true);
    const requests = wire.getTranscript().mspRequests as { method: string; params: unknown }[];
    expect(requests.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(requests.find((r) => r.method === "session/setModel")?.params).toMatchObject({
      model: { providerId: "meta" },
    });
    const updatesBeforeRefresh = wire.updates.filter(
      (n) => n.update.sessionUpdate === "config_option_update",
    ).length;
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    expect(
      wire.updates.filter((n) => n.update.sessionUpdate === "config_option_update"),
    ).toHaveLength(updatesBeforeRefresh);
    expect(
      (wire.getTranscript().mspRequests as { method: string }[]).filter(
        (r) => r.method === "initialize",
      ),
    ).toHaveLength(1);
  } finally {
    await wire.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("discards a catalog that completes after its configuration identity changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-stale-catalog-"));
  const catalog = join(root, "catalog.json");
  writeFileSync(
    catalog,
    JSON.stringify({
      source: "stale",
      models: [{ modelId: "stale-model", displayLabel: "Stale model" }],
    }),
  );
  const wire = await createWireFixture({
    env: {
      FAKE_MSP_MODELS: catalog,
      FAKE_MSP_DELAY_METHOD: "model/list",
      FAKE_MSP_DELAY_MS: "500",
    },
  });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const refreshing = wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    await expect
      .poll(() =>
        (wire.getTranscript().mspRequests as { method: string }[]).some(
          (r) => r.method === "model/list",
        ),
      )
      .toBe(true);
    mkdirSync(join(wire.workspace, "config", "muse"), { recursive: true });
    writeFileSync(
      join(wire.workspace, "config", "muse", "settings.json"),
      JSON.stringify({ model: "new-context" }),
    );
    await refreshing;
    expect(
      wire.updates.filter((n) => n.update.sessionUpdate === "config_option_update"),
    ).toHaveLength(0);
    const next = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    expect(JSON.stringify(next.configOptions)).not.toContain("stale-model");
  } finally {
    await wire.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A Muse 1.3+ Meta catalog: every row carries the catalog profile. */
function profiledCatalog(rows: [modelId: string, isDefault?: boolean][]) {
  const root = mkdtempSync(join(tmpdir(), "muse-profiled-catalog-"));
  const catalog = join(root, "catalog.json");
  const models = rows.map(([modelId, isDefault = false]) => ({
    modelId,
    displayLabel: modelId,
    providerId: "meta",
    profileId: "tbh",
    isDefault,
  }));
  writeFileSync(catalog, JSON.stringify({ source: "providerCatalog", models }));
  return { root, catalog };
}

it("routes a profiled catalog selection through session/setModel with its profile", async () => {
  const { root, catalog } = profiledCatalog([["muse-spark-1.3"], ["muse-spark-1.2"]]);
  const wire = await createWireFixture({ env: { FAKE_MSP_MODELS: catalog } });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const value = modelChoice({
      id: "muse-spark-1.2",
      name: "muse-spark-1.2",
      providerId: "meta",
      profileId: "tbh",
    });
    // The execution host reports its catalog once a turn has started it.
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    await expect
      .poll(() =>
        wire.updates.some(
          (n) =>
            n.update.sessionUpdate === "config_option_update" && JSON.stringify(n).includes(value),
        ),
      )
      .toBe(true);
    // The first turn pinned the settings model without a profile; the menu shows
    // it as its catalog row rather than a second, unprofiled entry.
    const update = wire.updates.findLast((n) => n.update.sessionUpdate === "config_option_update")!;
    const menu = (
      update.update as { configOptions: { id: string; options: { value: string }[] }[] }
    ).configOptions.find((o) => o.id === "model")!;
    expect(menu.options.filter((o) => o.value.includes("muse-spark-1.2"))).toEqual([
      expect.objectContaining({ value }),
    ]);
    await wire.ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value,
    });
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "again" }],
    });
    const requests = wire.getTranscript().mspRequests as { method: string; params: unknown }[];
    expect(requests.filter((r) => r.method === "session/setModel").at(-1)?.params).toMatchObject({
      model: { modelId: "muse-spark-1.2", providerId: "meta", profileId: "tbh" },
    });
  } finally {
    await wire.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("follows the catalog default until a turn uses the built-in model", async () => {
  const { root, catalog } = profiledCatalog([
    ["muse-spark-1.3"],
    ["muse-spark-1.3-contributor", true],
    ["muse-spark-1.2"],
  ]);
  const wire = await createWireFixture({ env: { FAKE_MSP_MODELS: catalog } });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/models" }],
    });
    const expected = modelChoice({
      id: "muse-spark-1.3",
      name: "muse-spark-1.3",
      providerId: "meta",
      profileId: "tbh",
    });
    await expect
      .poll(() =>
        wire.updates.some(
          (n) =>
            n.update.sessionUpdate === "config_option_update" &&
            JSON.stringify(n).includes(`"currentValue":"${expected}"`),
        ),
      )
      .toBe(true);
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const requests = wire.getTranscript().mspRequests as { method: string; params: unknown }[];
    expect(requests.filter((r) => r.method === "session/setModel").at(-1)?.params).toMatchObject({
      model: { modelId: "muse-spark-1.3", providerId: "meta", profileId: "tbh" },
    });
    // Later sessions see the cached catalog at creation; a settings model still wins.
    const current = async () => {
      const { configOptions } = await wire.ctx.request(methods.agent.session.new, {
        cwd: wire.workspace,
        mcpServers: [],
      });
      return configOptions?.find((o) => o.id === "model")?.currentValue;
    };
    expect(await current()).toBe(expected);
    mkdirSync(join(wire.workspace, "config", "muse"), { recursive: true });
    writeFileSync(
      join(wire.workspace, "config", "muse", "settings.json"),
      JSON.stringify({ model: "settings-model" }),
    );
    expect(await current()).toBe("settings-model");
  } finally {
    await wire.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
