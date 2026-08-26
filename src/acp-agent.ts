import {
  agent as acpAgent,
  AgentContext,
  CancelNotification,
  ClientApp,
  InitializeRequest,
  InitializeResponse,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  PROTOCOL_VERSION,
  RequestError,
  SessionNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  Stream,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { Logger } from "./logger.js";
import { guardContext, isModeAvailable, MODES, modeState, MuseModeId } from "./modes.js";
import { MuseExecHandle, spawnMuseExec } from "./muse-exec.js";
import { TurnTranslator } from "./translate.js";
import { nodeToWebReadable, nodeToWebWritable, unreachable } from "./utils.js";

export type { Logger } from "./logger.js";

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
}

/**
 * Bridges {@link AcpClient} to the connection-scoped {@link AgentContext}. The
 * peer handle is valid for the entire connection lifetime, so it is captured
 * once at construction. All agent→client traffic funnels through here.
 */
class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params);
  }
}

export interface SessionState {
  /** Working directory every `muse exec` turn for this session runs in. */
  cwd: string;
  /** The muse `--session-id`; minted by us and identical to the ACP session id. */
  museSessionId: string;
  /** Live `muse exec` child while a prompt turn is running. */
  activeTurn: MuseExecHandle | null;
  /** Set by `session/cancel`; forces the turn to settle with `cancelled`. */
  cancelRequested: boolean;
  /** Active ACP session mode; decides the safety flags of the next spawn. */
  modeId: MuseModeId;
}

/**
 * Engine knobs threaded into every `muse exec` spawn. Production leaves them
 * empty (muse's own defaults + user settings apply); tests inject the echo
 * provider, a fake binary, and an isolated XDG data dir.
 */
export interface MuseAgentOptions {
  museBinary?: string;
  provider?: "meta" | "echo";
  env?: Record<string, string | undefined>;
}

export class MuseAcpAgent {
  readonly sessions = new Map<string, SessionState>();

  constructor(
    readonly client: AcpClient,
    readonly logger: Logger = console,
    readonly options: MuseAgentOptions = {},
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      // Only advertise what is actually implemented; capabilities grow with
      // the milestones that ship them.
      agentCapabilities: {
        promptCapabilities: {},
      },
      agentInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        undefined,
        `cwd must be an absolute path, got "${params.cwd}"`,
      );
    }
    // The ACP session id doubles as the muse `--session-id`. Muse creates its
    // on-disk session log lazily on the first exec, so nothing is spawned here.
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      cwd: params.cwd,
      museSessionId: sessionId,
      activeTurn: null,
      cancelRequested: false,
      modeId: "default",
    });
    return { sessionId, modes: modeState("default", guardContext()) };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    if (!isModeAvailable(params.modeId, guardContext())) {
      throw RequestError.invalidParams(
        undefined,
        `unknown or unavailable session mode: ${params.modeId}`,
      );
    }
    session.modeId = params.modeId;
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activeTurn) {
      throw RequestError.invalidRequest(
        undefined,
        `session ${params.sessionId} already has a prompt turn in flight`,
      );
    }

    const promptText = promptToText(params.prompt);
    if (promptText.length === 0) {
      throw RequestError.invalidParams(undefined, "prompt contains no text content");
    }

    session.cancelRequested = false;
    const handle = spawnMuseExec({
      prompt: promptText,
      sessionId: session.museSessionId,
      cwd: session.cwd,
      museBinary: this.options.museBinary,
      provider: this.options.provider,
      env: this.options.env,
      extraArgs: MODES[session.modeId].flags,
      logger: this.logger,
    });
    session.activeTurn = handle;

    const translator = new TurnTranslator(params.sessionId, this.logger);
    try {
      for await (const envelope of handle.events) {
        for (const notification of translator.toUpdates(envelope)) {
          await this.client.sessionUpdate(notification);
        }
      }
      const outcome = await handle.done;
      if (session.cancelRequested || outcome.kind === "cancelled") {
        // ACP requires the prompt to settle with `cancelled` after a
        // session/cancel, even if the child managed to finish first.
        return { stopReason: "cancelled" };
      }
      switch (outcome.kind) {
        case "completed":
          return { stopReason: "end_turn" };
        case "usage-error":
          throw RequestError.internalError(
            undefined,
            `muse exec rejected the invocation (exit ${outcome.code}) — ` +
              `adapter/CLI flag mismatch. argv: ${handle.argv.join(" ")}`,
          );
        case "failed": {
          const terminal = translator.lastTerminal;
          // Muse exits 1 when --max-model-steps caps the run; that is a turn
          // limit, not an error (best-effort match on the terminal reason).
          if (/max[ _-]?(model[ _-]?)?steps/i.test(terminal?.reason ?? "")) {
            return { stopReason: "max_turn_requests" };
          }
          throw this.turnFailure(outcome.code, terminal);
        }
        default:
          return (unreachable(outcome, this.logger), { stopReason: "end_turn" });
      }
    } finally {
      session.activeTurn = null;
    }
  }

  /**
   * Classifies an exit-1 turn using the run's own terminal record. Note: exit
   * codes describe run completion, not code correctness — an exit-0 turn where
   * the agent reports failing tests is still `end_turn`; only run-level
   * failures land here.
   */
  private turnFailure(
    code: number,
    terminal: { terminal: string; text?: string | null; reason?: string | null } | null,
  ): RequestError {
    const detail = [terminal?.reason, terminal?.text].filter(Boolean).join(" — ");
    if (/auth|credential|api.?key|unauthorized|log.?in|401/i.test(detail)) {
      return RequestError.authRequired(
        undefined,
        `muse provider authentication failed: ${detail}. ` +
          `Run \`muse login\` or set META_API_KEY.`,
      );
    }
    return RequestError.internalError(
      undefined,
      detail ? `muse exec failed (exit ${code}): ${detail}` : `muse exec failed (exit ${code})`,
    );
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.logger.error(`cancel for unknown session: ${params.sessionId}`);
      return;
    }
    session.cancelRequested = true;
    session.activeTurn?.kill();
  }

  requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(undefined, `unknown session: ${sessionId}`);
    }
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.activeTurn?.kill();
    }
  }
}

/**
 * m1 supports text prompts only. Text blocks are joined; other block types
 * (images, resources) arrive in later milestones and are ignored with a log
 * so the turn still runs.
 */
function promptToText(blocks: PromptRequest["prompt"]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Builds the ACP agent app and connects it to `target` (a transport stream in
 * production, a `ClientApp` for in-process tests). The handlers close over
 * `agent`, which is assigned synchronously right after `connect()` returns —
 * before the connection processes any inbound message.
 */
export function createAgentConnection(
  target: Stream | ClientApp,
  logger: Logger = console,
  options: MuseAgentOptions = {},
) {
  // eslint-disable-next-line prefer-const
  let agent: MuseAcpAgent;
  const connection = acpAgent({ name: "muse-code-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(target as Stream);

  agent = new MuseAcpAgent(new ClientConnection(connection.client), logger, options);
  return { connection, agent };
}

export function runAcp(logger?: Logger) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  return createAgentConnection(stream, logger);
}
