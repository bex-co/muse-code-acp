import { spawn } from "node:child_process";
import { Logger } from "./logger.js";
import { museCliPath } from "./muse-cli.js";
import { MuseEnvelope, MuseLineParser } from "./muse-events.js";
import { Pushable } from "./utils.js";

export interface MuseExecOptions {
  prompt: string;
  /** Muse `--session-id`; identical to the ACP session id. */
  sessionId: string;
  /** Working directory of the run (muse's workspace root defaults to cwd). */
  cwd: string;
  /** Path to the muse binary; resolved via {@link museCliPath} when omitted. */
  museBinary?: string;
  /** `--provider echo` is the deterministic offline provider used in tests. */
  provider?: "meta" | "echo";
  model?: string;
  reasoningEffort?: string;
  /** Turn-scoped images forwarded through Muse's repeatable `--image` flag. */
  imagePaths?: string[];
  /** Extra CLI flags appended verbatim (e.g. `--echo-delay-ms` in tests). */
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /**
   * How long a proposed tool may wait for its approval decision before the
   * run is stopped. Defaults to `MUSE_CODE_ACP_EXEC_APPROVAL_STALL_MS` or 120 s.
   */
  approvalStallMs?: number;
}

export type MuseExitOutcome =
  | { kind: "completed"; code: 0 }
  | { kind: "failed"; code: number }
  | { kind: "usage-error"; code: number }
  | { kind: "cancelled"; code: number | null; signal: string | null };

export interface MuseExecHandle {
  /** Parsed JSONL envelopes off the child's stdout, in order. */
  events: AsyncIterable<MuseEnvelope>;
  /** Cooperative cancel: SIGINT by default (muse exits 130 and journals safely). */
  kill(signal?: "SIGINT" | "SIGTERM"): void;
  /** Settles when the child exits; never rejects. */
  done: Promise<MuseExitOutcome>;
  /**
   * Set when the run was stopped because a proposed tool never received an
   * approval decision: headless `muse exec` (1.4.x) waits forever when its
   * reviewer escalates to a user, and publishes nothing the adapter can answer.
   */
  approvalStall(): { taskKind: string } | null;
  pid: number | undefined;
  /** The exact command line spawned — for usage-error diagnostics. */
  argv: string[];
}

/**
 * Spawns one headless muse turn: `muse exec --json --session-id <id> <prompt>`.
 * stdout carries the JSONL event stream (verified: the `muse:` startup
 * preamble goes to stderr, which is logged, never parsed).
 */
export function spawnMuseExec(options: MuseExecOptions): MuseExecHandle {
  const logger = options.logger ?? console;
  const binary = options.museBinary ?? museCliPath();

  const args = ["exec", "--json", "--session-id", options.sessionId];
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort) {
    args.push("--reasoning-effort", options.reasoningEffort);
  }
  for (const imagePath of options.imagePaths ?? []) {
    args.push("--image", imagePath);
  }
  // Note: no `--no-session-log` ever — muse rejects it alongside
  // `--session-id` ("a session id needs retained logging"), and session
  // continuity/resume depend on the retained log. Tests isolate the store via
  // XDG_DATA_HOME instead.
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  args.push(options.prompt);

  logger.log(`muse-exec spawn: ${binary} ${args.join(" ")}`);
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: (options.env ?? process.env) as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const events = new Pushable<MuseEnvelope>();
  const stallMs =
    options.approvalStallMs ??
    (Number((options.env ?? process.env).MUSE_CODE_ACP_EXEC_APPROVAL_STALL_MS) || 120_000);
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled: { taskKind: string } | null = null;
  // Any later event (decision, start, rejection) clears the watch, so this can
  // miss a stall hidden behind unrelated events but never fires on progress.
  const watchApproval = (envelope: MuseEnvelope) => {
    clearTimeout(stallTimer);
    const event = envelope.payload.event as { kind?: unknown; task_kind?: unknown } | undefined;
    const taskKind = typeof event?.task_kind === "string" ? event.task_kind : "";
    if (envelope.payload_type !== "task.lifecycle.proposed" || !taskKind.startsWith("tool."))
      return;
    stallTimer = setTimeout(() => {
      stalled = { taskKind };
      logger.log(`muse-exec[${child.pid}] ${taskKind} had no approval decision after ${stallMs}ms`);
      killedByUs = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, stallMs);
  };
  const parser = new MuseLineParser(
    (envelope) => {
      watchApproval(envelope);
      events.push(envelope);
    },
    (line, reason) => logger.log(`muse-exec[${child.pid}] skipped line (${reason}): ${line}`),
  );

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => parser.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim().length > 0) {
        logger.log(`muse-exec[${child.pid}] stderr: ${line}`);
      }
    }
  });

  let killedByUs = false;
  const done = new Promise<MuseExitOutcome>((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(stallTimer);
      parser.end();
      events.end();
      resolve(resolveOutcome(code, signal, killedByUs));
    });
    child.on("error", (err) => {
      clearTimeout(stallTimer);
      logger.error(`muse-exec spawn failed: ${err.message}`);
      parser.end();
      events.end();
      resolve({ kind: "failed", code: -1 });
    });
  });

  return {
    events,
    kill(signal: "SIGINT" | "SIGTERM" = "SIGINT") {
      killedByUs = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    },
    done,
    approvalStall: () => stalled,
    pid: child.pid,
    argv: [binary, ...args],
  };
}

/**
 * Exit contract (muse 0.2.1): 0 completed, 1 failed or cancelled, 2 usage
 * error, 130/143 SIGINT/SIGTERM. Note exit 0 means the *turn* completed — the
 * agent may still be reporting that your tests fail.
 */
function resolveOutcome(
  code: number | null,
  signal: string | null,
  killedByUs: boolean,
): MuseExitOutcome {
  if (signal !== null || code === 130 || code === 143) {
    return { kind: "cancelled", code, signal };
  }
  if (code === 0) {
    return { kind: "completed", code };
  }
  if (code === 2) {
    return { kind: "usage-error", code: code };
  }
  if (killedByUs) {
    // Exit 1 covers both "failed" and "cancelled"; our own kill disambiguates.
    return { kind: "cancelled", code, signal };
  }
  return { kind: "failed", code: code ?? -1 };
}
