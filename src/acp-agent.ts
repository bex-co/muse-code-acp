import {
  agent as acpAgent,
  AgentContext,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  ClientApp,
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
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
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  Stream,
} from "@agentclientprotocol/sdk";
import { createUuidV7Mint } from "@muse-code/sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
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
import { MuseSdkHandle, spawnMuseSdkTurn, readMuseSdkSession } from "./muse-sdk.js";
import { readSessionEffort, writeSessionEffort } from "./session-preferences.js";
import { createMuseMcpOverlay, MuseMcpOverlay } from "./mcp-overlay.js";
import { readMuseSettings } from "./muse-settings.js";
import { compileMusePrompt, type CompiledMusePrompt } from "./prompt-files.js";
import { convertPromptContent } from "./prompt-content.js";
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
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
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

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params);
  }

  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    return this.ctx.request(methods.client.elicitation.create, params);
  }
}

export interface SessionState {
  /** Working directory every Muse turn for this session runs in. */
  cwd: string;
  /** The Muse session id; minted by us and identical to the ACP session id. */
  museSessionId: string;
  /** Live CLI or SDK turn, including its owned Muse child process. */
  activeTurn: MuseExecHandle | MuseSdkHandle | null;
  /** Set by `session/cancel`; forces the turn to settle with `cancelled`. */
  cancelRequested: boolean;
  turnFinished: Promise<void> | null;
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
  /** Opt-in SDK migration; the CLI backend remains the default. */
  backend?: "exec" | "sdk";
  museBinary?: string;
  provider?: "meta" | "echo";
  env?: Record<string, string | undefined>;
  /** Tests with fake-msp skip the real `muse serve --help` probe. */
  skipSdkHostCheck?: boolean;
}

export class MuseAcpAgent {
  readonly sessions = new Map<string, SessionState>();
  private readonly bindingSessions = new Set<string>();
  readonly backend: "exec" | "sdk";
  /** Client capabilities from initialize; omitted keys are unsupported. */
  clientCapabilities: ClientCapabilities = {};

  constructor(
    readonly client: AcpClient,
    readonly logger: Logger = console,
    readonly options: MuseAgentOptions = {},
  ) {
    const backend = options.backend ?? (options.env ?? process.env).MUSE_CODE_ACP_BACKEND ?? "sdk";
    if (backend !== "exec" && backend !== "sdk") {
      throw new Error(`unknown MUSE_CODE_ACP_BACKEND: ${backend}; expected exec or sdk`);
    }
    this.backend = backend;
  }

