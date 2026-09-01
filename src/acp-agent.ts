import {
  agent as acpAgent,
  AgentContext,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ClientApp,
  CloseSessionRequest,
  CloseSessionResponse,
  LogoutRequest,
  LogoutResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  PROTOCOL_VERSION,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  Stream,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  isAuthenticated,
  META_API_KEY_METHOD_ID,
  MUSE_LOGIN_METHOD_ID,
  museAuthMethods,
  runMuseLogout,
} from "./auth.js";
import {
  applyConfigSelection,
  buildConfigOptions,
  defaultSessionConfig,
  SessionConfig,
} from "./config-options.js";
import { Logger } from "./logger.js";
import { guardContext, isModeAvailable, MODES, modeState, MuseModeId } from "./modes.js";
import { MuseExecHandle, spawnMuseExec } from "./muse-exec.js";
import { createMuseMcpOverlay, MuseMcpOverlay } from "./mcp-overlay.js";
import { compileMusePrompt, type CompiledMusePrompt } from "./prompt-content.js";
import { readMuseSettings } from "./muse-settings.js";
import { exportToUpdates, runMuseExport } from "./session-export.js";
import { listStoredSessions } from "./session-store.js";
import { listMuseSkills, skillsToCommands } from "./skills.js";
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
  /** Completion signal that reserves the session through final turn cleanup. */
  turnFinished: Promise<void> | null;
  /** Set by `session/cancel`; forces the turn to settle with `cancelled`. */
  cancelRequested: boolean;
  /** Active ACP session mode; decides the safety flags of the next spawn. */
  modeId: MuseModeId;
  /** Model + reasoning effort applied to every spawn for this session. */
  config: SessionConfig;
  /** ACP-provided MCP servers injected into Muse for each turn. */
  mcpServers: McpServer[];
  /** Live per-turn Muse configuration overlay, if this session uses MCP. */
  activeMcpOverlay: MuseMcpOverlay | null;
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

async function cleanupPromptArtifacts(
  mcpOverlay: MuseMcpOverlay | null,
  compiledPrompt: CompiledMusePrompt | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => mcpOverlay?.cleanup()),
    compiledPrompt?.cleanup() ?? Promise.resolve(),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

