import { RequestError, SessionConfigOption } from "@agentclientprotocol/sdk";
import { MuseSettings } from "./muse-settings.js";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "reasoningEffort";

/**
 * Muse has no model-list API; this static list tracks the launch lineup and
 * is easy to extend. A settings.json model outside the list is injected so
 * the user's own default is always selectable.
 */
export const KNOWN_MODELS = ["muse-spark-1.2", "muse-spark-1.2-contributor"];
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"];

const DEFAULT_MODEL = "muse-spark-1.2";
const DEFAULT_EFFORT = "high";

export interface SessionConfig {
  model: string;
  reasoningEffort: string;
}

/** Resolution order: user muse settings > built-in defaults. */
export function defaultSessionConfig(settings: MuseSettings): SessionConfig {
  return {
    model: settings.model ?? DEFAULT_MODEL,
    reasoningEffort:
      settings.reasoningEffort && EFFORT_LEVELS.includes(settings.reasoningEffort)
        ? settings.reasoningEffort
        : DEFAULT_EFFORT,
  };
}

export function buildConfigOptions(config: SessionConfig): SessionConfigOption[] {
  const models = KNOWN_MODELS.includes(config.model)
    ? KNOWN_MODELS
    : [config.model, ...KNOWN_MODELS];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: config.model,
      options: models.map((model) => ({ value: model, name: model })),
    },
    {
      id: EFFORT_CONFIG_ID,
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: config.reasoningEffort,
      options: EFFORT_LEVELS.map((effort) => ({ value: effort, name: effort })),
    },
  ];
}

/** Validates and applies one set_config_option selection. */
export function applyConfigSelection(
  config: SessionConfig,
  configId: string,
  value: unknown,
): SessionConfig {
  if (typeof value !== "string") {
    throw RequestError.invalidParams(undefined, `config ${configId} expects a select value`);
  }
  switch (configId) {
    case MODEL_CONFIG_ID:
      return { ...config, model: value };
    case EFFORT_CONFIG_ID:
      if (!EFFORT_LEVELS.includes(value)) {
        throw RequestError.invalidParams(undefined, `unknown reasoning effort: ${value}`);
      }
      return { ...config, reasoningEffort: value };
    default:
      throw RequestError.invalidParams(undefined, `unknown config option: ${configId}`);
  }
}