  private sessionModes(current: MuseModeId) {
    const state = modeState(current, guardContext(), this.backend);
    if (this.backend === "sdk") {
      state.availableModes = state.availableModes.filter(
        (mode) => mode.id === "default" || mode.id === "readOnly",
      );
    }
    return state;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // ACP v1: if we support the requested version, echo it; otherwise return
    // our latest supported version. This adapter supports only PROTOCOL_VERSION.
    this.clientCapabilities = params.clientCapabilities ?? {};
    const authMethods = museAuthMethods({
      includeTerminal: this.clientCapabilities.auth?.terminal === true,
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      // Only advertise what is actually implemented; capabilities grow with
      // the milestones that ship them. Images work on both backends.
      agentCapabilities: {
        promptCapabilities: { image: true },
        mcpCapabilities: {},
        loadSession: true,
        sessionCapabilities: { list: {}, close: {} },
        auth: { logout: {} },
      },
      authMethods,
      agentInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
      _meta: {
        "bex.security/capabilities": {
          delegatedWorkers: false,
          usage: "unavailable",
          interactivePermissions: this.backend === "sdk",
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
    const sessionId = this.backend === "sdk" ? createUuidV7Mint()() : randomUUID();
    const config = defaultSessionConfig(
      readMuseSettings(this.options.env ?? process.env, this.logger),
      this.backend,
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
      modes: this.sessionModes("default"),
      configOptions: buildConfigOptions(config, this.backend),
    };
  }

  /**
   * Fire-and-forget: muse skills (per workspace) become ACP slash commands.
   * Invocation is prompt passthrough — `/skill-id …` reaches muse verbatim.
   */
  private advertiseCommands(sessionId: string, cwd: string): void {
    listMuseSkills(cwd, this.options.env ?? process.env, this.options.museBinary, this.logger)
      .then((skills) => {
        if (!this.sessions.has(sessionId)) {
          return;
        }
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
    return this.withSessionBinding(params.sessionId, () => this.loadSessionState(params));
  }

  private async withSessionBinding<T>(sessionId: string, bind: () => Promise<T>): Promise<T> {
    if (this.bindingSessions.has(sessionId) || this.sessions.get(sessionId)?.turnFinished) {
      throw RequestError.invalidRequest(
        undefined,
        "session has a prompt turn or binding operation in progress",
      );
    }
    this.bindingSessions.add(sessionId);
    try {
      return await bind();
    } finally {
      this.bindingSessions.delete(sessionId);
    }
  }

  private async loadSessionState(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (this.sessions.get(params.sessionId)?.activeTurn) {
      throw RequestError.invalidRequest(
        undefined,
        "Cannot load a session while a prompt is active",
      );
    }
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
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        undefined,
        `cwd must be an absolute path, got "${params.cwd}"`,
      );
    }
    // Fail closed before publishing adapter state: export must succeed and the
    // stored workspace must match the client's load cwd when Muse recorded one.
    if (stored.cwd) {
      try {
        if (realpathSync(stored.cwd) !== realpathSync(params.cwd)) {
          throw RequestError.invalidParams(
            undefined,
            `session ${params.sessionId} belongs to a different workspace`,
          );
        }
      } catch (error) {
        if (error instanceof RequestError) {
          throw error;
        }
        throw RequestError.invalidParams(
          undefined,
          `session ${params.sessionId} workspace path is not usable`,
        );
      }
    }

    const doc = await runMuseExport(params.sessionId, env, this.options.museBinary).catch((err) => {
      this.logger.error(`session load: export failed: ${err}`);
      throw RequestError.internalError(undefined, `could not export session history: ${err}`);
    });

    const config = defaultSessionConfig(readMuseSettings(env, this.logger), this.backend);
    if (this.backend === "sdk") {
      const saved = await readMuseSdkSession({
        sessionId: params.sessionId,
        cwd: params.cwd,
        env,
        museBinary: this.options.museBinary,
        logger: this.logger,
        checkHost: !this.options.skipSdkHostCheck,
      });
      config.model = saved.modelId ?? config.model;
      config.reasoningEffort = readSessionEffort(params.sessionId, env) ?? config.reasoningEffort;
    }
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

    try {
      for (const notification of exportToUpdates(params.sessionId, doc, this.logger)) {
        await this.client.sessionUpdate(notification);
      }
    } catch (error) {
      this.sessions.delete(params.sessionId);
      throw error;
    }

    this.advertiseCommands(params.sessionId, params.cwd);
    return {
      modes: this.sessionModes("default"),
      configOptions: buildConfigOptions(config, this.backend),
    };
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    const config = applyConfigSelection(
      session.config,
      params.configId,
      params.value,
      this.backend,
    );
    if (this.backend === "sdk" && params.configId === "reasoningEffort") {
      writeSessionEffort(params.sessionId, config.reasoningEffort, this.options.env ?? process.env);
    }
    session.config = config;
    return { configOptions: buildConfigOptions(session.config, this.backend) };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    if (
      !isModeAvailable(params.modeId, guardContext()) ||
      !this.sessionModes(session.modeId).availableModes.some((mode) => mode.id === params.modeId)
    ) {
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

    const converted = convertPromptContent(params.prompt);
    if (!converted.ok) {
      throw converted.error;
    }

    const finished = Promise.withResolvers<void>();
    session.turnFinished = finished.promise;
    session.cancelRequested = false;
    let compiledPrompt: CompiledMusePrompt | undefined;
    let mcpOverlay: MuseMcpOverlay | null = null;
    try {
      const baseEnv = this.options.env ?? process.env;
      mcpOverlay =
        this.backend === "sdk" || session.mcpServers.length > 0
          ? createMuseMcpOverlay(
              session.mcpServers,
              baseEnv,
              this.backend === "sdk" ? session.config : undefined,
            )
          : null;
      session.activeMcpOverlay = mcpOverlay;
      if (this.backend === "sdk") {
        if (this.options.provider === "echo") {
          throw RequestError.invalidParams(
            undefined,
            "The SDK backend requires a configured Muse provider; use the exec backend for echo",
          );
        }
        const handle = spawnMuseSdkTurn({
          sessionId: session.museSessionId,
          cwd: session.cwd,
          input: converted.parts,
          model: session.config.model,
          reasoningEffort: session.config.reasoningEffort,
          readOnly: session.modeId === "readOnly",
          museBinary: this.options.museBinary,
          env: mcpOverlay?.env ?? baseEnv,
          logger: this.logger,
          checkHost: this.options.skipSdkHostCheck ? false : undefined,
          acpClient: this.client,
          clientCapabilities: this.clientCapabilities,
          isCancelled: () => session.cancelRequested,
        });
        session.activeTurn = handle;
        try {
          for await (const notification of handle.updates) {
            await this.client.sessionUpdate(notification);
          }
          const response = await handle.done;
          return session.cancelRequested ? { stopReason: "cancelled" } : response;
        } finally {
          handle.kill();
          await handle.done.catch(() => {});
        }
      }
      compiledPrompt = await compileMusePrompt(params.prompt);
      if (session.cancelRequested) return { stopReason: "cancelled" };
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
      try {
        session.activeTurn?.kill();
        await session.activeTurn?.done.catch(() => {});
        mcpOverlay?.cleanup();
      } finally {
        try {
          await compiledPrompt?.cleanup();
        } finally {
          session.activeTurn = null;
          session.activeMcpOverlay = null;
          session.turnFinished = null;
          finished.resolve();
        }
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
    this.sessions.delete(params.sessionId);
    session.cancelRequested = true;
    session.activeTurn?.kill();
    this.bindingSessions.add(params.sessionId);
    try {
      await session.turnFinished;
    } finally {
      this.bindingSessions.delete(params.sessionId);
    }
    return {};
  }

  requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(undefined, `unknown session: ${sessionId}`);
    }
    if (this.bindingSessions.has(sessionId))
      throw RequestError.invalidRequest(undefined, "session binding operation in progress");
    return session;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.cancelRequested = true;
      session.activeTurn?.kill();
    }
    await Promise.all(sessions.map((session) => session.turnFinished));
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
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
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
