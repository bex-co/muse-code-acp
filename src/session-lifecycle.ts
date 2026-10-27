import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  RequestError,
  type ClientCapabilities,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import { restoredTaskUpdates } from "./async-tasks.js";
import { normalizeAdditionalDirectories, requireRootsSupport } from "./workspace-roots.js";
import { PROVIDER_EXTENSION, type ClientProvider } from "./client-provider.js";
import type { SessionConfig } from "./config-options.js";
import type { GoalObservation } from "./goal-state.js";
import type { Logger } from "./logger.js";
import { createMuseMcpOverlay } from "./mcp-overlay.js";
import type { MuseModelDiscovery } from "./model-discovery.js";
import type { MuseModeId } from "./modes.js";
import type { readMuseSdkSession } from "./muse-sdk.js";
import { readMuseSettings, type MuseSettings } from "./muse-settings.js";
import { sessionInfoNotification } from "./session-discovery.js";
import { exportToUpdates, runMuseExport } from "./session-export.js";
import { FORK_METADATA, forkMuseSession } from "./session-fork.js";
import { readSessionPreferences, writeSessionPreferences } from "./session-preferences.js";
import type { ProgressFacts, SessionProgress } from "./session-progress.js";
import { listStoredSessions } from "./session-store.js";
import { OUTPUT_EXTENSION, restoredOutputUpdates } from "./stored-output.js";

/** What binding a stored session (load, resume, fork) needs from the agent. */
export interface SessionLifecycleContext {
  /** ACP additional directories can reach Muse (SDK backend on 1.4.13+). */
  workspaceRootsAvailable(): boolean;
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  readonly backend: "exec" | "sdk";
  readonly clientCapabilities: ClientCapabilities;
  readonly sessions: Map<string, SessionState>;
  readonly modelDiscovery: MuseModelDiscovery;
  /** Aborted when the agent is disposed. */
  readonly discoverySignal: AbortSignal;
  assertRunning(): void;
  validateMcp(servers: McpServer[]): void;
  validateSafety(config: SessionConfig, mode: MuseModeId): void;
  supportsFork(): boolean;
  providerEnv(sessionId: string): Record<string, string | undefined>;
  boundProvider(sessionId: string): ClientProvider | undefined;
  prepareProvider(sessionId: string, meta?: Record<string, unknown> | null): Promise<void>;
  withSessionBinding<T>(sessionId: string, bind: () => Promise<T>): Promise<T>;
  readSavedSession(
    options: Parameters<typeof readMuseSdkSession>[0],
  ): ReturnType<typeof readMuseSdkSession>;
  trackRead<T>(work: Promise<T>): Promise<T>;
  defaultConfig(settings: MuseSettings): SessionConfig;
  sessionModes(current: MuseModeId): SessionModeState;
  sessionConfigOptions(
    session: Pick<SessionState, "config" | "modeId" | "modelDiscovery">,
  ): SessionConfigOption[];
  progressFor(sessionId: string, session: SessionState): SessionProgress;
  publishGoal(sessionId: string, session: SessionState, goal: GoalObservation): Promise<void>;
  advertiseCommands(sessionId: string, cwd: string): void;
}

