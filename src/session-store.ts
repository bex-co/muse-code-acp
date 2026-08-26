import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Logger } from "./logger.js";

/**
 * Read-only view over muse's on-disk session store:
 * `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`
 * (verified layout, muse 0.2.1). Never mutates the store.
 */
export interface StoredSession {
  sessionId: string;
  /** Workspace root recorded by muse (realpath'd). */
  cwd: string;
  /** First user prompt, truncated — the human-recognizable handle. */
  title: string;
  /** Log file mtime (ISO) — cheap, honest recency for sorting. */
  updatedAt: string;
  logPath: string;
}

const TITLE_MAX = 80;
/** Only the log head is read when listing — big sessions stay cheap. */
const HEAD_BYTES = 64 * 1024;

export function museDataDir(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME ?? homedir(), ".local", "share");
  return join(dataHome, "muse");
}

export function listStoredSessions(
  cwd: string | null,
  env: Record<string, string | undefined> = process.env,
  logger: Logger = console,
): StoredSession[] {
  const sessionsRoot = join(museDataDir(env), "sessions");
  const wanted = cwd ? tryRealpath(cwd) : null;
  const sessions: StoredSession[] = [];

  for (const logPath of sessionLogPaths(sessionsRoot)) {
    try {
      const head = readHead(logPath);
      const meta = parseHead(head);
      if (!meta) {
        logger.log(`session store: no metadata in ${logPath}; skipping`);
        continue;
      }
      if (wanted && tryRealpath(meta.workspaceRoot) !== wanted) {
        continue;
      }
      sessions.push({
        sessionId: meta.sessionId,
        cwd: meta.workspaceRoot,
        title: meta.title ?? "(no prompt)",
        updatedAt: statSync(logPath).mtime.toISOString(),
        logPath,
      });
    } catch (err) {
      logger.log(`session store: skipping unreadable ${logPath}: ${err}`);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** `sessions/YYYY/MM/DD/<id>/session.jsonl`, tolerant of stray entries. */
function sessionLogPaths(root: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(dir, entry.name);
      if (depth === 4) {
        paths.push(join(path, "session.jsonl"));
      } else {
        walk(path, depth + 1);
      }
    }
  };
  walk(root, 1);
  return paths;
}

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface HeadMeta {
  sessionId: string;
  workspaceRoot: string;
  title: string | null;
}

/**
 * Line 1 is `runtime.session.metadata` (workspace root); the first
 * `runtime.user_intent.accepted` carries the prompt text in `refill_blocks`.
 */
function parseHead(head: string): HeadMeta | null {
  let sessionId: string | null = null;
  let workspaceRoot: string | null = null;
  let title: string | null = null;

  for (const line of head.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // possibly a truncated tail of the head window
    }
    sessionId ??= record?.stream?.id ?? null;
    if (record?.payload_type === "runtime.session.metadata") {
      const root = record?.payload?.record?.workspace_root;
      if (typeof root === "string") {
        workspaceRoot = root;
      }
    }
    if (title === null && record?.payload_type === "runtime.user_intent.accepted") {
      const blocks = record?.payload?.refill_blocks;
      if (Array.isArray(blocks)) {
        const text = blocks
          .map((block) => (typeof block?.text === "string" ? block.text : ""))
          .join(" ")
          .trim();
        if (text) {
          title = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
        }
      }
    }
    if (sessionId && workspaceRoot && title) {
      break;
    }
  }

  return sessionId && workspaceRoot ? { sessionId, workspaceRoot, title } : null;
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
