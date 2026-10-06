import { expect, it } from "vitest";
import { buildConfigOptions, modelChoice, selectModel } from "../config-options.js";
import { gatewayFromEnv, parseClientProvider, providerBinding } from "../client-provider.js";

const config = { model: "shared", reasoningEffort: "high" };
const discovery = {
  status: "available" as const,
  source: "providerCatalog",
  models: [
    { id: "shared", name: "Shared", providerId: "first" },
    { id: "shared", name: "Shared", providerId: "second" },
  ],
};
it("preserves provider identity instead of collapsing overlapping model IDs", () => {
  expect(() => selectModel(config, "shared", discovery)).toThrow(/Ambiguous/);
  const value = modelChoice(discovery.models[1]);
  const selected = selectModel(config, value, discovery);
  expect(selected).toMatchObject({ model: "shared", providerId: "second" });
  const option = buildConfigOptions(selected, "sdk", discovery).find((o) => o.id === "model")!;
  expect(option.currentValue).toBe(value);
  expect(JSON.stringify(option)).toContain("first");
  expect(JSON.stringify(option)).toContain("second");
  expect(() =>
    selectModel(config, value, { status: "fallback", models: [], reason: "offline" }),
  ).toThrow(/no longer/);
});
it("qualifies a model name with its provider only when a peer shares that name", () => {
  // Select exactly one catalog entry so no synthetic current-model entry joins
  // the list and the names below are the catalog's own.
  const names = (models: { id: string; name: string; providerId?: string }[]) => {
    const option = buildConfigOptions(
      { ...config, model: models[0].id, providerId: "first" },
      "sdk",
      {
        status: "available" as const,
        source: "providerCatalog",
        models,
      },
    ).find((o) => o.id === "model")!;
    if (option.type !== "select") throw Error("wrong type");
    return option.options.flatMap((o) => ("name" in o ? [o.name] : []));
  };
  // Ambiguous: the provider is the only thing telling the two choices apart.
  expect(names(discovery.models)).toEqual(["Shared (first)", "Shared (second)"]);
  // Unambiguous: the provider would only cost chip width.
  expect(names([{ id: "solo", name: "Solo", providerId: "first" }])).toEqual(["Solo"]);
  expect(
    names([
      { id: "solo", name: "Solo", providerId: "first" },
      { id: "other", name: "Other", providerId: "second" },
    ]),
  ).toEqual(["Solo", "Other"]);
});
it("keeps a saved qualified selection while discovery is unavailable", () => {
  const saved = { ...config, providerId: "second" };
  const value = modelChoice({ id: saved.model, name: saved.model, providerId: saved.providerId });
  expect(selectModel(saved, value)).toEqual(saved);
  expect(buildConfigOptions(saved, "sdk").find((o) => o.id === "model")?.currentValue).toBe(value);
});
it("provider credentials are explicit, rotated separately and absent from durable identity", () => {
  const a = parseClientProvider({
    providerId: "meta",
    baseUrl: "http://127.0.0.1:9000/",
    apiKey: "secret-a",
  });
  const b = parseClientProvider({ ...a, apiKey: "secret-b" });
  expect(providerBinding(a)).toBe(providerBinding(b));
  expect(providerBinding({ ...a, baseUrl: "http://127.0.0.1:9001" })).not.toBe(providerBinding(a));
  expect(() => parseClientProvider({ ...a, baseUrl: "http://user:secret@localhost/" })).toThrow(
    /without embedded credentials/,
  );
  expect(() => parseClientProvider({ ...a, apiKey: "" })).toThrow(/nonempty/);
  expect(() => parseClientProvider({ ...a, providerId: "unknown" })).toThrow(/Unsupported/);
});
it("an environment gateway is the same explicit endpoint, and needs both halves", () => {
  expect(gatewayFromEnv({})).toBeUndefined();
  expect(
    gatewayFromEnv({
      MUSE_CODE_ACP_GATEWAY_URL: "https://gateway.example/meta/",
      MUSE_CODE_ACP_GATEWAY_KEY: "secret",
    }),
  ).toEqual({ providerId: "meta", baseUrl: "https://gateway.example/meta", apiKey: "secret" });
  expect(() => gatewayFromEnv({ MUSE_CODE_ACP_GATEWAY_URL: "https://gateway.example" })).toThrow(
    /must be set together/,
  );
  expect(() => gatewayFromEnv({ MUSE_CODE_ACP_GATEWAY_KEY: "secret" })).toThrow(
    /must be set together/,
  );
  expect(() =>
    gatewayFromEnv({
      MUSE_CODE_ACP_GATEWAY_URL: "https://user:secret@gateway.example",
      MUSE_CODE_ACP_GATEWAY_KEY: "secret",
    }),
  ).toThrow(/without embedded credentials/);
});

