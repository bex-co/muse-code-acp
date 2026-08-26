import { SessionNotification } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "./logger.js";
import { museCliPath } from "./muse-cli.js";

/**
 * Runs `muse export --session <id>` and parses the self-contained document
 * (export_schema_version 1). Export is preferred over raw log parsing: the
 * on-disk log uses an internal runtime.* vocabulary, while the export wraps
 * each record with derived metadata and stable event kinds.
 */
export async function runMuseExport(
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
  logger: Logger = console,
): Promise<MuseExportDocument> {
  const outDir = mkdtempSync(join(tmpdir(), "muse-export-"));
  const outFile = join(outDir, "export.json");
  const binary = museBinary ?? museCliPath();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["export", "--session", sessionId, "--out", outFile], {
      env: env as Record<string, string>,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`muse export exited ${code}: ${stderr.trim()}`));
      }
    });
  });

  try {
    return JSON.parse(readFileSync(outFile, "utf8")) as MuseExportDocument;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    void logger;
  }
}

export interface MuseExportDocument {
  export_schema_version: number;
  events?: Array<{
    envelope?: { payload?: Record<string, any> };
  }>;
}

/**
 * Replays an export document as ACP session updates, in original order:
 * user prompts (`run.started`), agent replies (`assistant_message_committed`),
 * and tool calls (task `side_effect_intent` → `completed`/`failed`).
 * Encrypted reasoning has no plaintext in exports and is skipped silently.
 */
export function exportToUpdates(
  sessionId: string,
  doc: MuseExportDocument,
  logger: Logger = console,
): SessionNotification[] {
  if (doc.export_schema_version !== 1) {
    logger.log(`muse export schema ${doc.export_schema_version} (expected 1); replaying anyway`);
  }
  const updates: SessionNotification[] = [];
  /** task_id → call info for tool tasks seen in this replay. */
  const toolTasks = new Map<string, { callId: string; toolName: string }>();

  const push = (update: SessionNotification["update"]) => updates.push({ sessionId, update });

  for (const wrapped of doc.events ?? []) {
    const payload = wrapped.envelope?.payload;
    const event = payload?.event;
    if (!payload || !event) {
      continue;
    }
    if (payload.kind === "run") {
      if (event.kind === "started" && typeof event.prompt === "string" && event.prompt) {
        push({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: event.prompt },
        });
      } else if (event.kind === "assistant_message_committed" && typeof event.text === "string") {
        push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.text },
        });
      }
    } else if (payload.kind === "task") {
      const taskId = typeof payload.task_id === "string" ? payload.task_id : "";
      if (
        event.kind === "side_effect_intent" &&
        typeof event.operation === "string" &&
        event.operation.startsWith("tool:")
      ) {
        const toolName = event.operation.slice("tool:".length);
        const key = typeof event.idempotency_key === "string" ? event.idempotency_key : taskId;
        const callId = key.startsWith("tool:") ? key.slice("tool:".length) : key;
        toolTasks.set(taskId, { callId, toolName });
        push({
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: toolName,
          name: toolName,
          status: "pending",
        });
      } else if (event.kind === "completed" || event.kind === "failed") {
        const call = toolTasks.get(taskId);
        if (call) {
          push({
            sessionUpdate: "tool_call_update",
            toolCallId: call.callId,
            status: event.kind === "completed" ? "completed" : "failed",
          });
          toolTasks.delete(taskId);
        }
      }
    }
  }
  return updates;
}
