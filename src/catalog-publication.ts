import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import type { Logger } from "./logger.js";
import {
  MuseModelDiscovery,
  readModelCatalog,
  type ModelDiscoveryResult,
} from "./model-discovery.js";
import { sdkDeadline } from "./sdk-operation.js";
import { adoptCatalogDefault } from "./session-configuration.js";

/** What reading and publishing the model catalog needs from the agent. */
export interface CatalogContext {
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly isDisposed: boolean;
  readonly modelDiscovery: MuseModelDiscovery;
  providerEnv(sessionId: string): Record<string, string | undefined>;
  catalogIdentity(session: SessionState, env: Record<string, string | undefined>): string;
  trackRead<T>(work: Promise<T>): Promise<T>;
  sessionConfigOptions(
    session: Pick<SessionState, "config" | "modeId" | "modelDiscovery">,
  ): SessionConfigOption[];
}

/**
 * Applies a model catalog read to the session when it still belongs to the
 * same host identity, publishing config options only when they change.
 */
export async function publishCatalog(
  ctx: CatalogContext,
  sessionId: string,
  session: SessionState,
  identity: string,
  result: ModelDiscoveryResult,
  cache = true,
): Promise<boolean> {
  if (ctx.isDisposed || session.cancelRequested || ctx.sessions.get(sessionId) !== session)
    return false;
  const env = ctx.providerEnv(sessionId);
  try {
    if (ctx.catalogIdentity(session, env) !== identity) return false;
  } catch {
    return false;
  }
  if (cache) ctx.modelDiscovery.remember(session.cwd, env, result);
  const previous = ctx.sessionConfigOptions(session);
  session.modelDiscovery = result;
  adoptCatalogDefault(session);
  const configOptions = ctx.sessionConfigOptions(session);
  if (JSON.stringify(previous) === JSON.stringify(configOptions)) return true;
  await ctx.client.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions,
    },
  });
  return true;
}

/** `/models`: re-reads the catalog; the reply text, or undefined when cancelled. */
export async function refreshModels(
  ctx: CatalogContext,
  sessionId: string,
  session: SessionState,
): Promise<string | undefined> {
  session.cancelRequested = false;
  const env = ctx.providerEnv(sessionId);
  const identity = ctx.catalogIdentity(session, env);
  // An explicit refresh can wait for startup; ordinary session creation never does.
  const discovery = new MuseModelDiscovery({
    env,
    museBinary: ctx.options.museBinary,
    logger: ctx.logger,
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
    const result = await ctx.trackRead(
      connection ? readModelCatalog(connection, abort.signal) : discovery.discover(session.cwd),
    );
    const published = await publishCatalog(ctx, sessionId, session, identity, result, !connection);
    if (session.cancelRequested) return undefined;
    return !published
      ? "Configuration changed during refresh. Run /models again for the current choices."
      : result.status === "available"
        ? `Model choices refreshed (${result.models.length} reported). Select a model in session settings.`
        : `Model choices could not be refreshed. The current selection is retained. ${result.reason}`;
  } finally {
    await discovery.dispose();
    session.modelRefresh = undefined;
  }
}
