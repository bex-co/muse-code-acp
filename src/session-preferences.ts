import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { museDataDir } from "./session-store.js";
import { SDK_EFFORT_LEVELS } from "./config-options.js";

// MSP persists the model, but has no session-level reasoning-effort field.
// Keep only the explicit ACP effort selection in adapter-owned storage.
function preferencePath(sessionId: string, env: Record<string, string | undefined>): string {
  return join(
    dirname(museDataDir(env)),
    "muse-code-acp",
    "sessions",
    `${encodeURIComponent(sessionId)}.json`,
  );
}

export function readSessionEffort(
  sessionId: string,
  env: Record<string, string | undefined>,
): string | undefined {
  let doc;
  try {
    doc = JSON.parse(readFileSync(preferencePath(sessionId, env), "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  if (doc.schemaVersion !== 1 || !SDK_EFFORT_LEVELS.includes(doc.reasoningEffort)) {
    throw new Error("Invalid stored ACP reasoning-effort preference");
  }
  return doc.reasoningEffort;
}

export function writeSessionEffort(
  sessionId: string,
  reasoningEffort: string,
  env: Record<string, string | undefined>,
): void {
  const path = preferencePath(sessionId, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ schemaVersion: 1, reasoningEffort }), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