function resolveResumeWorkspace(cwd: string, stored: boolean): string {
  try {
    return realpathSync(cwd);
  } catch {
    throw RequestError.invalidParams(
      undefined,
      stored
        ? `stored workspace directory is unavailable: ${cwd}; start a new session`
        : `workspace directory does not exist or is unavailable: ${cwd}`,
    );
  }
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
        promptCapabilities: { image: true },
        mcpCapabilities: {},
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
        auth: { logout: {} },
      },
      authMethods: museAuthMethods(),
      agentInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
      _meta: {
        "bex.security/capabilities": {
          delegatedWorkers: false,
          usage: "unavailable",
          interactivePermissions: false,
        },
      },
    };
  }

  /**
   * For both methods `authenticate` VERIFIES the credential state: browser
   * login runs client-side (terminal method / `--cli login`), and env keys
   * are provided by the client's environment — the adapter only confirms.
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (params.methodId !== MUSE_LOGIN_METHOD_ID && params.methodId !== META_API_KEY_METHOD_ID) {
      throw RequestError.invalidParams(undefined, `unknown auth method: ${params.methodId}`);
    }
    if (!isAuthenticated(this.options.env ?? process.env)) {
      throw RequestError.authRequired(
        undefined,
        params.methodId === META_API_KEY_METHOD_ID
          ? "META_API_KEY is not set in the adapter environment"
          : "no stored muse credentials found — run `muse-code-acp --cli login` in a terminal",
      );
    }
    return {};
  }

  async logout(_params: LogoutRequest): Promise<LogoutResponse> {
    await runMuseLogout(this.options.env ?? process.env, this.options.museBinary, this.logger);
    return {};
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
    const config = defaultSessionConfig(
      readMuseSettings(this.options.env ?? process.env, this.logger),
    );
    this.sessions.set(sessionId, {
      cwd: params.cwd,
      museSessionId: sessionId,
      activeTurn: null,
      turnFinished: null,
      cancelRequested: false,
      modeId: "default",
      config,
      mcpServers: params.mcpServers,
      activeMcpOverlay: null,
    });
    this.advertiseCommands(sessionId, params.cwd);
    return {
      sessionId,
      modes: modeState("default", guardContext()),
      configOptions: buildConfigOptions(config),
    };
  }

  /**
   * Fire-and-forget: muse skills (per workspace) become ACP slash commands.
   * Invocation is prompt passthrough — `/skill-id …` reaches muse verbatim.
   */
  private advertiseCommands(sessionId: string, cwd: string): void {
    listMuseSkills(cwd, this.options.env ?? process.env, this.options.museBinary, this.logger)
      .then((skills) => {
        const availableCommands = skillsToCommands(skills);
        if (availableCommands.length === 0) {
          return;
        }
        return this.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands },
        });
      })
      .catch((err) => this.logger.log(`skills advertisement failed: ${err}`));
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessions = listStoredSessions(
      params.cwd ?? null,
      this.options.env ?? process.env,
      this.logger,
    );
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const env = this.options.env ?? process.env;
    const stored = listStoredSessions(null, env, this.logger).find(
      (session) => session.sessionId === params.sessionId,
    );
    if (!stored) {
      throw RequestError.invalidParams(
        undefined,
        `session ${params.sessionId} not found in the muse session store`,
      );
    }

    const config = defaultSessionConfig(readMuseSettings(env, this.logger));
    this.sessions.set(params.sessionId, {
      cwd: params.cwd,
      museSessionId: params.sessionId,
      activeTurn: null,
      turnFinished: null,
      cancelRequested: false,
      modeId: "default",
      config,
      mcpServers: params.mcpServers,
      activeMcpOverlay: null,
    });

    const doc = await runMuseExport(params.sessionId, env, this.options.museBinary).catch((err) => {
      this.logger.error(`session load: export failed: ${err}`);
      throw RequestError.internalError(undefined, `could not export session history: ${err}`);
    });
    for (const notification of exportToUpdates(params.sessionId, doc, this.logger)) {
      await this.client.sessionUpdate(notification);
    }

    this.advertiseCommands(params.sessionId, params.cwd);
    return {
      modes: modeState("default", guardContext()),
      configOptions: buildConfigOptions(config),
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        undefined,
        `cwd must be an absolute path, got "${params.cwd}"`,
      );
    }
    if (params.additionalDirectories?.length) {
      throw RequestError.invalidParams(
        undefined,
        "Muse Code supports one workspace root; start a separate session for another workspace",
      );
    }

    const existing = this.sessions.get(params.sessionId);
    if (existing?.turnFinished) {
      throw RequestError.invalidRequest(
        undefined,
        `session ${params.sessionId} already has a prompt turn in flight`,
      );
    }
    // Keep validation and mutation synchronous after the busy check so a prompt
    // cannot enter while resume replaces the session's MCP server snapshot.
    const stored = existing
      ? { cwd: existing.cwd }
      : listStoredSessions(null, this.options.env ?? process.env, this.logger).find(
          (session) => session.sessionId === params.sessionId,
        );
    if (!stored) {
      throw RequestError.invalidParams(
        undefined,
        `session ${params.sessionId} not found in the muse session store`,
      );
    }
    const storedCwd = resolveResumeWorkspace(stored.cwd, true);
    const requestedCwd = resolveResumeWorkspace(params.cwd, false);
    if (requestedCwd !== storedCwd) {
      throw RequestError.invalidParams(
        undefined,
        `session ${params.sessionId} belongs to ${stored.cwd}; ` +
          "resume from that directory or start a new session",
      );
    }

    const mcpServers = params.mcpServers ?? [];
    if (existing) {
      existing.mcpServers = mcpServers;
      return {
        modes: modeState(existing.modeId, guardContext()),
        configOptions: buildConfigOptions(existing.config),
      };
    }

    const config = defaultSessionConfig(
      readMuseSettings(this.options.env ?? process.env, this.logger),
    );
    this.sessions.set(params.sessionId, {
      cwd: storedCwd,
      museSessionId: params.sessionId,
      activeTurn: null,
      turnFinished: null,
      cancelRequested: false,
      modeId: "default",
      config,
      mcpServers,
      activeMcpOverlay: null,
    });
    this.advertiseCommands(params.sessionId, storedCwd);
    return {
      modes: modeState("default", guardContext()),
      configOptions: buildConfigOptions(config),
    };
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    session.config = applyConfigSelection(session.config, params.configId, params.value);
    return { configOptions: buildConfigOptions(session.config) };
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
    if (session.turnFinished) {
      throw RequestError.invalidRequest(
        undefined,
        `session ${params.sessionId} already has a prompt turn in flight`,
      );
    }

    const { promise: turnFinished, resolve: finishTurn } = Promise.withResolvers<void>();
    session.turnFinished = turnFinished;
    session.cancelRequested = false;
    const baseEnv = this.options.env ?? process.env;
    let compiledPrompt: CompiledMusePrompt | undefined;
    let mcpOverlay: MuseMcpOverlay | null = null;
    try {
      compiledPrompt = await compileMusePrompt(params.prompt);
      if (session.cancelRequested) {
        return { stopReason: "cancelled" };
      }
      mcpOverlay =
        session.mcpServers.length > 0 ? createMuseMcpOverlay(session.mcpServers, baseEnv) : null;
      session.activeMcpOverlay = mcpOverlay;
      const translator = new TurnTranslator(params.sessionId, this.logger);
      const handle = spawnMuseExec({
        prompt: compiledPrompt.prompt,
        imagePaths: compiledPrompt.imagePaths,
        sessionId: session.museSessionId,
        cwd: session.cwd,
        museBinary: this.options.museBinary,
        provider: this.options.provider,
        // Model/effort flags only apply to the real provider; muse rejects or
        // ignores them for echo, so tests with the echo provider skip them.
        ...(this.options.provider === "echo"
          ? {}
          : { model: session.config.model, reasoningEffort: session.config.reasoningEffort }),
        env: mcpOverlay?.env ?? this.options.env,
        extraArgs: MODES[session.modeId].flags,
        logger: this.logger,
      });
      session.activeTurn = handle;
      for await (const envelope of handle.events) {
        for (const notification of translator.toUpdates(envelope)) {
          await this.client.sessionUpdate(notification);
        }
        if (translator.approvalWait !== null) {
          handle.kill();
          break;
        }
      }
      const outcome = await handle.done;
      if (translator.approvalWait !== null) {
        throw RequestError.internalError(
          undefined,
          `muse requested approval for ${translator.approvalWait.toolName}, but muse 0.2.1 cannot route headless approvals through ACP; select bypassApprovals or readOnly before prompting`,
        );
      }
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
      try {
        await cleanupPromptArtifacts(mcpOverlay, compiledPrompt);
        if (session.activeMcpOverlay === mcpOverlay) {
          session.activeMcpOverlay = null;
        }
      } finally {
        session.turnFinished = null;
        finishTurn();
      }
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

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.requireSession(params.sessionId);
    const turnFinished = session.turnFinished;
    session.cancelRequested = true;
    session.activeTurn?.kill();
    // Deletion revokes admission before the close waits for the active turn to unwind.
    this.sessions.delete(params.sessionId);
    await turnFinished;
    return {};
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
      session.activeMcpOverlay?.cleanup();
      session.activeMcpOverlay = null;
    }
  }
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
    .onRequest(methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
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
