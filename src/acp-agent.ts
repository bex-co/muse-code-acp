import {
  OUTPUT_EXTENSION,
  OUTPUT_METHOD,
  MAX_OUTPUT_READ,
  supportsStoredOutput,
  parseOutputRequest,
  restoredOutputUpdates,
} from "./stored-output.js";
import {
  COMPAT_STEER_METHOD,
  supportsCompatibleSteering,
  parseCompatibleSteering,
} from "./steering-protocol.js";
import { applySessionTitle, applyTitleUpdate, renameSession } from "./session-title.js";
import { ASYNC_TASKS, TASK_METHOD, parseTaskRequest, restoredTaskUpdates } from "./async-tasks.js";
import { observedFailure, type FailureObservation } from "./turn-failure.js";
import { SessionProgress, USAGE_EXTENSION, type ProgressFacts } from "./session-progress.js";
import { requireAvailable, requireSingleWorkspace, unavailable } from "./availability.js";
import {
  agent as acpAgent,
  AgentContext,
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
  PROTOCOL_VERSION,
  RequestError,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionInfo,
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
  RECOMMENDATION_EXTENSION,
  parseClientProvider,
  providerBinding,
  type ClientProvider,
} from "./client-provider.js";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import {
  credentialsConfigured,
  credentialStatus,
  AUTH_EXTENSION,
  META_API_KEY_METHOD_ID,
  MUSE_LOGIN_METHOD_ID,
  museAuthMethods,
  runMuseLogout,
} from "./auth.js";
import { configRecommendations } from "./config-recommendations.js";
import {
  applyConfigSelection,
  buildConfigOptions,
  defaultSessionConfig,
  resolvedModel,
  SessionConfig,
} from "./config-options.js";
import {
  supportsFileReport,
  fileReportRequest,
  FILE_REPORT_CAPABILITIES,
} from "./file-change-evidence.js";
import { forkMuseSession, FORK_METADATA } from "./session-fork.js";
import {
  DEFAULT_SAFETY,
  assertSafetyGuard,
  isSafetyConfig,
  selectSafety,
  safetyConfigOptions,
} from "./safety-settings.js";
import { probeSdkHost, assertSdkSafetySupport } from "./muse-host.js";
import { Logger } from "./logger.js";
import { museHostIdentity } from "./host-identity.js";
import { sdkDeadline } from "./sdk-operation.js";
import {
  MuseModelDiscovery,
  readModelCatalog,
  type ModelDiscoveryResult,
} from "./model-discovery.js";
import { guardContext, modeAvailability, MODES, modeState, MuseModeId } from "./modes.js";
import { MuseExecHandle, spawnMuseExec } from "./muse-exec.js";
import { MuseSdkHandle, spawnMuseSdkTurn, readMuseSdkSession, MuseSdkHost } from "./muse-sdk.js";
import {
  readSessionPreferences,
  writeSessionPreferences,
  writeSessionEffort,
  writeSessionMode,
} from "./session-preferences.js";
import {
  createMuseMcpOverlay,
  MuseMcpOverlay,
  museMcpServers,
  readConfiguredMcpServers,
} from "./mcp-overlay.js";
import { mcpStatus, mcpStartupFailure } from "./mcp-status.js";
import { SESSION_STATE_EXTENSION } from "./session-state-observer.js";
import { BUILTIN_COMMANDS, parseSlashCommand } from "./slash-commands.js";
import { buildReviewPrompt } from "./review-prompt.js";
import type { GoalObservation } from "./goal-state.js";
import { readMuseSettings } from "./muse-settings.js";
import { compileMusePrompt, type CompiledMusePrompt } from "./prompt-files.js";
import { convertPromptContent } from "./prompt-content.js";
import { exportToUpdates, runMuseExport } from "./session-export.js";
import { discoverSessions, sessionInfoNotification } from "./session-discovery.js";
import { listStoredSessions } from "./session-store.js";
import { listMuseSkills, skillsToCommands } from "./skills.js";
import { sdkHostConfiguration } from "./host-configuration.js";
import { SteeringQueue } from "./steering-queue.js";
import {
  parseSteeringRequest,
  STEER_METHOD,
  STEERING_CAPABILITY,
  supportsSteering,
} from "./steering-protocol.js";
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
  authObservation?: "unknown" | "acceptedForTurn" | "rejected";
  latestFailure?: FailureObservation | null;
  /** Working directory every Muse turn for this session runs in. */
  cwd: string;
  /** The Muse session id; minted by us and identical to the ACP session id. */
  museSessionId: string;
  /** Live CLI or SDK turn, including its owned Muse child process. */
  activeTurn: MuseExecHandle | MuseSdkHandle | null;
  /** Set by `session/cancel`; forces the turn to settle with `cancelled`. */
  cancelRequested: boolean;
  turnFinished: Promise<void> | null;
  safetyChanging?: boolean;
  /** Active ACP session mode; decides the safety flags of the next spawn. */
  modeId: MuseModeId;
  /** Model + reasoning effort applied to every spawn for this session. */
  config: SessionConfig;
  modelDiscovery?: ModelDiscoveryResult;
  modelRefresh?: { dispose(): Promise<void> };
  /** ACP-provided MCP servers injected into Muse for each turn. */
  mcpServers: McpServer[];
  mcpFailure?: string;
  goal?: GoalObservation;
  progress?: SessionProgress;
  /** Live per-turn Muse configuration overlay, if this session uses MCP. */
  activeMcpOverlay: MuseMcpOverlay | null;
  sdkHost?: { owner: MuseSdkHost; identity: string; overlay: MuseMcpOverlay };
  steering?: SteeringQueue<MuseSdkHandle, { turnId: string; status: string }>;
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