it("recommendations retain explicit values and use only advertised choices", async () => {
  const { configRecommendations } = await import("../config-recommendations.js");
  const catalog = {
    ...discovery,
    models: [discovery.models[0], { ...discovery.models[1], isDefault: true }],
  };
  const selected = { ...config, providerId: "first" };
  const options = buildConfigOptions(selected, "sdk", catalog, "1.2.1");
  const recommended = configRecommendations(options, catalog, "1.2.1");
  const model = recommended.find((o) => o.id === "model")!;
  expect(model.currentValue).toBe(modelChoice(catalog.models[0]));
  expect(model._meta?.["muse/configRecommendations"]).toMatchObject({
    value: modelChoice(catalog.models[1]),
    source: "providerCatalog",
    applied: false,
  });
  expect(options.find((o) => o.id === "model")?._meta).toBeUndefined();
  const fallback = configRecommendations(buildConfigOptions(selected, "sdk"), undefined, "1.1.1");
  expect(
    fallback.find((o) => o.id === "reasoningEffort")?._meta?.["muse/configRecommendations"],
  ).toMatchObject({ status: "unavailable" });
  expect(
    fallback.find((o) => o.id === "model")?._meta?.["muse/configRecommendations"],
  ).toMatchObject({ source: "retainedSelection", applied: false });
});

it("advertises and selects catalog models that carry a named profile", () => {
  // Muse 1.3.0 provider catalogs tag every row with the account's catalog
  // profile, so filtering profiled rows left only the synthetic current model.
  const profiled = { id: "named", name: "Named", providerId: "meta", profileId: "team" };
  const catalog = { status: "available" as const, source: "providerCatalog", models: [profiled] };
  const value = modelChoice(profiled);
  const option = buildConfigOptions(config, "sdk", catalog).find((o) => o.id === "model")!;
  if (option.type !== "select") throw Error("wrong type");
  expect(option.options.map((o) => ("value" in o ? o.value : undefined))).toContain(value);
  expect(selectModel(config, value, catalog)).toMatchObject({
    model: "named",
    providerId: "meta",
    profileId: "team",
  });
  expect(selectModel(config, "named", catalog)).toMatchObject({ profileId: "team" });
});

it("shows a selection pinned without a profile as the one catalog row it names", () => {
  const row = { id: "named", name: "Named", providerId: "meta", profileId: "team" };
  const values = (models: (typeof row)[]) => {
    const option = buildConfigOptions(
      { model: "named", providerId: "meta", profileId: null, reasoningEffort: "high" },
      "sdk",
      { status: "available" as const, source: "providerCatalog", models },
    ).find((o) => o.id === "model")!;
    if (option.type !== "select") throw Error("wrong type");
    return {
      current: option.currentValue,
      options: option.options.map((o) => ("value" in o ? o.value : undefined)),
    };
  };
  // A turn before the catalog arrived, or a session saved by an older adapter.
  expect(values([row])).toEqual({ current: modelChoice(row), options: [modelChoice(row)] });
  // Two profiles for the same model: the pinned selection stays distinct.
  const other = { ...row, profileId: "other" };
  const pinned = modelChoice({ ...row, profileId: null });
  expect(values([row, other])).toEqual({
    current: pinned,
    options: [pinned, modelChoice(row), modelChoice(other)],
  });
});
