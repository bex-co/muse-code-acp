import { OUTPUT_EXTENSION, OUTPUT_METHOD, parseOutputRequest } from "./stored-output.js";
import {
  COMPAT_STEER_METHOD,
  supportsCompatibleSteering,
  parseCompatibleSteering,
} from "./steering-protocol.js";
import { applySessionTitle, applyTitleUpdate } from "./session-title.js";
import { ASYNC_TASKS, TASK_METHOD, parseTaskRequest } from "./async-tasks.js";
import { observedFailure } from "./turn-failure.js";
import { SessionProgress, USAGE_EXTENSION } from "./session-progress.js";
import { requireAvailable, requireSingleWorkspace } from "./availability.js";
import {
  agent as acpAgent,
  AgentContext,
  type SessionConfigOption,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ForkSessionRequest,
  ForkSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
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
import {
  PROVIDER_EXTENSION,
  gatewayFromEnv,
  parseClientProvider,
  providerBinding,
  type ClientProvider,
} from "./client-provider.js";
import { randomUUID } from "node:crypto";
import {
  credentialsConfigured,
  credentialStatus,
  AUTH_EXTENSION,
  META_API_KEY_METHOD_ID,
  MUSE_LOGIN_METHOD_ID,
  runMuseLogout,
} from "./auth.js";
import {
  defaultSessionConfig,
  effortLevels,
  isReasoningEffort,
  SessionConfig,
} from "./config-options.js";
import { FORK_METADATA } from "./session-fork.js";
import { DEFAULT_SAFETY, assertSafetyGuard } from "./safety-settings.js";
import {
  probeSdkHost,
  assertSdkSafetySupport,
  execSupportsPermissionProfile,
  supportsGoalControls,
  supportsSessionCommands,
} from "./muse-host.js";
import { Logger } from "./logger.js";
import { museHostIdentity } from "./host-identity.js";
import { MuseModelDiscovery, type ModelDiscoveryResult } from "./model-discovery.js";
import { guardContext, modeAvailability, MODES, modeState, MuseModeId } from "./modes.js";
import { readMuseSdkSession } from "./muse-sdk.js";
import { readSessionPreferences, writeSessionPreferences } from "./session-preferences.js";
import { createMuseMcpOverlay, MuseMcpOverlay, museMcpServers } from "./mcp-overlay.js";
import { BUILTIN_COMMANDS, parseSlashCommand } from "./slash-commands.js";
import { buildReviewPrompt } from "./review-prompt.js";
import type { GoalObservation } from "./goal-state.js";
import { readMuseSettings, type MuseSettings } from "./muse-settings.js";
import { convertPromptContent } from "./prompt-content.js";
import { discoverSessions } from "./session-discovery.js";
import { listMuseSkills, skillsToCommands } from "./skills.js";
import { runLocalCommand } from "./local-commands.js";
import { runSdkTurn } from "./sdk-prompt-turn.js";
import { runExecTurn } from "./exec-prompt-turn.js";
import { initializeResponse } from "./agent-capabilities.js";
import { inspectGoal, statusText } from "./session-status.js";
import { publishCatalog, refreshModels } from "./catalog-publication.js";
import {
  adoptCatalogDefault,
  assertWorkflowTools,
  buildSessionConfigOptions,
  changeMode,
  setSessionConfigOption,
  setSessionMode,
} from "./session-configuration.js";
import {
  forkSessionState,
  loadSessionState,
  resolveWorkspace,
  resumeSessionState,
} from "./session-lifecycle.js";

import { SteeringQueue } from "./steering-queue.js";
import { parseSteeringRequest, STEER_METHOD, supportsSteering } from "./steering-protocol.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";

export type { Logger } from "./logger.js";
export type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";

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

type ReviewStatus = "started" | "completed" | "cancelled" | "failed";

export class MuseAcpAgent {
  readonly sessions = new Map<string, SessionState>();
  private readonly bindingSessions = new Map<string, Promise<void>>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private disposed = false;
  private readonly discoveryAbort = new AbortController();
  private disposal: Promise<void> | null = null;
  readonly backend: "exec" | "sdk";
  readonly modelDiscovery: MuseModelDiscovery;
  private readonly providers = new Map<
    string,
    { provider: ClientProvider; overlay: MuseMcpOverlay }
  >();
  /** Client capabilities from initialize; omitted keys are unsupported. */
  clientCapabilities: ClientCapabilities = {};

  constructor(
    readonly client: AcpClient,
    readonly logger: Logger = console,
    readonly options: MuseAgentOptions = {},
  ) {
    this.client = {
      sessionUpdate: (n) =>
        client.sessionUpdate(applyTitleUpdate(n, this.options.env ?? process.env)),
      requestPermission: (p) => client.requestPermission(p),
      createElicitation: (p) => client.createElicitation(p),
    };
    const backend = options.backend ?? (options.env ?? process.env).MUSE_CODE_ACP_BACKEND ?? "sdk";
    if (backend !== "exec" && backend !== "sdk") {
      throw new Error(`unknown MUSE_CODE_ACP_BACKEND: ${backend}; expected exec or sdk`);
    }
    this.backend = backend;
    this.modelDiscovery = new MuseModelDiscovery({
      env: options.env ?? process.env,
      museBinary: options.museBinary,
      logger,
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get discoverySignal(): AbortSignal {
    return this.discoveryAbort.signal;
  }

  boundProvider(sessionId: string): ClientProvider | undefined {
    return this.providers.get(sessionId)?.provider;
  }

  providerEnv(sessionId: string): Record<string, string | undefined> {
    return this.providers.get(sessionId)?.overlay.env ?? this.options.env ?? process.env;
  }

  async prepareProvider(sessionId: string, meta?: Record<string, unknown> | null): Promise<void> {
    const fromClient = meta?.[PROVIDER_EXTENSION];
    const existing = this.providers.get(sessionId);
    const env = this.options.env ?? process.env;
    // An environment gateway configures the same endpoint without the
    // extension, so plain ACP clients can route a session too. An explicit
    // client value still wins: it is per-session, the environment is not.
    const value = fromClient ?? (this.backend === "sdk" ? gatewayFromEnv(env) : undefined);
    const saved = readSessionPreferences(sessionId, env).providerBinding;
    if (value === undefined) {
      if (saved && !existing)
        throw RequestError.invalidParams(
          undefined,
          "This session requires its explicit muse/provider endpoint and credentials again; no default-provider fallback was attempted",
        );
      return;
    }
    if (
      fromClient !== undefined &&
      (this.backend !== "sdk" || this.clientCapabilities._meta?.[PROVIDER_EXTENSION] !== 1)
    )
      throw RequestError.invalidParams(
        undefined,
        "muse/provider must be negotiated for the SDK backend",
      );
    const provider = parseClientProvider(value);
    if (saved && saved !== providerBinding(provider))
      throw RequestError.invalidParams(
        undefined,
        "Saved session belongs to another provider endpoint; start a new session to change endpoints",
      );
    if (existing && JSON.stringify(existing.provider) === JSON.stringify(provider)) return;
    const state = this.sessions.get(sessionId);
    if (state?.turnFinished || state?.sdkHost?.owner.hasActiveTurn)
      throw RequestError.invalidRequest(
        undefined,
        "Wait for the active turn before replacing provider credentials",
      );
    const config = this.defaultConfig(readMuseSettings(env, this.logger));
    const overlay = createMuseMcpOverlay([], env, config, provider);
    try {
      writeSessionPreferences(sessionId, { providerBinding: providerBinding(provider) }, env);
      await state?.sdkHost?.owner.close();
      if (state) {
        state.sdkHost = undefined;
        state.authObservation = "unknown";
        state.latestFailure = null;
      }
      existing?.overlay.cleanup();
      this.providers.set(sessionId, { provider, overlay });
    } catch (error) {
      overlay.cleanup();
      throw error;
    }
  }

  authStatus(sessionId?: string) {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    return {
      ...credentialStatus(
        this.options.env ?? process.env,
        !!sessionId && this.providers.has(sessionId),
      ),
      verification: session?.authObservation ?? "unknown",
      ...(sessionId
        ? { scope: "session", latestFailure: session?.latestFailure ?? null }
        : { scope: "configuration" }),
    };
  }

  async publishAuth(sessionId: string, session: SessionState): Promise<void> {
    if (
      this.clientCapabilities._meta?.[AUTH_EXTENSION] === 1 &&
      !this.disposed &&
      this.sessions.get(sessionId) === session &&
      !session.cancelRequested
    )
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { [AUTH_EXTENSION]: this.authStatus(sessionId) },
        },
      });
  }

  progressFor(sessionId: string, session: SessionState): SessionProgress {
    return (session.progress ??= new SessionProgress(
      sessionId,
      this.clientCapabilities._meta?.[USAGE_EXTENSION] === 1,
      async (notification) => {
        if (!this.disposed && this.sessions.get(sessionId) === session && !session.cancelRequested)
          await this.client.sessionUpdate(notification);
      },
    ));
  }

  safetyGuard() {
    return { ...guardContext(), env: this.options.env ?? process.env };
  }

  validateSafety(config: SessionConfig, mode: MuseModeId): void {
    requireAvailable(modeAvailability(mode, this.safetyGuard(), this.backend));
    assertSafetyGuard(config.safety ?? DEFAULT_SAFETY, this.safetyGuard());
    if (!this.options.skipSdkHostCheck)
      assertSdkSafetySupport(config.safety, this.options.env, this.options.museBinary);
  }

  sessionModes(current: MuseModeId) {
    return modeState(current, this.safetyGuard(), this.backend);
  }

  sessionConfigOptions(
    session: Pick<SessionState, "config" | "modeId" | "modelDiscovery">,
  ): SessionConfigOption[] {
    return buildSessionConfigOptions(this, session);
  }

  supportsFork(): boolean {
    if (this.backend !== "sdk") return false;
    if (this.options.skipSdkHostCheck) return true;
    try {
      const host = probeSdkHost(this.options.env, this.options.museBinary);
      const version = host.version?.split(".").map(Number);
      return (
        host.serveHelpOk &&
        !!version &&
        (version[0] > 1 ||
          (version[0] === 1 && (version[1] > 1 || (version[1] === 1 && version[2] >= 1))))
      );
    } catch {
      return false;
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // ACP v1: if we support the requested version, echo it; otherwise return
    // our latest supported version. This adapter supports only PROTOCOL_VERSION.
    this.clientCapabilities = params.clientCapabilities ?? {};
    return initializeResponse(this.clientCapabilities, this.backend, this.options, this);
  }

  /**
   * For both methods `authenticate` checks credential configuration only: browser
   * login runs client-side (terminal method / `--cli login`), and env keys
   * are provided by the client's environment — the adapter cannot verify an account without public host evidence.
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (params.methodId !== MUSE_LOGIN_METHOD_ID && params.methodId !== META_API_KEY_METHOD_ID) {
      throw RequestError.invalidParams(undefined, `unknown auth method: ${params.methodId}`);
    }
    if (!credentialsConfigured(this.options.env ?? process.env)) {
      throw RequestError.authRequired(
        undefined,
        params.methodId === META_API_KEY_METHOD_ID
          ? "META_API_KEY is not set in the adapter environment"
          : "no stored muse credentials found — run `muse-code-acp --cli login` in a terminal",
      );
    }
    return this.clientCapabilities._meta?.[AUTH_EXTENSION] === 1
      ? { _meta: { [AUTH_EXTENSION]: this.authStatus() } }
      : {};
  }

  async logout(_params: LogoutRequest): Promise<LogoutResponse> {
    for (const sessionId of [...this.sessions.keys()]) await this.closeSession({ sessionId });
    await runMuseLogout(this.options.env ?? process.env, this.options.museBinary, this.logger);
    for (const [sessionId, session] of this.sessions) {
      session.authObservation = "unknown";
      session.latestFailure = null;
      await this.publishAuth(sessionId, session);
    }
    return this.clientCapabilities._meta?.[AUTH_EXTENSION] === 1
      ? { _meta: { [AUTH_EXTENSION]: this.authStatus() } }
      : {};
  }

  validateMcp(servers: McpServer[]): void {
    if (this.backend === "exec" && servers.some((server) => !("command" in server)))
      throw RequestError.invalidParams(undefined, "Remote MCP requires the SDK backend");
    try {
      museMcpServers(servers);
    } catch {
      throw RequestError.invalidParams(undefined, "Invalid or unsupported MCP configuration");
    }
  }

  async publishGoal(
    sessionId: string,
    session: SessionState,
    goal: GoalObservation,
  ): Promise<void> {
    if (this.backend !== "sdk" || this.disposed || this.sessions.get(sessionId) !== session) return;
    if (JSON.stringify(session.goal) === JSON.stringify(goal)) return;
    session.goal = goal;
    if (this.clientCapabilities._meta?.["muse/goal"] === 1)
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "session_info_update", _meta: { "muse/goal": goal } },
      });
  }

  /** Native recap and rename sync: SDK backend on a host verified for them. */
  sessionCommandsAvailable(): boolean {
    return (
      this.backend === "sdk" &&
      (this.options.skipSdkHostCheck ||
        supportsSessionCommands(probeSdkHost(this.options.env, this.options.museBinary).version))
    );
  }

  /** Native goal controls: SDK backend on a host verified for them. */
  goalControlsAvailable(): boolean {
    return (
      this.backend === "sdk" &&
      (this.options.skipSdkHostCheck ||
        supportsGoalControls(probeSdkHost(this.options.env, this.options.museBinary).version))
    );
  }

  refreshModels(sessionId: string, session: SessionState): Promise<string | undefined> {
    return refreshModels(this, sessionId, session);
  }

  publishCatalog(
    sessionId: string,
    session: SessionState,
    identity: string,
    result: ModelDiscoveryResult,
    cache = true,
  ): Promise<boolean> {
    return publishCatalog(this, sessionId, session, identity, result, cache);
  }

  inspectGoal(sessionId: string, session: SessionState): Promise<string> {
    return inspectGoal(this, sessionId, session);
  }

  catalogIdentity(session: SessionState, env: Record<string, string | undefined>): string {
    return museHostIdentity(session.cwd, env, this.options.museBinary, true).identity;
  }

  execArgs(modeId: MuseModeId): string[] {
    const { flags, execProfile } = MODES[modeId];
    return execProfile &&
      execSupportsPermissionProfile(this.options.env ?? process.env, this.options.museBinary)
      ? [...flags, "--permission-profile", execProfile]
      : flags;
  }

  get efforts() {
    return effortLevels(this.backend, this.options.provider);
  }

  /** Settings defaults restricted to the efforts this backend can carry. */
  defaultConfig(settings: MuseSettings): SessionConfig {
    const config = defaultSessionConfig(settings, this.efforts);
    if (
      isReasoningEffort(settings.reasoningEffort) &&
      config.reasoningEffort !== settings.reasoningEffort
    )
      this.logger.log(
        `muse settings reasoning_effort "${settings.reasoningEffort}" is not accepted by muse exec for this provider; using the default`,
      );
    return config;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    requireSingleWorkspace(params.additionalDirectories);
    this.assertRunning();
    this.validateMcp(params.mcpServers);
    const cwd = resolveWorkspace(params.cwd);
    // The ACP session id doubles as the muse `--session-id`. Muse creates its
    // on-disk session log lazily on the first turn; discovery only queries the host.
    const sessionId = this.backend === "sdk" ? createUuidV7Mint()() : randomUUID();
    return this.withSessionBinding(sessionId, async () => {
      await this.prepareProvider(sessionId, params._meta);
      const settings = readMuseSettings(this.providerEnv(sessionId), this.logger);
      const config = this.defaultConfig(settings);
      const modelDiscovery =
        this.backend === "sdk"
          ? this.modelDiscovery.peek(cwd, this.providerEnv(sessionId))
          : undefined;
      this.assertRunning();
      this.sessions.set(sessionId, {
        cwd,
        museSessionId: sessionId,
        activeTurn: null,
        turnFinished: null,
        cancelRequested: false,
        modeId: "default",
        config,
        modelDiscovery,
        builtInModel: this.backend === "sdk" && settings.model === undefined,
        mcpServers: params.mcpServers,
        activeMcpOverlay: null,
      });
      adoptCatalogDefault(this.sessions.get(sessionId)!);
      try {
        await this.publishGoal(sessionId, this.sessions.get(sessionId)!, {
          status: "known",
          goal: null,
        });
      } catch (error) {
        this.sessions.delete(sessionId);
        throw error;
      }
      this.advertiseCommands(sessionId, cwd);
      return {
        sessionId,
        modes: this.sessionModes("default"),
        configOptions: this.sessionConfigOptions(this.sessions.get(sessionId)!),
      };
    });
  }

  /**
   * Fire-and-forget: muse skills (per workspace) become ACP slash commands.
   * Invocation is prompt passthrough — `/skill-id …` reaches muse verbatim.
   */
  advertiseCommands(sessionId: string, cwd: string): void {
    const task = listMuseSkills(
      cwd,
      this.options.env ?? process.env,
      this.options.museBinary,
      this.logger,
    )
      .catch((err) => {
        this.logger.log(`skills discovery failed: ${err}`);
        return [];
      })
      .then((skills) => {
        if (this.disposed || !this.sessions.has(sessionId)) {
          return;
        }
        const builtInCommands = this.backend === "sdk" ? BUILTIN_COMMANDS : [];
        const reservedNames = new Set(builtInCommands.map((command) => command.name));
        const availableCommands = [
          ...builtInCommands,
          ...skillsToCommands(skills).filter(
            (command) => !reservedNames.has(command.name.toLowerCase()),
          ),
        ];
        if (availableCommands.length === 0) {
          return;
        }
        return this.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands },
        });
      })
      .catch((err) => this.logger.log(`skills advertisement failed: ${err}`));
    this.backgroundTasks.add(task);
    void task.finally(() => this.backgroundTasks.delete(task));
  }

  trackRead<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.then(
      () => {},
      () => {},
    );
    this.backgroundTasks.add(tracked);
    void tracked.finally(() => this.backgroundTasks.delete(tracked));
    return operation;
  }

  readSavedSession(options: Parameters<typeof readMuseSdkSession>[0]) {
    this.assertRunning();
    return this.trackRead(readMuseSdkSession({ ...options, signal: this.discoveryAbort.signal }));
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertRunning();
    const operation = discoverSessions({
      backend: this.backend,
      cwd: params.cwd,
      cursor: params.cursor,
      signal: this.discoveryAbort.signal,
      env: this.options.env ?? process.env,
      museBinary: this.options.museBinary,
      checkHost: !this.options.skipSdkHostCheck,
      logger: this.logger,
    });
    const page = await this.trackRead(operation);
    this.assertRunning();
    if (this.clientCapabilities._meta?.[FORK_METADATA] !== 1)
      for (const entry of page.sessions) delete entry._meta;
    return {
      ...page,
      sessions: page.sessions.map((info) =>
        applySessionTitle(info, this.options.env ?? process.env),
      ),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    requireSingleWorkspace(params.additionalDirectories);
    return this.withSessionBinding(params.sessionId, () => loadSessionState(this, params));
  }

  async withSessionBinding<T>(sessionId: string, bind: () => Promise<T>): Promise<T> {
    this.assertRunning();
    if (
      this.bindingSessions.has(sessionId) ||
      this.sessions.get(sessionId)?.turnFinished ||
      this.sessions.get(sessionId)?.safetyChanging ||
      this.sessions.get(sessionId)?.sdkHost?.owner.hasActiveTurn
    ) {
      throw RequestError.invalidRequest(
        undefined,
        "session has a prompt turn or binding operation in progress",
      );
    }
    const finished = Promise.withResolvers<void>();
    this.bindingSessions.set(sessionId, finished.promise);
    try {
      const result = await bind();
      this.assertRunning();
      return result;
    } finally {
      if (!this.sessions.has(sessionId)) {
        this.providers.get(sessionId)?.overlay.cleanup();
        this.providers.delete(sessionId);
      }
      this.bindingSessions.delete(sessionId);
      finished.resolve();
    }
  }

  async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return forkSessionState(this, params);
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.withSessionBinding(params.sessionId, () => resumeSessionState(this, params));
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return setSessionConfigOption(this, params);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return setSessionMode(this, params);
  }

  async compatibleSteer(
    params: ReturnType<typeof parseCompatibleSteering>,
  ): Promise<{ outcome: "injected" }> {
    if (!supportsCompatibleSteering(this.clientCapabilities))
      throw RequestError.invalidRequest(undefined, "Compatible steering was not negotiated");
    const handle = this.requireSession(params.sessionId).activeTurn;
    const expectedTurnId =
      params.expectedTurnId ??
      (handle && "activeTurnId" in handle ? handle.activeTurnId : undefined);
    if (!expectedTurnId)
      throw RequestError.invalidRequest(
        undefined,
        "No active turn; compatible steering never starts a new turn",
      );
    await this.steer({ ...params, expectedTurnId });
    return { outcome: "injected" };
  }

  async steer(
    params: ReturnType<typeof parseSteeringRequest>,
  ): Promise<{ turnId: string; status: string }> {
    if (this.backend !== "sdk" || !supportsSteering(this.clientCapabilities))
      throw RequestError.invalidRequest(
        undefined,
        "steering was not negotiated for the SDK backend",
      );
    const session = this.requireSession(params.sessionId);
    const handle = session.activeTurn;
    if (
      !handle ||
      !("steer" in handle) ||
      handle.activeTurnId !== params.expectedTurnId ||
      session.cancelRequested
    )
      throw RequestError.invalidRequest(undefined, "no matching active turn accepts steering");
    session.steering ??= new SteeringQueue({
      isCurrent: (target, id) =>
        !this.disposed &&
        this.sessions.get(params.sessionId) === session &&
        !session.cancelRequested &&
        session.activeTurn === target &&
        target.activeTurnId === id,
      dispatch: (target, id, input) => target.steer(input, id),
    });
    return session.steering.enqueue(handle, params.expectedTurnId, params.input);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.turnFinished || session.safetyChanging) {
      throw RequestError.invalidRequest(
        undefined,
        `session ${params.sessionId} already has a prompt turn in flight`,
      );
    }

    // Slash commands exist only on the SDK backend; exec sends them as prompt text.
    const command = this.backend === "sdk" ? parseSlashCommand(params.prompt) : undefined;
    const workflow = command?.workflow;
    if (!command?.local && (workflow || session.modeId === "plan"))
      assertWorkflowTools(this.options, session);
    if (workflow && session.sdkHost?.owner.hasActiveTurn)
      throw RequestError.invalidRequest(
        undefined,
        "Wait for native work before starting a planning or review command",
      );
    // Validate the original payload before command effects; blank command replacements are valid.
    const original = convertPromptContent(params.prompt);
    if (!original.ok) throw original.error;
    const converted = convertPromptContent(command?.blocks ?? params.prompt, {
      allowEmptyText: !!command,
    });
    if (!converted.ok) throw converted.error;
    const parts = converted.parts;

    if (command?.local) return runLocalCommand(this, params.sessionId, session, command.local);

    const finished = Promise.withResolvers<void>();
    session.turnFinished = finished.promise;
    session.cancelRequested = false;
    const review =
      workflow?.kind === "review" ? { reviewId: randomUUID(), target: workflow.target } : undefined;
    const publishReview = (status: ReviewStatus) =>
      this.publishReview(params.sessionId, session, review, status);
    try {
      const say = (text: string) => this.say(params.sessionId, session, text);
      if (command?.notice) await say(command.notice);
      if (command?.status) {
        const status = await statusText(this, params.sessionId, session, command.status);
        await say(status);
        if (!command.stop)
          parts.unshift({ type: "text", text: `Observed ${command.status} status:\n${status}` });
      }
      if (command?.native && !this.sessionCommandsAvailable()) {
        await say(
          "This Muse command is verified from Muse 1.4.7; this host is not supported. Nothing was changed or sent.",
        );
        return { stopReason: "end_turn" };
      }
      if (command?.goal && !this.goalControlsAvailable()) {
        await say(
          "Native goal controls are verified from Muse 1.4.6; this host is not supported. No goal was changed.",
        );
        return { stopReason: "end_turn" };
      }
      if (command?.stop || session.cancelRequested || this.disposed)
        return { stopReason: session.cancelRequested || this.disposed ? "cancelled" : "end_turn" };
      session.mcpFailure = undefined;
      const baseEnv = this.providerEnv(params.sessionId);
      if (workflow?.kind === "plan") {
        if (session.sdkHost?.owner.hasActiveTurn)
          throw RequestError.invalidRequest(
            undefined,
            "Wait for native work before entering planning mode",
          );
        await changeMode(this, params.sessionId, session, "plan");
        if (command?.barePlan) {
          await say(
            "Plan mode enabled. Send a task to begin planning; implementation requires an explicit mode change.",
          );
          return { stopReason: session.cancelRequested ? "cancelled" : "end_turn" };
        }
      }
      if (workflow?.kind === "review") {
        const snapshot = await buildReviewPrompt(session.cwd, workflow);
        const index = command!.index;
        const focus = parts[index];
        parts[index] = {
          type: "text",
          text:
            snapshot +
            (focus?.type === "text" && focus.text ? `\nReview focus:\n${focus.text}` : ""),
        };
      }
      if (session.modeId === "plan")
        parts.unshift({
          type: "text",
          text: "Planning mode: inspect and propose a plan. Do not implement changes. Only an explicit client mode change permits implementation; text instructions cannot leave planning mode.",
        });
      if (session.cancelRequested || this.disposed) return { stopReason: "cancelled" };
      const readOnly =
        session.modeId === "readOnly" || session.modeId === "plan" || workflow?.kind === "review";
      if (this.backend === "sdk")
        return await runSdkTurn(this, {
          sessionId: params.sessionId,
          session,
          meta: params._meta,
          parts,
          command,
          workflow,
          readOnly,
          baseEnv,
          say,
          publishReview,
        });
      return await runExecTurn(this, params.sessionId, session, params.prompt, baseEnv);
    } finally {
      try {
        session.activeTurn?.kill();
        await session.activeTurn?.done.catch(() => {});
      } finally {
        session.activeTurn = null;
        session.activeMcpOverlay = null;
        session.turnFinished = null;
        finished.resolve();
      }
    }
  }

  /** One agent message for the current turn, unless it was cancelled or replaced. */
  private async say(sessionId: string, session: SessionState, text: string): Promise<void> {
    if (session.cancelRequested || this.disposed || this.sessions.get(sessionId) !== session)
      return;
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${text}\n\n` },
      },
    });
  }

  /** Negotiated `muse/review` lifecycle for a review workflow turn. */
  private async publishReview(
    sessionId: string,
    session: SessionState,
    review: { reviewId: string; target: unknown } | undefined,
    status: ReviewStatus,
  ): Promise<void> {
    if (
      !review ||
      this.clientCapabilities._meta?.["muse/review"] !== 1 ||
      this.disposed ||
      this.sessions.get(sessionId) !== session
    )
      return;
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { "muse/review": { reviewId: review.reviewId, status, target: review.target } },
      },
    });
  }

  async readOutput(params: ReturnType<typeof parseOutputRequest>) {
    this.assertRunning();
    if (this.backend !== "sdk" || this.clientCapabilities._meta?.[OUTPUT_EXTENSION] !== 1)
      throw RequestError.invalidRequest(
        undefined,
        "muse/output must be negotiated on the SDK backend",
      );
    const session = this.requireSession(params.sessionId);
    const saved = await this.readSavedSession({
      sessionId: params.sessionId,
      cwd: session.cwd,
      env: this.providerEnv(params.sessionId),
      museBinary: this.options.museBinary,
      logger: this.logger,
      checkHost: !this.options.skipSdkHostCheck,
      allowActive: true,
      outputRequest: params,
    }).catch((error: unknown) => {
      if (error instanceof RequestError) {
        if (observedFailure(error)?.kind === "sessionNotFound")
          throw RequestError.invalidRequest(error.data, error.message);
        throw error;
      }
      throw RequestError.invalidRequest(
        undefined,
        "Stored output is unavailable from the public Muse host; no turn was replayed",
      );
    });
    this.assertRunning();
    if (this.sessions.get(params.sessionId) !== session)
      throw RequestError.invalidRequest(undefined, "Session closed during output read");
    return saved.output!;
  }

  async controlTask({ sessionId, target, action }: ReturnType<typeof parseTaskRequest>) {
    this.assertRunning();
    if (this.backend !== "sdk" || this.clientCapabilities._meta?.[ASYNC_TASKS] !== 1)
      throw RequestError.invalidRequest(undefined, "muse/asyncTasks must be negotiated");
    const owner = this.sessions.get(sessionId)?.sdkHost?.owner;
    if (!owner) throw RequestError.invalidRequest(undefined, "Task host is no longer available");
    return owner.controlTask(target, action);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.logger.error(`cancel for unknown session: ${params.sessionId}`);
      return;
    }
    session.cancelRequested = true;
    session.activeTurn?.kill();
    await session.modelRefresh?.dispose();
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.requireSession(params.sessionId);
    this.sessions.delete(params.sessionId);
    session.cancelRequested = true;
    session.activeTurn?.kill();
    session.steering?.close();
    const finished = Promise.withResolvers<void>();
    this.bindingSessions.set(params.sessionId, finished.promise);
    try {
      await Promise.all([
        session.turnFinished,
        session.sdkHost?.owner.close(),
        session.modelRefresh?.dispose(),
      ]);
    } finally {
      this.providers.get(params.sessionId)?.overlay.cleanup();
      this.providers.delete(params.sessionId);
      this.bindingSessions.delete(params.sessionId);
      finished.resolve();
    }
    return {};
  }

  assertRunning(): void {
    if (this.disposed) throw RequestError.invalidRequest(undefined, "agent is shutting down");
  }

  requireSession(sessionId: string): SessionState {
    this.assertRunning();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(undefined, `unknown session: ${sessionId}`);
    }
    if (this.bindingSessions.has(sessionId))
      throw RequestError.invalidRequest(undefined, "session binding operation in progress");
    return session;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.discoveryAbort.abort();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.cancelRequested = true;
      session.activeTurn?.kill();
      session.steering?.close();
    }
    this.disposal = Promise.all([
      ...sessions.map((session) => session.turnFinished),
      ...sessions.map((session) => session.sdkHost?.owner.close()),
      ...sessions.map((session) => session.modelRefresh?.dispose()),
      ...this.bindingSessions.values(),
      ...this.backgroundTasks,
      this.modelDiscovery.dispose(),
    ]).then(() => {
      for (const binding of this.providers.values()) binding.overlay.cleanup();
      this.providers.clear();
    });
    return this.disposal;
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
    .onRequest(methods.agent.session.fork, (ctx) => agent.forkSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
    .onRequest(OUTPUT_METHOD, parseOutputRequest, (ctx) => agent.readOutput(ctx.params))
    .onRequest(TASK_METHOD, parseTaskRequest, (ctx) => agent.controlTask(ctx.params))
    .onRequest(COMPAT_STEER_METHOD, parseCompatibleSteering, (ctx) =>
      agent.compatibleSteer(ctx.params),
    )
    .onRequest(STEER_METHOD, parseSteeringRequest, (ctx) => agent.steer(ctx.params))
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