function resolveWorkspace(cwd: string, stored = false): string {
  if (!isAbsolute(cwd))
    throw RequestError.invalidParams(undefined, `cwd must be an absolute path, got "${cwd}"`);
  try {
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
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
  private readonly bindingSessions = new Map<string, Promise<void>>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private disposed = false;
  private readonly discoveryAbort = new AbortController();
  private disposal: Promise<void> | null = null;
  readonly backend: "exec" | "sdk";
  private readonly modelDiscovery: MuseModelDiscovery;
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

  private providerEnv(sessionId: string): Record<string, string | undefined> {
    return this.providers.get(sessionId)?.overlay.env ?? this.options.env ?? process.env;
  }

  private async prepareProvider(
    sessionId: string,
    meta?: Record<string, unknown> | null,
  ): Promise<void> {
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
    const config = defaultSessionConfig(readMuseSettings(env, this.logger));
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

  private authStatus(sessionId?: string) {
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

  private async publishAuth(sessionId: string, session: SessionState): Promise<void> {
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

  private progressFor(sessionId: string, session: SessionState): SessionProgress {
    return (session.progress ??= new SessionProgress(
      sessionId,
      this.clientCapabilities._meta?.[USAGE_EXTENSION] === 1,
      async (notification) => {
        if (!this.disposed && this.sessions.get(sessionId) === session && !session.cancelRequested)
          await this.client.sessionUpdate(notification);
      },
    ));
  }

  private safetyGuard() {
    return { ...guardContext(), env: this.options.env ?? process.env };
  }

  private validateSafety(config: SessionConfig, mode: MuseModeId): void {
    requireAvailable(modeAvailability(mode, this.safetyGuard(), this.backend));
    assertSafetyGuard(config.safety ?? DEFAULT_SAFETY, this.safetyGuard());
    if (!this.options.skipSdkHostCheck)
      assertSdkSafetySupport(config.safety, this.options.env, this.options.museBinary);
  }

  private sessionModes(current: MuseModeId) {
    return modeState(current, this.safetyGuard(), this.backend);
  }

  private sessionConfigOptions(
    session: Pick<SessionState, "config" | "modeId" | "modelDiscovery">,
  ) {
    const modes = this.sessionModes(session.modeId);
    const hostVersion = this.options.skipSdkHostCheck
      ? null
      : probeSdkHost(this.options.env, this.options.museBinary).version;
    const options = [
      {
        id: "mode",
        name: "Mode",
        category: "mode" as const,
        type: "select" as const,
        currentValue: modes.currentModeId,
        options: modes.availableModes.map(({ id, name, description }) => ({
          value: id,
          name,
          description,
        })),
      },
      ...buildConfigOptions(session.config, this.backend, session.modelDiscovery, hostVersion),
      ...(this.backend === "sdk"
        ? safetyConfigOptions(session.config.safety, this.safetyGuard(), hostVersion)
        : []),
    ];
    if (this.backend !== "sdk" || this.clientCapabilities._meta?.[RECOMMENDATION_EXTENSION] !== 1)
      return options;
    return configRecommendations(options, session.modelDiscovery, hostVersion);
  }

  private supportsFork(): boolean {
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
    const authMethods = museAuthMethods({
      includeTerminal: this.clientCapabilities.auth?.terminal === true,
    });
    const forkSupported = this.supportsFork();
    return {
      protocolVersion: PROTOCOL_VERSION,
      // Only advertise what is actually implemented; capabilities grow with
      // the milestones that ship them. Images work on both backends.
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: this.backend === "sdk" ? { http: true } : {},
        loadSession: true,
        sessionCapabilities: {
          list: {},
          close: {},
          resume: {},
          ...(forkSupported ? { fork: {} } : {}),
        },
        auth: { logout: {} },
      },
      authMethods,
      agentInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
      _meta: {
        ...(this.backend === "sdk" &&
        this.clientCapabilities._meta?.[OUTPUT_EXTENSION] === 1 &&
        supportsStoredOutput(probeSdkHost(this.options.env, this.options.museBinary).version)
          ? {
              [OUTPUT_EXTENSION]: {
                version: 1,
                method: OUTPUT_METHOD,
                maxLengthBytes: MAX_OUTPUT_READ,
              },
            }
          : {}),
        ...(this.backend === "sdk" && supportsCompatibleSteering(this.clientCapabilities)
          ? { steering: { supported: true, idle: "reject", targeting: "active-at-admission" } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.[ASYNC_TASKS] === 1
          ? { [ASYNC_TASKS]: { version: 1, method: TASK_METHOD, actionsPerTask: true } }
          : {}),
        ...(this.clientCapabilities._meta?.[AUTH_EXTENSION] === 1
          ? { [AUTH_EXTENSION]: { version: 1, ...this.authStatus() } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.[PROVIDER_EXTENSION] === 1
          ? {
              [PROVIDER_EXTENSION]: {
                version: 1,
                providerIds: ["meta"],
                credentials: "session-only",
                endpointChanges: "new-session",
              },
            }
          : {}),
        ...(this.backend === "sdk" &&
        this.clientCapabilities._meta?.[RECOMMENDATION_EXTENSION] === 1
          ? { [RECOMMENDATION_EXTENSION]: { version: 1 } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.[SESSION_STATE_EXTENSION] === 1
          ? { [SESSION_STATE_EXTENSION]: { version: 1, reportingOnly: true } }
          : {}),
        ...(this.backend === "sdk" && supportsFileReport(this.clientCapabilities)
          ? FILE_REPORT_CAPABILITIES
          : {}),
        ...(forkSupported && this.clientCapabilities._meta?.[FORK_METADATA] === 1
          ? { [FORK_METADATA]: { version: 1, completedTurnBoundary: true } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.["muse/review"] === 1
          ? { "muse/review": { version: 1 } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.["muse/approval"] === 1
          ? { "muse/approval": { version: 1 } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.["muse/goal"] === 1
          ? { "muse/goal": { version: 1, observation: true, controls: [] } }
          : {}),
        ...(this.backend === "sdk" && supportsSteering(this.clientCapabilities)
          ? { [STEERING_CAPABILITY]: { version: 1, method: STEER_METHOD } }
          : {}),
        ...(this.backend === "sdk" && this.clientCapabilities._meta?.[USAGE_EXTENSION] === 1
          ? { [USAGE_EXTENSION]: { version: 1, scope: "rootSession", cumulative: true } }
          : {}),
        "bex.security/capabilities": {
          delegatedWorkers: false,
          usage: this.backend === "sdk" ? "observed" : "unavailable",
          interactivePermissions: this.backend === "sdk",
        },
      },
    };
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

  private validateMcp(servers: McpServer[]): void {
    if (this.backend === "exec" && servers.some((server) => !("command" in server)))
      throw RequestError.invalidParams(undefined, "Remote MCP requires the SDK backend");
    try {
      museMcpServers(servers);
    } catch {
      throw RequestError.invalidParams(undefined, "Invalid or unsupported MCP configuration");
    }
  }

  private async publishGoal(
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

  private async inspectGoal(sessionId: string, session: SessionState): Promise<string> {
    if (!session.goal || session.goal.status === "unknown") {
      let goal: GoalObservation;
      try {
        const saved = await this.readSavedSession({
          sessionId: session.museSessionId,
          cwd: session.cwd,
          env: this.options.env ?? process.env,
          museBinary: this.options.museBinary,
          logger: this.logger,
          checkHost: !this.options.skipSdkHostCheck,
          readGoal: true,
          allowActive: true,
        });
        goal = saved.goal ?? { status: "unknown", reason: "No goal observation available" };
      } catch {
        goal = { status: "unknown", reason: "Goal history could not be read" };
      }
      if (!session.cancelRequested) await this.publishGoal(sessionId, session, goal);
    }
    const observed = session.goal;
    if (!observed || observed.status === "unknown")
      return "Goal state is unknown; available history did not establish a current goal.";
    if (!observed.goal) return "No recorded goal.";
    const goal = observed.goal;
    return [
      `Goal: ${goal.objective}`,
      `Status: ${goal.status}`,
      `Reported progress: ${goal.percentComplete}%`,
      ...(goal.currentWork !== undefined ? [`Current work: ${goal.currentWork}`] : []),
      ...(goal.nextWork !== undefined ? [`Next work: ${goal.nextWork}`] : []),
      "Last observed Muse state. Goal controls are unavailable through this adapter.",
    ].join("\n");
  }

  private catalogIdentity(session: SessionState, env: Record<string, string | undefined>): string {
    return museHostIdentity(session.cwd, env, this.options.museBinary, true).identity;
  }

  private async publishCatalog(
    sessionId: string,
    session: SessionState,
    identity: string,
    result: ModelDiscoveryResult,
    cache = true,
  ): Promise<boolean> {
    if (this.disposed || session.cancelRequested || this.sessions.get(sessionId) !== session)
      return false;
    const env = this.providerEnv(sessionId);
    try {
      if (this.catalogIdentity(session, env) !== identity) return false;
    } catch {
      return false;
    }
    if (cache) this.modelDiscovery.remember(session.cwd, env, result);
    const previous = this.sessionConfigOptions(session);
    session.modelDiscovery = result;
    const configOptions = this.sessionConfigOptions(session);
    if (JSON.stringify(previous) === JSON.stringify(configOptions)) return true;
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions,
      },
    });
    return true;
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
      const config = defaultSessionConfig(
        readMuseSettings(this.providerEnv(sessionId), this.logger),
      );
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
        mcpServers: params.mcpServers,
        activeMcpOverlay: null,
      });
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
  private advertiseCommands(sessionId: string, cwd: string): void {
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

  private trackRead<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.then(
      () => {},
      () => {},
    );
    this.backgroundTasks.add(tracked);
    void tracked.finally(() => this.backgroundTasks.delete(tracked));
    return operation;
  }

  private readSavedSession(options: Parameters<typeof readMuseSdkSession>[0]) {
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
    return this.withSessionBinding(params.sessionId, () => this.loadSessionState(params));
  }

  private async withSessionBinding<T>(sessionId: string, bind: () => Promise<T>): Promise<T> {
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

  private async loadSessionState(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.validateMcp(params.mcpServers);
    if (this.sessions.get(params.sessionId)?.activeTurn) {
      throw RequestError.invalidRequest(
        undefined,
        "Cannot load a session while a prompt is active",
      );
    }
    let env = this.providerEnv(params.sessionId);
    const stored = listStoredSessions(null, env, this.logger).find(
      (session) => session.sessionId === params.sessionId,
    );
    if (!stored) {
      throw RequestError.invalidParams(
        undefined,
        `session ${params.sessionId} not found in the muse session store`,
      );
    }
    const cwd = resolveWorkspace(params.cwd);
    const storedCwd = resolveWorkspace(stored.cwd, true);
    if (cwd !== storedCwd)
      throw RequestError.invalidParams(
        undefined,
        `session ${params.sessionId} belongs to a different workspace`,
      );

    await this.prepareProvider(params.sessionId, params._meta);
    env = this.providerEnv(params.sessionId);
    await this.sessions.get(params.sessionId)?.sdkHost?.owner.close();
    const previousSession = this.sessions.get(params.sessionId);
    previousSession?.steering?.close();
    if (previousSession) previousSession.steering = undefined;
    this.assertRunning();
    const doc = await runMuseExport(params.sessionId, env, this.options.museBinary).catch((err) => {
      this.logger.error(`session load: export failed: ${err}`);
      throw RequestError.internalError(undefined, `could not export session history: ${err}`);
    });

    this.assertRunning();
    const config = defaultSessionConfig(readMuseSettings(env, this.logger));
    let goal: GoalObservation = { status: "unknown", reason: "No goal state observed" };
    let savedMode: MuseModeId = "default";
    let info: SessionInfo | undefined;
    let progress: ProgressFacts = {};
    let tasks: import("@muse-code/sdk").FoldedItem[] = [];
    let outputItems: import("@muse-code/sdk").FoldedItem[] = [];
    if (this.backend === "sdk") {
      const saved = await this.readSavedSession({
        sessionId: params.sessionId,
        cwd,
        env,
        museBinary: this.options.museBinary,
        logger: this.logger,
        checkHost: !this.options.skipSdkHostCheck,
        readGoal: true,
        readProgress: true,
        readTasks: true,
        readOutputReferences: this.clientCapabilities._meta?.[OUTPUT_EXTENSION] === 1,
      });
      progress = saved.progress ?? {};
      tasks = saved.tasks ?? [];
      outputItems = saved.outputItems ?? [];
      goal = saved.goal ?? goal;
      info = saved.info;
      config.model = saved.modelId ?? config.model;
      config.providerId = saved.providerId ?? config.providerId;
      const preferences = readSessionPreferences(params.sessionId, env);
      // Preserve the recorded execution selection; a native setter may have
      // changed metadata without changing the provider used for this history.
      if (preferences.modelSelection) Object.assign(config, preferences.modelSelection);
      config.reasoningEffort = preferences.reasoningEffort ?? config.reasoningEffort;
      savedMode = preferences.modeId ?? "default";
      config.safety = preferences.safety;
      this.validateSafety(config, savedMode);
    }
    const modelDiscovery =
      this.backend === "sdk"
        ? this.modelDiscovery.peek(cwd, this.providerEnv(params.sessionId))
        : undefined;
    this.assertRunning();
    this.sessions.set(params.sessionId, {
      cwd,
      museSessionId: params.sessionId,
      activeTurn: null,
      turnFinished: null,
      cancelRequested: false,
      modeId: "default",
      config,
      modelDiscovery,
      mcpServers: params.mcpServers,
      activeMcpOverlay: null,
    });
    try {
      const bound = this.sessions.get(params.sessionId)!;
      bound.modeId = savedMode;
      await this.publishGoal(params.sessionId, bound, goal);
      if (this.backend === "sdk")
        await this.progressFor(params.sessionId, bound).observe(progress, true);
      for (const update of restoredTaskUpdates(params.sessionId, tasks))
        await this.client.sessionUpdate(update);
      if (info)
        await this.client.sessionUpdate(sessionInfoNotification(info, this.clientCapabilities));
      for (const notification of exportToUpdates(params.sessionId, doc, this.logger)) {
        this.assertRunning();
        await this.client.sessionUpdate(notification);
      }
      for (const notification of restoredOutputUpdates(params.sessionId, outputItems))
        await this.client.sessionUpdate(notification);
      this.assertRunning();
    } catch (error) {
      this.sessions.delete(params.sessionId);
      throw error;
    }

    this.advertiseCommands(params.sessionId, cwd);
    return {
      modes: this.sessionModes(this.sessions.get(params.sessionId)!.modeId),
      configOptions: this.sessionConfigOptions(this.sessions.get(params.sessionId)!),
    };
  }

  async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    if (!this.supportsFork())
      throw RequestError.invalidRequest(
        undefined,
        "Session fork requires supported Muse SDK host 1.1.1+",
      );
    this.validateMcp(params.mcpServers ?? []);
    requireSingleWorkspace(params.additionalDirectories);
    const cwd = resolveWorkspace(params.cwd);
    const extension = params._meta?.[FORK_METADATA];
    let lastTurnId: string | undefined;
    if (extension !== undefined) {
      if (
        this.clientCapabilities._meta?.[FORK_METADATA] !== 1 ||
        !extension ||
        typeof extension !== "object" ||
        Array.isArray(extension) ||
        typeof (extension as { lastTurnId?: unknown }).lastTurnId !== "string" ||
        !(extension as { lastTurnId: string }).lastTurnId.trim()
      )
        throw RequestError.invalidParams(
          undefined,
          "Explicit fork boundary requires negotiated muse/fork and a lastTurnId",
        );
      lastTurnId = (extension as { lastTurnId: string }).lastTurnId;
    }
    return this.withSessionBinding(params.sessionId, async () => {
      const source = this.sessions.get(params.sessionId);
      let env = this.providerEnv(params.sessionId);
      const stored =
        source ??
        listStoredSessions(null, env, this.logger).find((s) => s.sessionId === params.sessionId);
      if (!stored || resolveWorkspace(stored.cwd, true) !== cwd)
        throw RequestError.invalidParams(
          undefined,
          "Fork source not found in the requested workspace",
        );
      await this.prepareProvider(params.sessionId, params._meta);
      env = this.providerEnv(params.sessionId);
      if (source?.sdkHost?.owner.hasActiveTurn)
        throw RequestError.invalidRequest(undefined, "Cannot fork an active Muse session");
      await source?.sdkHost?.owner.close();
      if (source) source.sdkHost = undefined;
      this.assertRunning();
      const saved = await this.readSavedSession({
        sessionId: params.sessionId,
        cwd,
        env,
        museBinary: this.options.museBinary,
        logger: this.logger,
        checkHost: !this.options.skipSdkHostCheck,
      });
      this.assertRunning();
      const preferences = readSessionPreferences(params.sessionId, env);
      const config = {
        ...(source?.config ?? defaultSessionConfig(readMuseSettings(env, this.logger))),
      };
      config.safety = undefined;
      config.model = saved.modelId ?? config.model;
      config.providerId = saved.providerId ?? config.providerId;
      config.reasoningEffort =
        source?.config.reasoningEffort ?? preferences.reasoningEffort ?? config.reasoningEffort;
      if (preferences.modelSelection) Object.assign(config, preferences.modelSelection);
      // Muse 1.1.1 constructs fork metadata from host settings. Use the same
      // isolated execution configuration as ordinary SDK turns, then verify
      // the fork's authoritative model rather than trusting an accepted setter.
      const overlay = createMuseMcpOverlay([], env, config);
      let result;
      try {
        result = await this.trackRead(
          forkMuseSession({
            signal: this.discoveryAbort.signal,
            sessionId: params.sessionId,
            cwd,
            lastTurnId,
            env: overlay.env,
            museBinary: this.options.museBinary,
            checkHost: !this.options.skipSdkHostCheck,
            logger: this.logger,
          }),
        );
      } finally {
        overlay.cleanup();
      }
      this.assertRunning();
      const sessionId = result.session.sessionId;
      if (this.sessions.has(sessionId)) throw new Error("Muse fork identity is already bound");
      const sourceProvider = this.providers.get(params.sessionId)?.provider;
      if (sourceProvider)
        await this.prepareProvider(sessionId, { [PROVIDER_EXTENSION]: sourceProvider });
      this.assertRunning();
      // A branch starts with default sandbox/approval policy, not inherited grants.
      writeSessionPreferences(
        sessionId,
        { reasoningEffort: config.reasoningEffort, modeId: "default" },
        env,
      );
      this.sessions.set(sessionId, {
        cwd,
        museSessionId: sessionId,
        activeTurn: null,
        turnFinished: null,
        cancelRequested: false,
        modeId: "default",
        config,
        modelDiscovery: source?.modelDiscovery ? structuredClone(source.modelDiscovery) : undefined,
        mcpServers: structuredClone(params.mcpServers ?? []),
        activeMcpOverlay: null,
      });
      this.advertiseCommands(sessionId, cwd);
      return {
        sessionId,
        modes: this.sessionModes("default"),
        configOptions: this.sessionConfigOptions(this.sessions.get(sessionId)!),
        ...(this.clientCapabilities._meta?.[FORK_METADATA] === 1
          ? {
              _meta: {
                [FORK_METADATA]: {
                  sourceSessionId: params.sessionId,
                  cutCursor: result.session.forkedFrom?.cutCursor,
                  explicitBoundary: result.session.forkedFrom?.cutExplicit,
                },
              },
            }
          : {}),
      };
    });
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.withSessionBinding(params.sessionId, () => this.resumeSessionState(params));
  }

  private async resumeSessionState(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.validateMcp(params.mcpServers ?? []);
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        undefined,
        `cwd must be an absolute path, got "${params.cwd}"`,
      );
    }
    requireSingleWorkspace(params.additionalDirectories);

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
    const storedCwd = resolveWorkspace(stored.cwd, true);
    const requestedCwd = resolveWorkspace(params.cwd, false);
    if (requestedCwd !== storedCwd) {
      throw RequestError.invalidParams(
        undefined,
        `session ${params.sessionId} belongs to ${stored.cwd}; ` +
          "resume from that directory or start a new session",
      );
    }

    await this.prepareProvider(params.sessionId, params._meta);
    const mcpServers = params.mcpServers ?? [];
    if (existing) {
      if (params._meta?.[PROVIDER_EXTENSION] !== undefined)
        existing.modelDiscovery = this.modelDiscovery.peek(
          storedCwd,
          this.providerEnv(params.sessionId),
        );
      existing.cwd = storedCwd;
      existing.mcpServers = mcpServers;
      existing.mcpFailure = undefined;
      return {
        modes: this.sessionModes(existing.modeId),
        configOptions: this.sessionConfigOptions(existing),
      };
    }

    const config = defaultSessionConfig(
      readMuseSettings(this.options.env ?? process.env, this.logger),
    );
    let goal: GoalObservation = { status: "unknown", reason: "No goal state observed" };
    let savedMode: MuseModeId = "default";
    let info: SessionInfo | undefined;
    let progress: ProgressFacts = {};
    if (this.backend === "sdk") {
      const env = this.providerEnv(params.sessionId);
      const saved = await this.readSavedSession({
        sessionId: params.sessionId,
        cwd: storedCwd,
        env,
        museBinary: this.options.museBinary,
        logger: this.logger,
        checkHost: !this.options.skipSdkHostCheck,
        readGoal: true,
        readProgress: true,
      });
      progress = saved.progress ?? {};
      goal = saved.goal ?? goal;
      info = saved.info;
      config.model = saved.modelId ?? config.model;
      config.providerId = saved.providerId ?? config.providerId;
      const preferences = readSessionPreferences(params.sessionId, env);
      // Preserve the recorded execution selection; a native setter may have
      // changed metadata without changing the provider used for this history.
      if (preferences.modelSelection) Object.assign(config, preferences.modelSelection);
      config.reasoningEffort = preferences.reasoningEffort ?? config.reasoningEffort;
      savedMode = preferences.modeId ?? "default";
      config.safety = preferences.safety;
      this.validateSafety(config, savedMode);
    }
    const modelDiscovery =
      this.backend === "sdk"
        ? this.modelDiscovery.peek(storedCwd, this.providerEnv(params.sessionId))
        : undefined;
    this.assertRunning();
    this.sessions.set(params.sessionId, {
      cwd: storedCwd,
      museSessionId: params.sessionId,
      activeTurn: null,
      turnFinished: null,
      cancelRequested: false,
      modeId: "default",
      config,
      modelDiscovery,
      mcpServers,
      activeMcpOverlay: null,
    });
    try {
      const bound = this.sessions.get(params.sessionId)!;
      bound.modeId = savedMode;
      await this.publishGoal(params.sessionId, bound, goal);
      if (this.backend === "sdk")
        await this.progressFor(params.sessionId, bound).observe(progress, true);
      if (info)
        await this.client.sessionUpdate(sessionInfoNotification(info, this.clientCapabilities));
    } catch (error) {
      this.sessions.delete(params.sessionId);
      throw error;
    }
    this.advertiseCommands(params.sessionId, storedCwd);
    return {
      modes: this.sessionModes(this.sessions.get(params.sessionId)!.modeId),
      configOptions: this.sessionConfigOptions(this.sessions.get(params.sessionId)!),
    };
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    if (
      this.backend === "sdk" &&
      (session.safetyChanging || session.turnFinished || session.sdkHost?.owner.hasActiveTurn)
    )
      requireAvailable(
        unavailable(
          "busy",
          "Wait for the active turn or configuration change before changing settings",
        ),
      );
    if (params.configId === "mode") {
      if (typeof params.value !== "string")
        throw RequestError.invalidParams(undefined, "mode expects a select value");
      await this.setSessionMode({ sessionId: params.sessionId, modeId: params.value });
      return { configOptions: this.sessionConfigOptions(session) };
    }
    if (this.backend === "sdk" && isSafetyConfig(params.configId)) {
      if (session.safetyChanging || session.turnFinished || session.sdkHost?.owner.hasActiveTurn)
        throw RequestError.invalidRequest(
          undefined,
          "Wait for the active turn before changing safety settings",
        );
      const safety = selectSafety(
        session.config.safety,
        params.configId,
        params.value,
        this.safetyGuard(),
      );
      this.validateSafety({ ...session.config, safety }, session.modeId);
      if (JSON.stringify(safety) === JSON.stringify(session.config.safety ?? DEFAULT_SAFETY))
        return { configOptions: this.sessionConfigOptions(session) };
      session.safetyChanging = true;
      try {
        writeSessionPreferences(params.sessionId, { safety }, this.options.env ?? process.env);
        if (session.sdkHost) {
          await session.sdkHost.owner.close();
          session.sdkHost = undefined;
        }
        session.config = { ...session.config, safety };
        const configOptions = this.sessionConfigOptions(session);
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions },
        });
        return { configOptions };
      } finally {
        session.safetyChanging = false;
      }
    }
    const config = applyConfigSelection(
      session.config,
      params.configId,
      params.value,
      this.backend === "sdk" ? session.modelDiscovery : undefined,
    );
    if (this.backend === "sdk" && params.configId === "model") {
      const provider =
        readMuseSettings(this.providerEnv(params.sessionId), this.logger).provider ?? "meta";
      if (
        JSON.stringify(resolvedModel(config, session.modelDiscovery, provider)) ===
        JSON.stringify(resolvedModel(session.config, session.modelDiscovery, provider))
      )
        return { configOptions: this.sessionConfigOptions(session) };
    }
    const boundProvider = this.providers.get(params.sessionId)?.provider;
    if (boundProvider && config.providerId && config.providerId !== boundProvider.providerId)
      throw RequestError.invalidParams(
        undefined,
        "The selected model belongs to another provider; choose a model for this session's configured gateway",
      );
    if (JSON.stringify(config) === JSON.stringify(session.config))
      return { configOptions: this.sessionConfigOptions(session) };
    session.safetyChanging = true;
    try {
      if (this.backend === "sdk" && params.configId === "model" && session.sdkHost) {
        await session.sdkHost.owner.close();
        session.sdkHost = undefined;
      }
      if (this.backend === "sdk" && params.configId === "reasoningEffort")
        writeSessionEffort(
          params.sessionId,
          config.reasoningEffort,
          this.options.env ?? process.env,
        );
      session.config = config;
      const configOptions = this.sessionConfigOptions(session);
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions },
      });
      return { configOptions };
    } finally {
      session.safetyChanging = false;
    }
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    requireAvailable(modeAvailability(params.modeId, this.safetyGuard(), this.backend));
    if (
      (this.backend === "sdk" || params.modeId === "plan" || session.modeId === "plan") &&
      (session.safetyChanging || session.turnFinished || session.sdkHost?.owner.hasActiveTurn)
    )
      throw RequestError.invalidRequest(
        undefined,
        "Wait for the active turn before changing safety or planning mode",
      );
    if (session.modeId !== params.modeId)
      await this.changeMode(params.sessionId, session, params.modeId as MuseModeId);
    return {};
  }

  private assertWorkflowTools(session: SessionState): void {
    if (
      session.mcpServers.length ||
      Object.keys(readConfiguredMcpServers(this.options.env ?? process.env)).length
    )
      throw RequestError.invalidParams(
        undefined,
        "Planning and review require a session without MCP servers; read-only workspace flags do not constrain external tool effects",
      );
  }

  private async changeMode(
    sessionId: string,
    session: SessionState,
    mode: MuseModeId,
  ): Promise<void> {
    if (session.safetyChanging)
      throw RequestError.invalidRequest(
        undefined,
        "A safety setting change is already in progress",
      );
    session.safetyChanging = true;
    try {
      if (mode === "plan") this.assertWorkflowTools(session);
      if (this.backend === "sdk" && mode !== "yolo") {
        writeSessionMode(sessionId, mode, this.options.env ?? process.env);
        if (session.sdkHost) {
          await session.sdkHost.owner.close();
          session.sdkHost = undefined;
        }
      }
      session.modeId = mode;
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: mode },
      });
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: this.sessionConfigOptions(session),
        },
      });
    } finally {
      session.safetyChanging = false;
    }
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

    const command = this.backend === "sdk" ? parseSlashCommand(params.prompt) : undefined;
    const workflow = command?.workflow;
    if (!command?.local && (workflow || session.modeId === "plan"))
      this.assertWorkflowTools(session);
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

    if (command?.local) {
      session.safetyChanging = true;
      try {
        let text: string;
        if (command.local.kind === "rename") {
          const title = renameSession(
            params.sessionId,
            command.local.argument,
            this.options.env ?? process.env,
          );
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "session_info_update",
              title: title.text,
              updatedAt: title.updatedAt,
            },
          });
          text = `Session title saved by this adapter: ${title.text}`;
        } else if (command.local.kind === "models") {
          session.cancelRequested = false;
          const env = this.providerEnv(params.sessionId);
          const identity = this.catalogIdentity(session, env);
          // An explicit refresh can wait for startup; ordinary session creation never does.
          const discovery = new MuseModelDiscovery({
            env,
            museBinary: this.options.museBinary,
            logger: this.logger,
            timeoutMs: sdkDeadline(env, "STARTUP"),
          });
          const abort = new AbortController();
          session.modelRefresh = {
            dispose: async () => {
              abort.abort();
              await discovery.dispose();
            },
          };
          try {
            const connection = session.sdkHost?.owner.catalogConnection;
            const result = await this.trackRead(
              connection
                ? readModelCatalog(connection, abort.signal)
                : discovery.discover(session.cwd),
            );
            const published = await this.publishCatalog(
              params.sessionId,
              session,
              identity,
              result,
              !connection,
            );
            if (session.cancelRequested) return { stopReason: "cancelled" };
            text = !published
              ? "Configuration changed during refresh. Run /models again for the current choices."
              : result.status === "available"
                ? `Model choices refreshed (${result.models.length} reported). Select a model in session settings.`
                : `Model choices could not be refreshed. The current selection is retained. ${result.reason}`;
          } finally {
            await discovery.dispose();
            session.modelRefresh = undefined;
          }
        } else if (command.local.kind === "skills") {
          const skills = await listMuseSkills(
            session.cwd,
            this.providerEnv(params.sessionId),
            this.options.museBinary,
            this.logger,
          );
          this.assertRunning();
          if (this.sessions.get(params.sessionId) !== session)
            throw RequestError.invalidRequest(undefined, "Session closed while listing skills");
          text =
            skills
              .slice(0, 200)
              .map((s) => `${s.id} [${s.activation}, ${s.scope}] — ${s.description.slice(0, 300)}`)
              .join("\n") || "No Muse skills were reported.";
        } else {
          await this.logout({});
          text = `Stored Muse logout completed. ${this.authStatus().configured ? "Credentials remain configured (including any exported META_API_KEY); verification is unknown." : "No credentials are configured."} Adapter sessions were closed.`;
        }
        if (
          !this.disposed &&
          (!this.sessions.has(params.sessionId) || this.sessions.get(params.sessionId) === session)
        )
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        return { stopReason: "end_turn" };
      } finally {
        session.safetyChanging = false;
      }
    }

    const finished = Promise.withResolvers<void>();
    session.turnFinished = finished.promise;
    session.cancelRequested = false;
    const reviewId = workflow?.kind === "review" ? randomUUID() : undefined;
    const publishReview = async (status: "started" | "completed" | "cancelled" | "failed") => {
      if (
        !reviewId ||
        this.clientCapabilities._meta?.["muse/review"] !== 1 ||
        this.disposed ||
        this.sessions.get(params.sessionId) !== session
      )
        return;
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            "muse/review": {
              reviewId,
              status,
              target: workflow?.kind === "review" ? workflow.target : undefined,
            },
          },
        },
      });
    };
    let compiledPrompt: CompiledMusePrompt | undefined;
    let mcpOverlay: MuseMcpOverlay | null = null;
    try {
      const say = async (text: string) => {
        if (
          session.cancelRequested ||
          this.disposed ||
          this.sessions.get(params.sessionId) !== session
        )
          return;
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${text}\n\n` },
          },
        });
      };
      if (command?.notice) await say(command.notice);
      if (command?.status) {
        const status =
          command.status === "status"
            ? `Requested model: ${session.config.model}; provider: ${session.config.providerId ?? "configured default"}; effort: ${session.config.reasoningEffort}; mode: ${session.modeId}.\n${this.progressFor(params.sessionId, session).status()}\nCredentials: ${this.authStatus(params.sessionId).configured ? "configured" : "not configured"}; verification: ${this.authStatus(params.sessionId).verification}; identity: unknown.\nLatest failure: ${session.latestFailure?.kind ?? "none observed"}.`
            : command.status === "goal"
              ? await this.inspectGoal(params.sessionId, session)
              : mcpStatus(session.mcpServers, this.options.env ?? process.env, session.mcpFailure);
        await say(status);
        if (!command.stop)
          parts.unshift({ type: "text", text: `Observed ${command.status} status:\n${status}` });
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
        await this.changeMode(params.sessionId, session, "plan");
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
      if (this.backend === "exec" && session.mcpServers.length > 0) {
        mcpOverlay = createMuseMcpOverlay(session.mcpServers, baseEnv);
        session.activeMcpOverlay = mcpOverlay;
      }
      if (this.backend === "sdk") {
        if (this.options.provider === "echo") {
          throw RequestError.invalidParams(
            undefined,
            "The SDK backend requires a configured Muse provider; use the exec backend for echo",
          );
        }
        const { providerId, profileId: discoveredProfileId } = resolvedModel(
          session.config,
          session.modelDiscovery,
          readMuseSettings(baseEnv, this.logger).provider ?? "meta",
        );
        const profileId = discoveredProfileId ?? null;
        const boundProvider = this.providers.get(params.sessionId)?.provider;
        if (boundProvider && providerId !== boundProvider.providerId)
          throw RequestError.invalidParams(
            undefined,
            "Saved model provider does not match the explicitly configured gateway; no fallback was attempted",
          );
        // Catalog updates may arrive during a turn. Retain its explicit requested route.
        session.config = { ...session.config, providerId, profileId: profileId ?? null };
        const identity = sdkHostConfiguration(
          session.cwd,
          session.config,
          `${session.modeId}:${readOnly}`,
          session.mcpServers,
          baseEnv,
          this.options.museBinary,
        );
        if (
          session.sdkHost &&
          (session.sdkHost.identity !== identity || !session.sdkHost.owner.reusable)
        ) {
          await session.sdkHost.owner.close();
          session.sdkHost = undefined;
        }
        if (session.cancelRequested || this.disposed) return { stopReason: "cancelled" };
        if (session.sdkHost?.owner.hasActiveTurn)
          throw RequestError.invalidRequest(
            undefined,
            "Muse is executing a host-owned turn; retry after it finishes or close the session to stop the host",
          );
        if (!session.sdkHost) {
          const overlay = createMuseMcpOverlay(session.mcpServers, baseEnv, session.config);
          if (
            (workflow || session.modeId === "plan") &&
            Object.keys(readConfiguredMcpServers(overlay.env)).length
          ) {
            overlay.cleanup();
            throw RequestError.invalidParams(
              undefined,
              "MCP configuration changed while preparing the planning or review host",
            );
          }
          const catalogIdentity = this.catalogIdentity(session, baseEnv);
          const owner = new MuseSdkHost({
            sessionId: session.museSessionId,
            cwd: session.cwd,
            model: session.config.model,
            providerId,
            profileId,
            readOnly,
            safety: session.config.safety,
            museBinary: this.options.museBinary,
            env: overlay.env,
            logger: this.logger,
            checkHost: !this.options.skipSdkHostCheck,
            onClose: () => overlay.cleanup(),
            onCatalogConnection: (connection) => {
              void this.trackRead(
                readModelCatalog(connection).then(async (result) => {
                  if (session.sdkHost?.owner === owner && !owner.closed)
                    await this.publishCatalog(
                      params.sessionId,
                      session,
                      catalogIdentity,
                      result,
                      false,
                    );
                }),
              ).catch(() => this.logger.log("Model catalog update could not be delivered"));
            },
            onTaskUpdate: async (notification) => {
              if (
                !this.disposed &&
                this.sessions.get(params.sessionId) === session &&
                session.sdkHost?.owner === owner
              )
                await this.client.sessionUpdate(notification);
            },
            onGoal: (goal) => this.publishGoal(params.sessionId, session, goal),
            onProgress: async (facts) => {
              if (session.sdkHost?.owner === owner)
                await this.progressFor(params.sessionId, session).observe(facts);
            },
            initialGoal: session.goal,
            ...(this.clientCapabilities._meta?.[SESSION_STATE_EXTENSION] === 1
              ? {
                  onSessionState: async (state) => {
                    if (this.disposed || this.sessions.get(params.sessionId) !== session) return;
                    await this.client.sessionUpdate({
                      sessionId: params.sessionId,
                      update: {
                        sessionUpdate: "session_info_update",
                        _meta: { [SESSION_STATE_EXTENSION]: state },
                      },
                    });
                  },
                }
              : {}),
          });
          session.sdkHost = { owner, identity, overlay };
        }
        session.activeMcpOverlay = session.sdkHost.overlay;
        await publishReview("started");
        if (session.cancelRequested || this.disposed) {
          await publishReview("cancelled");
          return { stopReason: "cancelled" };
        }
        await this.publishAuth(params.sessionId, session);
        const handle = spawnMuseSdkTurn({
          sessionId: session.museSessionId,
          cwd: session.cwd,
          input: parts,
          model: session.config.model,
          providerId,
          profileId,
          reasoningEffort: session.config.reasoningEffort,
          readOnly,
          safety: session.config.safety,
          automaticDecision: readOnly
            ? undefined
            : session.modeId === "bypassApprovals"
              ? "approve"
              : session.modeId === "rejectApprovals"
                ? "reject"
                : undefined,
          museBinary: this.options.museBinary,
          env: session.sdkHost.overlay.env,
          hostOwner: session.sdkHost.owner,
          steering: supportsSteering(this.clientCapabilities),
          logger: this.logger,
          checkHost: this.options.skipSdkHostCheck ? false : undefined,
          acpClient: this.client,
          clientCapabilities: this.clientCapabilities,
          fileReportRequestId: supportsFileReport(this.clientCapabilities)
            ? fileReportRequest(params._meta)
            : undefined,
          isCancelled: () => session.cancelRequested,
        });
        session.activeTurn = handle;
        try {
          for await (const notification of handle.updates) {
            await this.client.sessionUpdate(notification);
          }
          const response = await handle.done;
          if (response.stopReason === "end_turn" && !session.cancelRequested) {
            session.latestFailure = null;
            session.authObservation = "acceptedForTurn";
            await this.publishAuth(params.sessionId, session);
          }
          if (response.stopReason === "end_turn" && !session.cancelRequested)
            writeSessionPreferences(
              params.sessionId,
              { modelSelection: { model: session.config.model, providerId, profileId } },
              this.options.env ?? process.env,
            );
          await publishReview(
            session.cancelRequested || response.stopReason === "cancelled"
              ? "cancelled"
              : "completed",
          );
          return session.cancelRequested ? { stopReason: "cancelled" } : response;
        } catch (error) {
          if (!session.cancelRequested) {
            session.latestFailure = observedFailure(error) ?? null;
            if (session.latestFailure?.kind === "authRequired")
              session.authObservation = "rejected";
            await this.publishAuth(params.sessionId, session);
          }
          session.mcpFailure = mcpStartupFailure(error);
          await session.sdkHost?.owner.close();
          await publishReview(session.cancelRequested ? "cancelled" : "failed");
          throw error;
        } finally {
          handle.kill();
          await handle.done.catch(() => {});
        }
      }
      compiledPrompt = await compileMusePrompt(params.prompt);
      if (session.cancelRequested) return { stopReason: "cancelled" };
      const translator = new TurnTranslator(params.sessionId);
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

  async controlTask({ sessionId, target }: ReturnType<typeof parseTaskRequest>) {
    this.assertRunning();
    if (this.backend !== "sdk" || this.clientCapabilities._meta?.[ASYNC_TASKS] !== 1)
      throw RequestError.invalidRequest(undefined, "muse/asyncTasks must be negotiated");
    const owner = this.sessions.get(sessionId)?.sdkHost?.owner;
    if (!owner) throw RequestError.invalidRequest(undefined, "Task host is no longer available");
    return owner.controlTask(target);
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

  private assertRunning(): void {
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
