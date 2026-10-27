import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { requireAvailable, unavailable } from "./availability.js";

/**
 * ACP `additionalDirectories` → Muse `workspaceRoots` (w3/013). Muse 1.4.13
 * enforces every root with the workspace sandbox rules, persists the set, and
 * replaces it on each `turn/start` that carries it; extra roots get no Project
 * Trust. Muse requires canonical, existing directories with the workspace
 * first, so paths are resolved here and duplicates of the workspace dropped.
 */
/** Refuse extra roots up front (before any provider or filesystem work) where Muse cannot enforce them. */
export function requireRootsSupport(
  directories: readonly string[] | null | undefined,
  supported: boolean,
): void {
  if (directories?.length && !supported)
    requireAvailable(
      unavailable(
        "unsupported",
        "Additional directories need the SDK backend on Muse 1.4.13 or newer; start a separate session for another workspace. No additional directory was authorized",
      ),
    );
}

export function normalizeAdditionalDirectories(
  directories: readonly string[] | null | undefined,
  cwd: string,
  supported: boolean,
): string[] {
  if (!directories?.length) return [];
  requireRootsSupport(directories, supported);
  const workspace = realpathSync(cwd);
  const roots: string[] = [];
  for (const directory of directories) {
    if (typeof directory !== "string" || !isAbsolute(directory))
      throw RequestError.invalidParams(
        undefined,
        `additional directory must be an absolute path, got "${String(directory)}"`,
      );
    let resolved: string;
    try {
      resolved = realpathSync(directory);
    } catch {
      throw RequestError.invalidParams(
        undefined,
        `additional directory does not exist: ${directory}`,
      );
    }
    if (!statSync(resolved).isDirectory())
      throw RequestError.invalidParams(
        undefined,
        `additional directory is not a directory: ${directory}`,
      );
    if (resolved !== workspace && !roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

/** The `workspaceRoots` Muse expects: the canonical workspace first. */
export function workspaceRoots(cwd: string, additional: readonly string[]): string[] {
  return [realpathSync(cwd), ...additional];
}

export const sameRoots = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((root, i) => root === b[i]);

export const ROOTS_NOT_APPLIED =
  "Muse applies a session's additional directories with the next prompt, and goal turns run with the directories it last applied. Send a prompt first, then start the goal. No goal was changed.";
