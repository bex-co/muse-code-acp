import {
  RequestError,
  type ClientCapabilities,
  type SessionConfigOption,
  type SessionModeState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import { requireAvailable, unavailable } from "./availability.js";
import { RECOMMENDATION_EXTENSION, type ClientProvider } from "./client-provider.js";
import { configRecommendations } from "./config-recommendations.js";
import {
  applyConfigSelection,
  buildConfigOptions,
  catalogDefaultModel,
  resolvedModel,
  type MuseReasoningEffort,
  type SessionConfig,
} from "./config-options.js";
import type { Logger } from "./logger.js";
import { readConfiguredMcpServers } from "./mcp-overlay.js";
import { guardContext, modeAvailability, type MuseModeId } from "./modes.js";
import { probeSdkHost } from "./muse-host.js";
import { readMuseSettings } from "./muse-settings.js";
import {
  DEFAULT_SAFETY,
  isSafetyConfig,
  safetyConfigOptions,
  selectSafety,
} from "./safety-settings.js";
import {
  writeSessionEffort,
  writeSessionMode,
  writeSessionPreferences,
} from "./session-preferences.js";

/** What changing a session's mode, model, effort or safety needs from the agent. */
export interface ConfigurationContext {
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  readonly backend: "exec" | "sdk";
  readonly efforts: readonly MuseReasoningEffort[];
  requireSession(sessionId: string): SessionState;
  providerEnv(sessionId: string): Record<string, string | undefined>;
  boundProvider(sessionId: string): ClientProvider | undefined;
  safetyGuard(): ReturnType<typeof guardContext> & { env: Record<string, string | undefined> };
  validateSafety(config: SessionConfig, mode: MuseModeId): void;
  sessionConfigOptions(
    session: Pick<SessionState, "config" | "modeId" | "modelDiscovery">,
  ): SessionConfigOption[];
}

/** `session/set_config_option`: model, effort, safety and mode selections. */
export async function setSessionConfigOption(
  ctx: ConfigurationContext,
  params: SetSessionConfigOptionRequest,
): Promise<SetSessionConfigOptionResponse> {
  const session = ctx.requireSession(params.sessionId);
  if (
    ctx.backend === "sdk" &&
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
    await setSessionMode(ctx, { sessionId: params.sessionId, modeId: params.value });
    return { configOptions: ctx.sessionConfigOptions(session) };
  }
  if (ctx.backend === "sdk" && isSafetyConfig(params.configId)) {
    if (session.safetyChanging || session.turnFinished || session.sdkHost?.owner.hasActiveTurn)
      throw RequestError.invalidRequest(
        undefined,
        "Wait for the active turn before changing safety settings",
      );
    const safety = selectSafety(
      session.config.safety,
      params.configId,
      params.value,
      ctx.safetyGuard(),
    );
    ctx.validateSafety({ ...session.config, safety }, session.modeId);
    if (JSON.stringify(safety) === JSON.stringify(session.config.safety ?? DEFAULT_SAFETY))
      return { configOptions: ctx.sessionConfigOptions(session) };
    session.safetyChanging = true;
    try {
      writeSessionPreferences(params.sessionId, { safety }, ctx.options.env ?? process.env);
      if (session.sdkHost) {
        await session.sdkHost.owner.close();
        session.sdkHost = undefined;
      }
      session.config = { ...session.config, safety };
      const configOptions = ctx.sessionConfigOptions(session);
      await ctx.client.sessionUpdate({
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
    ctx.backend === "sdk" ? session.modelDiscovery : undefined,
    ctx.efforts,
  );
  if (ctx.backend === "sdk" && params.configId === "model") {
    session.builtInModel = false;
    const provider =
      readMuseSettings(ctx.providerEnv(params.sessionId), ctx.logger).provider ?? "meta";
    if (
      JSON.stringify(resolvedModel(config, session.modelDiscovery, provider)) ===
      JSON.stringify(resolvedModel(session.config, session.modelDiscovery, provider))
    )
      return { configOptions: ctx.sessionConfigOptions(session) };
  }
  const boundProvider = ctx.boundProvider(params.sessionId);
  if (boundProvider && config.providerId && config.providerId !== boundProvider.providerId)
    throw RequestError.invalidParams(
      undefined,
      "The selected model belongs to another provider; choose a model for this session's configured gateway",
    );
  if (JSON.stringify(config) === JSON.stringify(session.config))
    return { configOptions: ctx.sessionConfigOptions(session) };
  session.safetyChanging = true;
  try {
    if (ctx.backend === "sdk" && params.configId === "model" && session.sdkHost) {
      await session.sdkHost.owner.close();
      session.sdkHost = undefined;
    }
    if (ctx.backend === "sdk" && params.configId === "reasoningEffort")
      writeSessionEffort(params.sessionId, config.reasoningEffort, ctx.options.env ?? process.env);
    session.config = config;
    const configOptions = ctx.sessionConfigOptions(session);
    await ctx.client.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
    return { configOptions };
  } finally {
    session.safetyChanging = false;
  }
}

/** `session/set_mode`. */
export async function setSessionMode(
  ctx: ConfigurationContext,
  params: SetSessionModeRequest,
): Promise<SetSessionModeResponse> {
  const session = ctx.requireSession(params.sessionId);
  requireAvailable(modeAvailability(params.modeId, ctx.safetyGuard(), ctx.backend));
  if (
    (ctx.backend === "sdk" || params.modeId === "plan" || session.modeId === "plan") &&
    (session.safetyChanging || session.turnFinished || session.sdkHost?.owner.hasActiveTurn)
  )
    throw RequestError.invalidRequest(
      undefined,
      "Wait for the active turn before changing safety or planning mode",
    );
  if (session.modeId !== params.modeId)
    await changeMode(ctx, params.sessionId, session, params.modeId as MuseModeId);
  return {};
}

/** Planning and review need a session whose tools the read-only flags actually constrain. */
export function assertWorkflowTools(options: MuseAgentOptions, session: SessionState): void {
  if (
    session.mcpServers.length ||
    Object.keys(readConfiguredMcpServers(options.env ?? process.env)).length
  )
    throw RequestError.invalidParams(
      undefined,
      "Planning and review require a session without MCP servers; read-only workspace flags do not constrain external tool effects",
    );
}

/** Switches the session mode, replacing its host when safety flags change. */
export async function changeMode(
  ctx: ConfigurationContext,
  sessionId: string,
  session: SessionState,
  mode: MuseModeId,
): Promise<void> {
  if (session.safetyChanging)
    throw RequestError.invalidRequest(undefined, "A safety setting change is already in progress");
  session.safetyChanging = true;
  try {
    if (mode === "plan") assertWorkflowTools(ctx.options, session);
    if (ctx.backend === "sdk" && mode !== "yolo") {
      writeSessionMode(sessionId, mode, ctx.options.env ?? process.env);
      if (session.sdkHost) {
        await session.sdkHost.owner.close();
        session.sdkHost = undefined;
      }
    }
    session.modeId = mode;
    await ctx.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: mode },
    });
    await ctx.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: ctx.sessionConfigOptions(session),
      },
    });
  } finally {
    session.safetyChanging = false;
  }
}