/** Canonical existing workspace directory for a session. */
export function resolveWorkspace(cwd: string, stored = false): string {
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

/** `session/load`: binds a stored session and replays its public history. */
export async function loadSessionState(
  ctx: SessionLifecycleContext,
  params: LoadSessionRequest,
): Promise<LoadSessionResponse> {
  ctx.validateMcp(params.mcpServers);
  if (ctx.sessions.get(params.sessionId)?.activeTurn) {
    throw RequestError.invalidRequest(undefined, "Cannot load a session while a prompt is active");
  }
  let env = ctx.providerEnv(params.sessionId);
  const stored = listStoredSessions(null, env, ctx.logger).find(
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
  const additionalDirectories = normalizeAdditionalDirectories(
    params.additionalDirectories,
    cwd,
    ctx.workspaceRootsAvailable(),
  );

  await ctx.prepareProvider(params.sessionId, params._meta);
  env = ctx.providerEnv(params.sessionId);
  await ctx.sessions.get(params.sessionId)?.sdkHost?.owner.close();
  const previousSession = ctx.sessions.get(params.sessionId);
  previousSession?.steering?.close();
  if (previousSession) previousSession.steering = undefined;
  ctx.assertRunning();
  const doc = await runMuseExport(params.sessionId, env, ctx.options.museBinary).catch((err) => {
    ctx.logger.error(`session load: export failed: ${err}`);
    throw RequestError.internalError(undefined, `could not export session history: ${err}`);
  });

  ctx.assertRunning();
  const config = ctx.defaultConfig(readMuseSettings(env, ctx.logger));
  let goal: GoalObservation = { status: "unknown", reason: "No goal state observed" };
  let savedMode: MuseModeId = "default";
  let info: SessionInfo | undefined;
  let progress: ProgressFacts = {};
  let tasks: import("@muse-code/sdk").FoldedItem[] = [];
  let outputItems: import("@muse-code/sdk").FoldedItem[] = [];
  if (ctx.backend === "sdk") {
    const saved = await ctx.readSavedSession({
      sessionId: params.sessionId,
      cwd,
      env,
      museBinary: ctx.options.museBinary,
      logger: ctx.logger,
      checkHost: !ctx.options.skipSdkHostCheck,
      readGoal: true,
      readProgress: true,
      readTasks: true,
      readOutputReferences: ctx.clientCapabilities._meta?.[OUTPUT_EXTENSION] === 1,
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
    ctx.validateSafety(config, savedMode);
  }
  const modelDiscovery =
    ctx.backend === "sdk"
      ? ctx.modelDiscovery.peek(cwd, ctx.providerEnv(params.sessionId))
      : undefined;
  ctx.assertRunning();
  ctx.sessions.set(params.sessionId, {
    cwd,
    additionalDirectories,
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
    const bound = ctx.sessions.get(params.sessionId)!;
    bound.modeId = savedMode;
    await ctx.publishGoal(params.sessionId, bound, goal);
    if (ctx.backend === "sdk")
      await ctx.progressFor(params.sessionId, bound).observe(progress, true);
    if (info) await ctx.client.sessionUpdate(sessionInfoNotification(info, ctx.clientCapabilities));
    for (const notification of exportToUpdates(params.sessionId, doc, ctx.logger)) {
      ctx.assertRunning();
      await ctx.client.sessionUpdate(notification);
    }
    // Unfinished workers describe the current state, so they follow the history.
    for (const update of restoredTaskUpdates(params.sessionId, tasks))
      await ctx.client.sessionUpdate(update);
    for (const notification of restoredOutputUpdates(params.sessionId, outputItems))
      await ctx.client.sessionUpdate(notification);
    ctx.assertRunning();
  } catch (error) {
    ctx.sessions.delete(params.sessionId);
    throw error;
  }

  ctx.advertiseCommands(params.sessionId, cwd);
  return {
    modes: ctx.sessionModes(ctx.sessions.get(params.sessionId)!.modeId),
    configOptions: ctx.sessionConfigOptions(ctx.sessions.get(params.sessionId)!),
  };
}

/** `session/fork`: branches a stored session through public Muse fork support. */
export async function forkSessionState(
  ctx: SessionLifecycleContext,
  params: ForkSessionRequest,
): Promise<ForkSessionResponse> {
  if (!ctx.supportsFork())
    throw RequestError.invalidRequest(
      undefined,
      "Session fork requires supported Muse SDK host 1.1.1+",
    );
  ctx.validateMcp(params.mcpServers ?? []);
  requireRootsSupport(params.additionalDirectories, ctx.workspaceRootsAvailable());
  const cwd = resolveWorkspace(params.cwd);
  const additionalDirectories = normalizeAdditionalDirectories(
    params.additionalDirectories,
    cwd,
    ctx.workspaceRootsAvailable(),
  );
  const extension = params._meta?.[FORK_METADATA];
  let lastTurnId: string | undefined;
  if (extension !== undefined) {
    if (
      ctx.clientCapabilities._meta?.[FORK_METADATA] !== 1 ||
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
  return ctx.withSessionBinding(params.sessionId, async () => {
    const source = ctx.sessions.get(params.sessionId);
    let env = ctx.providerEnv(params.sessionId);
    const stored =
      source ??
      listStoredSessions(null, env, ctx.logger).find((s) => s.sessionId === params.sessionId);
    if (!stored || resolveWorkspace(stored.cwd, true) !== cwd)
      throw RequestError.invalidParams(
        undefined,
        "Fork source not found in the requested workspace",
      );
    await ctx.prepareProvider(params.sessionId, params._meta);
    env = ctx.providerEnv(params.sessionId);
    if (source?.sdkHost?.owner.hasActiveTurn)
      throw RequestError.invalidRequest(undefined, "Cannot fork an active Muse session");
    await source?.sdkHost?.owner.close();
    if (source) source.sdkHost = undefined;
    ctx.assertRunning();
    const saved = await ctx.readSavedSession({
      sessionId: params.sessionId,
      cwd,
      env,
      museBinary: ctx.options.museBinary,
      logger: ctx.logger,
      checkHost: !ctx.options.skipSdkHostCheck,
    });
    ctx.assertRunning();
    const preferences = readSessionPreferences(params.sessionId, env);
    const config = {
      ...(source?.config ?? ctx.defaultConfig(readMuseSettings(env, ctx.logger))),
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
      result = await ctx.trackRead(
        forkMuseSession({
          signal: ctx.discoverySignal,
          sessionId: params.sessionId,
          cwd,
          lastTurnId,
          env: overlay.env,
          museBinary: ctx.options.museBinary,
          checkHost: !ctx.options.skipSdkHostCheck,
          logger: ctx.logger,
        }),
      );
    } finally {
      overlay.cleanup();
    }
    ctx.assertRunning();
    const sessionId = result.session.sessionId;
    if (ctx.sessions.has(sessionId)) throw new Error("Muse fork identity is already bound");
    const sourceProvider = ctx.boundProvider(params.sessionId);
    if (sourceProvider)
      await ctx.prepareProvider(sessionId, { [PROVIDER_EXTENSION]: sourceProvider });
    ctx.assertRunning();
    // A branch starts with default sandbox/approval policy, not inherited grants.
    // Muse forks inherit the source's stored roots, so the fork starts with
    // the source's applied set (the goal guard compares against it).
    const sourceRoots = readSessionPreferences(params.sessionId, env).appliedRoots;
    writeSessionPreferences(
      sessionId,
      {
        reasoningEffort: config.reasoningEffort,
        modeId: "default",
        ...(sourceRoots ? { appliedRoots: sourceRoots } : {}),
      },
      env,
    );
    ctx.sessions.set(sessionId, {
      cwd,
      additionalDirectories,
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
    ctx.advertiseCommands(sessionId, cwd);
    return {
      sessionId,
      modes: ctx.sessionModes("default"),
      configOptions: ctx.sessionConfigOptions(ctx.sessions.get(sessionId)!),
      ...(ctx.clientCapabilities._meta?.[FORK_METADATA] === 1
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

/** `session/resume`: binds a stored session without replaying history. */
export async function resumeSessionState(
  ctx: SessionLifecycleContext,
  params: ResumeSessionRequest,
): Promise<ResumeSessionResponse> {
  ctx.validateMcp(params.mcpServers ?? []);
  if (!isAbsolute(params.cwd)) {
    throw RequestError.invalidParams(
      undefined,
      `cwd must be an absolute path, got "${params.cwd}"`,
    );
  }

  requireRootsSupport(params.additionalDirectories, ctx.workspaceRootsAvailable());
  const existing = ctx.sessions.get(params.sessionId);
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
    : listStoredSessions(null, ctx.options.env ?? process.env, ctx.logger).find(
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

  await ctx.prepareProvider(params.sessionId, params._meta);
  const mcpServers = params.mcpServers ?? [];
  if (existing) {
    if (params._meta?.[PROVIDER_EXTENSION] !== undefined)
      existing.modelDiscovery = ctx.modelDiscovery.peek(
        storedCwd,
        ctx.providerEnv(params.sessionId),
      );
    existing.cwd = storedCwd;
    // ACP resume carries the complete extra-root set; omitted means none.
    existing.additionalDirectories = normalizeAdditionalDirectories(
      params.additionalDirectories,
      storedCwd,
      ctx.workspaceRootsAvailable(),
    );
    existing.mcpServers = mcpServers;
    existing.mcpFailure = undefined;
    return {
      modes: ctx.sessionModes(existing.modeId),
      configOptions: ctx.sessionConfigOptions(existing),
    };
  }

  const config = ctx.defaultConfig(readMuseSettings(ctx.options.env ?? process.env, ctx.logger));
  let goal: GoalObservation = { status: "unknown", reason: "No goal state observed" };
  let savedMode: MuseModeId = "default";
  let info: SessionInfo | undefined;
  let progress: ProgressFacts = {};
  if (ctx.backend === "sdk") {
    const env = ctx.providerEnv(params.sessionId);
    const saved = await ctx.readSavedSession({
      sessionId: params.sessionId,
      cwd: storedCwd,
      env,
      museBinary: ctx.options.museBinary,
      logger: ctx.logger,
      checkHost: !ctx.options.skipSdkHostCheck,
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
    ctx.validateSafety(config, savedMode);
  }
  const modelDiscovery =
    ctx.backend === "sdk"
      ? ctx.modelDiscovery.peek(storedCwd, ctx.providerEnv(params.sessionId))
      : undefined;
  ctx.assertRunning();
  ctx.sessions.set(params.sessionId, {
    cwd: storedCwd,
    additionalDirectories: normalizeAdditionalDirectories(
      params.additionalDirectories,
      storedCwd,
      ctx.workspaceRootsAvailable(),
    ),
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
    const bound = ctx.sessions.get(params.sessionId)!;
    bound.modeId = savedMode;
    await ctx.publishGoal(params.sessionId, bound, goal);
    if (ctx.backend === "sdk")
      await ctx.progressFor(params.sessionId, bound).observe(progress, true);
    if (info) await ctx.client.sessionUpdate(sessionInfoNotification(info, ctx.clientCapabilities));
  } catch (error) {
    ctx.sessions.delete(params.sessionId);
    throw error;
  }
  ctx.advertiseCommands(params.sessionId, storedCwd);
  return {
    modes: ctx.sessionModes(ctx.sessions.get(params.sessionId)!.modeId),
    configOptions: ctx.sessionConfigOptions(ctx.sessions.get(params.sessionId)!),
  };
}
