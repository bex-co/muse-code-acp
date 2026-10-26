import {
  RequestError,
  type ClientCapabilities,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import { resolvedModel } from "./config-options.js";
import { fileReportRequest, supportsFileReport } from "./file-change-evidence.js";
import type { GoalObservation } from "./goal-state.js";
import { hostCommandFor } from "./host-commands.js";
import { sdkHostConfiguration } from "./host-configuration.js";
import type { Logger } from "./logger.js";
import { createMuseMcpOverlay, readConfiguredMcpServers } from "./mcp-overlay.js";
import { mcpStartupFailure } from "./mcp-status.js";
import { readModelCatalog, type ModelDiscoveryResult } from "./model-discovery.js";
import { MuseSdkHost, spawnMuseSdkTurn } from "./muse-sdk.js";
import { readMuseSettings } from "./muse-settings.js";
import type { MuseInputPart } from "./prompt-content.js";
import type { SessionProgress } from "./session-progress.js";
import { writeSessionPreferences } from "./session-preferences.js";
import { SESSION_STATE_EXTENSION } from "./session-state-observer.js";
import type { SlashCommand } from "./slash-commands.js";
import { supportsSteering } from "./steering-protocol.js";
import { observedFailure } from "./turn-failure.js";

/** What an SDK-backend prompt turn needs from the agent. */
export interface SdkTurnContext {
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  readonly clientCapabilities: ClientCapabilities;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly isDisposed: boolean;
  /** The provider an explicit client or environment gateway bound to the session. */
  boundProvider(sessionId: string): { providerId: string } | undefined;
  catalogIdentity(session: SessionState, env: Record<string, string | undefined>): string;
  trackRead<T>(work: Promise<T>): Promise<T>;
  publishCatalog(
    sessionId: string,
    session: SessionState,
    identity: string,
    result: ModelDiscoveryResult,
    cache?: boolean,
  ): Promise<boolean>;
  publishGoal(sessionId: string, session: SessionState, goal: GoalObservation): Promise<void>;
  progressFor(sessionId: string, session: SessionState): SessionProgress;
  publishAuth(sessionId: string, session: SessionState): Promise<void>;
  inspectGoal(sessionId: string, session: SessionState): Promise<string>;
}

export interface SdkTurnRequest {
  sessionId: string;
  session: SessionState;
  meta: PromptRequest["_meta"];
  parts: MuseInputPart[];
  command: SlashCommand | undefined;
  workflow: SlashCommand["workflow"];
  readOnly: boolean;
  baseEnv: Record<string, string | undefined>;
  say(text: string): Promise<void>;
  publishReview(status: "started" | "completed" | "cancelled" | "failed"): Promise<void>;
}

/**
 * Reuse the session's Muse host when its configuration still matches, or
 * create one (unopened). Shared by prompt turns and the background prewarm.
 */
export async function ensureSdkHost(
  ctx: SdkTurnContext,
  sessionId: string,
  session: SessionState,
  opts: {
    readOnly: boolean;
    workflow?: SlashCommand["workflow"];
    baseEnv: Record<string, string | undefined>;
    /** Checked after a stale host is dropped; false means cancelled. */
    beforeOpen?: () => boolean;
    /** False for a prewarm: the session's configuration is left untouched. */
    commitRoute?: boolean;
  },
): Promise<{ providerId: string; profileId: string | null; cancelled?: true }> {
  const { providerId, profileId: discoveredProfileId } = resolvedModel(
    session.config,
    session.modelDiscovery,
    readMuseSettings(opts.baseEnv, ctx.logger).provider ?? "meta",
  );
  const profileId = discoveredProfileId ?? null;
  const boundProvider = ctx.boundProvider(sessionId);
  if (boundProvider && providerId !== boundProvider.providerId)
    throw RequestError.invalidParams(
      undefined,
      "Saved model provider does not match the explicitly configured gateway; no fallback was attempted",
    );
  // Catalog updates may arrive during a turn. Retain its explicit requested
  // route; a prewarm computes the same identity without committing it.
  const routed = { ...session.config, providerId, profileId: profileId ?? null };
  if (opts.commitRoute !== false) session.config = routed;
  const identity = sdkHostConfiguration(
    session.cwd,
    routed,
    `${session.modeId}:${opts.readOnly}`,
    session.mcpServers,
    opts.baseEnv,
    ctx.options.museBinary,
  );
  if (
    session.sdkHost &&
    (session.sdkHost.identity !== identity || !session.sdkHost.owner.reusable)
  ) {
    ctx.logger.log(
      `muse-sdk: replacing host (${session.sdkHost.identity !== identity ? "configuration changed" : session.sdkHost.owner.closed ? "closed" : "busy"})`,
    );
    await session.sdkHost.owner.close();
    session.sdkHost = undefined;
  }
  if (!(opts.beforeOpen?.() ?? true)) return { providerId, profileId, cancelled: true };
  if (!session.sdkHost) {
    const overlay = createMuseMcpOverlay(session.mcpServers, opts.baseEnv, routed);
    if (
      (opts.workflow || session.modeId === "plan") &&
      Object.keys(readConfiguredMcpServers(overlay.env)).length
    ) {
      overlay.cleanup();
      throw RequestError.invalidParams(
        undefined,
        "MCP configuration changed while preparing the planning or review host",
      );
    }
    const catalogIdentity = ctx.catalogIdentity(session, opts.baseEnv);
    const owner = new MuseSdkHost({
      sessionId: session.museSessionId,
      cwd: session.cwd,
      model: routed.model,
      providerId,
      profileId,
      readOnly: opts.readOnly,
      safety: routed.safety,
      museBinary: ctx.options.museBinary,
      env: overlay.env,
      logger: ctx.logger,
      checkHost: !ctx.options.skipSdkHostCheck,
      onClose: () => overlay.cleanup(),
      onCatalogConnection: (connection) => {
        void ctx
          .trackRead(
            readModelCatalog(connection).then(async (result) => {
              if (session.sdkHost?.owner === owner && !owner.closed)
                await ctx.publishCatalog(sessionId, session, catalogIdentity, result, false);
            }),
          )
          .catch(() => ctx.logger.log("Model catalog update could not be delivered"));
      },
      onTaskUpdate: async (notification) => {
        if (
          !ctx.isDisposed &&
          ctx.sessions.get(sessionId) === session &&
          session.sdkHost?.owner === owner
        )
          await ctx.client.sessionUpdate(notification);
      },
      onGoal: (goal) => ctx.publishGoal(sessionId, session, goal),
      onProgress: async (facts) => {
        if (session.sdkHost?.owner === owner)
          await ctx.progressFor(sessionId, session).observe(facts);
      },
      initialGoal: session.goal,
      ...(ctx.clientCapabilities._meta?.[SESSION_STATE_EXTENSION] === 1
        ? {
            onSessionState: async (state) => {
              if (ctx.isDisposed || ctx.sessions.get(sessionId) !== session) return;
              await ctx.client.sessionUpdate({
                sessionId: sessionId,
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
  return { providerId, profileId };
}

/**
 * Start the session's Muse host in the background with its current settings,
 * so the first prompt does not wait for Muse's startup and the model catalog
 * arrives early. Never disturbs a host that is serving a turn.
 */
export async function prewarmSdkHost(
  ctx: SdkTurnContext,
  sessionId: string,
  session: SessionState,
  baseEnv: Record<string, string | undefined>,
): Promise<void> {
  if (ctx.options.provider === "echo" || ctx.isDisposed) return;
  if (session.activeTurn || session.turnFinished || session.safetyChanging) return;
  if (session.sdkHost && !session.sdkHost.owner.reusable) return;
  try {
    const { cancelled } = await ensureSdkHost(ctx, sessionId, session, {
      readOnly: session.modeId === "readOnly" || session.modeId === "plan",
      baseEnv,
      commitRoute: false,
      beforeOpen: () => !ctx.isDisposed && !session.activeTurn && !session.turnFinished,
    });
    if (!cancelled) session.sdkHost?.owner.prewarm();
  } catch (error) {
    ctx.logger.log(`muse-sdk: prewarm skipped: ${String(error)}`);
  }
}

/**
 * One prompt turn on the SDK backend: resolves the model route, reuses or
 * replaces the session's Muse host, streams the turn and records its outcome.
 */
export async function runSdkTurn(
  ctx: SdkTurnContext,
  req: SdkTurnRequest,
): Promise<PromptResponse> {
  const {
    sessionId,
    session,
    meta,
    parts,
    command,
    workflow,
    readOnly,
    baseEnv,
    say,
    publishReview,
  } = req;
  if (ctx.options.provider === "echo") {
    throw RequestError.invalidParams(
      undefined,
      "The SDK backend requires a configured Muse provider; use the exec backend for echo",
    );
  }
  session.builtInModel = false;
  const { providerId, profileId, cancelled } = await ensureSdkHost(ctx, sessionId, session, {
    readOnly,
    workflow,
    baseEnv,
    beforeOpen: () => {
      if (session.cancelRequested || ctx.isDisposed) return false;
      // Goal controls are how a user pauses or clears host-owned goal work.
      if (session.sdkHost?.owner.hasActiveTurn && !command?.goal)
        throw RequestError.invalidRequest(
          undefined,
          "Muse is executing a host-owned turn; retry after it finishes or close the session to stop the host",
        );
      return true;
    },
  });
  if (cancelled || !session.sdkHost) return { stopReason: "cancelled" };
  session.activeMcpOverlay = session.sdkHost.overlay;
  await publishReview("started");
  if (session.cancelRequested || ctx.isDisposed) {
    await publishReview("cancelled");
    return { stopReason: "cancelled" };
  }
  await ctx.publishAuth(sessionId, session);
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
    museBinary: ctx.options.museBinary,
    env: session.sdkHost.overlay.env,
    hostOwner: session.sdkHost.owner,
    steering: supportsSteering(ctx.clientCapabilities),
    logger: ctx.logger,
    checkHost: ctx.options.skipSdkHostCheck ? false : undefined,
    acpClient: ctx.client,
    clientCapabilities: ctx.clientCapabilities,
    fileReportRequestId: supportsFileReport(ctx.clientCapabilities)
      ? fileReportRequest(meta)
      : undefined,
    isCancelled: () => session.cancelRequested,
    goal: command?.goal,
    hostCommand: command?.native && hostCommandFor(command.native),
    nativeName: session.pendingNativeName,
    onNativeName: () => {
      session.pendingNativeName = undefined;
    },
  });
  const goalBefore = JSON.stringify(session.goal);
  session.activeTurn = handle;
  try {
    for await (const notification of handle.updates) {
      await ctx.client.sessionUpdate(notification);
    }
    const response = await handle.done;
    if (response.stopReason === "end_turn" && !session.cancelRequested) {
      session.latestFailure = null;
      session.authObservation = "acceptedForTurn";
      await ctx.publishAuth(sessionId, session);
    }
    if (response.stopReason === "end_turn" && !session.cancelRequested)
      writeSessionPreferences(
        sessionId,
        { modelSelection: { model: session.config.model, providerId, profileId } },
        ctx.options.env ?? process.env,
      );
    await publishReview(
      session.cancelRequested || response.stopReason === "cancelled" ? "cancelled" : "completed",
    );
    if (command?.goal && !session.cancelRequested) {
      // The host publishes goal changes on its 100 ms observation tick.
      for (let i = 0; i < 20 && JSON.stringify(session.goal) === goalBefore; i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      await say(
        `Goal ${command.goal.verb} accepted.\n${await ctx.inspectGoal(sessionId, session)}`,
      );
    }
    return session.cancelRequested ? { stopReason: "cancelled" } : response;
  } catch (error) {
    if (!session.cancelRequested) {
      session.latestFailure = observedFailure(error) ?? null;
      if (session.latestFailure?.kind === "authRequired") session.authObservation = "rejected";
      await ctx.publishAuth(sessionId, session);
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