/** What building the config options needs from the agent. */
export interface ConfigOptionsContext {
  readonly options: MuseAgentOptions;
  readonly backend: "exec" | "sdk";
  readonly clientCapabilities: ClientCapabilities;
  readonly efforts: readonly MuseReasoningEffort[];
  safetyGuard(): ReturnType<typeof guardContext> & { env: Record<string, string | undefined> };
  sessionModes(current: MuseModeId): SessionModeState;
}

/** The session's ACP config options: mode, model, effort, safety and recommendations. */
export function buildSessionConfigOptions(
  ctx: ConfigOptionsContext,
  session: Pick<SessionState, "config" | "modeId" | "modelDiscovery">,
): SessionConfigOption[] {
  const modes = ctx.sessionModes(session.modeId);
  const hostVersion = ctx.options.skipSdkHostCheck
    ? null
    : probeSdkHost(ctx.options.env, ctx.options.museBinary).version;
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
    ...buildConfigOptions(
      session.config,
      ctx.backend,
      session.modelDiscovery,
      hostVersion,
      ctx.efforts,
    ),
    ...(ctx.backend === "sdk"
      ? safetyConfigOptions(session.config.safety, ctx.safetyGuard(), hostVersion)
      : []),
  ];
  if (ctx.backend !== "sdk" || ctx.clientCapabilities._meta?.[RECOMMENDATION_EXTENSION] !== 1)
    return options;
  return configRecommendations(options, session.modelDiscovery, hostVersion);
}

/** Until a turn or selection uses it, the built-in default follows the catalog. */
export function adoptCatalogDefault(session: SessionState): void {
  const model = session.builtInModel && catalogDefaultModel(session.modelDiscovery);
  if (model)
    session.config = {
      ...session.config,
      model: model.id,
      providerId: model.providerId,
      profileId: model.profileId,
    };
}
