import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Logger } from "./logger.js";

/**
 * The subset of `~/.config/muse/settings.json` the adapter reads for
 * defaults. Read-only: this file belongs to the user/muse, never write it.
 */
export interface MuseSettings {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

export function museSettingsPath(env: Record<string, string | undefined> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(configHome, "muse", "settings.json");
}

/** Absent or malformed settings never crash the adapter — defaults apply. */
export function readMuseSettings(
  env: Record<string, string | undefined> = process.env,
  logger: Logger = console,
): MuseSettings {
  const path = museSettingsPath(env);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    logger.log(`muse settings unavailable at ${path}: ${err}`);
    return {};
  }
  if (typeof raw !== "object" || raw === null) {
    logger.log(`muse settings at ${path} is not an object; ignoring`);
    return {};
  }
  const settings = raw as Record<string, unknown>;
  return {
    provider: typeof settings.provider === "string" ? settings.provider : undefined,
    model: typeof settings.model === "string" ? settings.model : undefined,
    reasoningEffort:
      typeof settings.reasoning_effort === "string" ? settings.reasoning_effort : undefined,
  };
}
