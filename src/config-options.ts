import { RequestError, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { DiscoveredModel, ModelDiscoveryResult } from "./model-discovery.js";
import { MuseSettings } from "./muse-settings.js";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "reasoningEffort";

/**
 * Legacy exec compatibility list. SDK choices come from public model/list;
 * the current configured or restored model remains selectable in either case.
 */
export const KNOWN_MODELS = ["muse-spark-1.2", "muse-spark-1.2-contributor"];
export const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type MuseReasoningEffort = (typeof EFFORT_LEVELS)[number];
export function isReasoningEffort(value: unknown): value is MuseReasoningEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

const DEFAULT_MODEL = "muse-spark-1.2";
const DEFAULT_EFFORT = "high";

export interface SessionConfig {
  safety?: import("./safety-settings.js").SafetySettings;
  model: string;
  providerId?: string;
  profileId?: string | null;
  reasoningEffort: string;
}

/** Resolution order: user muse settings > built-in defaults. */
export function defaultSessionConfig(settings: MuseSettings): SessionConfig {
  return {
    model: settings.model ?? DEFAULT_MODEL,
    ...(settings.provider ? { providerId: settings.provider } : {}),
    reasoningEffort: isReasoningEffort(settings.reasoningEffort)
      ? settings.reasoningEffort
      : DEFAULT_EFFORT,
  };
}

export function buildConfigOptions(
  config: SessionConfig,
  backend: "sdk" | "exec" = "exec",
  discovery?: ModelDiscoveryResult,
  hostVersion?: string | null,
): SessionConfigOption[] {
  const discovered: readonly DiscoveredModel[] =
    backend === "sdk"
      ? discovery?.status === "available"
        ? discovery.models
        : []
      : KNOWN_MODELS.map((id) => ({ id, name: id }));
  const current = discovered.filter(
    (model) =>
      model.id === config.model &&
      (!config.providerId || model.providerId === config.providerId) &&
      (config.profileId === undefined || model.profileId === config.profileId),
  );
  const models =
    current.length === 1
      ? discovered
      : [
          {
            id: config.model,
            name: config.model,
            providerId: config.providerId,
            profileId: config.profileId,
          },
          ...discovered,
        ];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelChoice(
        current.length === 1
          ? current[0]
          : {
              id: config.model,
              name: config.model,
              providerId: config.providerId,
              profileId: config.profileId,
            },
      ),
      description:
        backend === "sdk"
          ? discovery?.status === "available"
            ? `Muse model catalog (${discovery.source}); current selection is retained.`
            : "Showing the current configured or restored model. Use /models to refresh choices before a turn; otherwise choices update when an execution host becomes ready."
          : "Legacy exec model choices.",
      options: models.map((model) => ({
        value: modelChoice(model),
        name: modelOptionName(model, models),
      })),
    },
    {
      id: EFFORT_CONFIG_ID,
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: config.reasoningEffort,
      description: effortDescription(backend, hostVersion),
      options: EFFORT_LEVELS.map((effort) => ({
        value: effort,
        name: effort.charAt(0).toUpperCase() + effort.slice(1),
      })),
    },
  ];
}

/** Validates and applies one set_config_option selection. */
export function applyConfigSelection(
  config: SessionConfig,
  configId: string,
  value: unknown,
  discovery?: ModelDiscoveryResult,
): SessionConfig {
  if (typeof value !== "string") {
    throw RequestError.invalidParams(undefined, `config ${configId} expects a select value`);
  }
  switch (configId) {
    case MODEL_CONFIG_ID:
      return selectModel(config, value, discovery);
    case EFFORT_CONFIG_ID:
      if (!isReasoningEffort(value)) {
        throw RequestError.invalidParams(undefined, `unknown reasoning effort: ${value}`);
      }
      return { ...config, reasoningEffort: value };
    default:
      throw RequestError.invalidParams(undefined, `unknown config option: ${configId}`);
  }
}

/**
 * Clients render the chosen option's name in a narrow chip, so the provider is
 * only worth its width when it actually distinguishes two choices.
 */
function modelOptionName(model: DiscoveredModel, all: readonly DiscoveredModel[]): string {
  const ambiguous = all.some(
    (other) => other.name === model.name && modelChoice(other) !== modelChoice(model),
  );
  if (!model.providerId || !ambiguous) return model.name;
  return `${model.name} (${model.providerId}${model.profileId ? ` / ${model.profileId}` : ""})`;
}

/** Provider/profile-qualified values are opaque ACP choices, never model IDs on MSP. */
export function modelChoice(model: DiscoveredModel): string {
  return model.providerId
    ? `muse-model:${encodeURIComponent(JSON.stringify([model.providerId, model.profileId ?? null, model.id]))}`
    : model.id;
}
export function selectModel(
  config: SessionConfig,
  value: string,
  discovery?: ModelDiscoveryResult,
): SessionConfig {
  const models = discovery?.status === "available" ? discovery.models : [];
  const exact = models.filter((model) => modelChoice(model) === value);
  const matches = exact.length ? exact : models.filter((model) => model.id === value);
  if (matches.length > 1)
    throw RequestError.invalidParams(
      undefined,
      "Ambiguous model ID; select a provider-qualified catalog choice",
    );
  if (matches.length === 1) {
    const model = matches[0];
    return { ...config, model: model.id, providerId: model.providerId, profileId: model.profileId };
  }
  if (
    value.startsWith("muse-model:") &&
    value !==
      modelChoice({
        id: config.model,
        name: config.model,
        providerId: config.providerId,
        profileId: config.profileId,
      })
  )
    throw RequestError.invalidParams(
      undefined,
      "Model choice is no longer in the catalog; refresh the available choices",
    );
  if (!value.trim() || value.length > 512)
    throw RequestError.invalidParams(undefined, "Invalid model ID");
  // A manual ID is an explicit requested setting; the host validates it before a turn.
  return { ...config, model: value.startsWith("muse-model:") ? config.model : value };
}
export function effortDescription(backend: "sdk" | "exec", hostVersion?: string | null): string {
  if (backend === "exec")
    return "Requested CLI effort; provider-specific effective behavior is not verified here.";
  if (hostVersion === "1.1.1")
    return "Requested effort only: Muse 1.1.1 omits effort from the main provider request. Saved preference does not imply effective control.";
  if (hostVersion?.startsWith("1.2.1"))
    return "Requested effort; verified Muse 1.2.1 maps none to minimal and ultra to max. Other listed values reach the main request unchanged. Per-model restrictions are unavailable.";
  return "Requested effort only; effective mapping is unverified for this host. On Muse 1.3 and later, max is its own tier and ultra may be gated. Per-model restrictions are unavailable.";
}

export function resolvedModel(
  config: SessionConfig,
  discovery: ModelDiscoveryResult | undefined,
  defaultProvider = "meta",
): { model: string; providerId: string; profileId?: string | null } {
  const candidates =
    discovery?.status === "available"
      ? discovery.models.filter(
          (model) =>
            model.id === config.model &&
            (!config.providerId || model.providerId === config.providerId) &&
            (config.profileId === undefined || (model.profileId ?? null) === config.profileId),
        )
      : [];
  if (candidates.length > 1)
    throw RequestError.invalidParams(
      undefined,
      "Current model has ambiguous provider/profile identity; select a qualified catalog choice",
    );
  return {
    model: config.model,
    providerId: config.providerId ?? candidates[0]?.providerId ?? defaultProvider,
    profileId: config.profileId !== undefined ? config.profileId : candidates[0]?.profileId,
  };
}
