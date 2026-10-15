import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import type { GoalObservation } from "./goal-state.js";
import type { Logger } from "./logger.js";
import { mcpStatus } from "./mcp-status.js";
import type { readMuseSdkSession } from "./muse-sdk.js";
import type { SessionProgress } from "./session-progress.js";
import type { SlashCommand } from "./slash-commands.js";

/** What the `/status`, `/goal` and `/mcp` replies need from the agent. */
export interface StatusContext {
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  readonly backend: "exec" | "sdk";
  sessionCommandsAvailable(): boolean;
  goalControlsAvailable(): boolean;
  authStatus(sessionId?: string): { configured: boolean; verification: string };
  progressFor(sessionId: string, session: SessionState): SessionProgress;
  readSavedSession(
    options: Parameters<typeof readMuseSdkSession>[0],
  ): ReturnType<typeof readMuseSdkSession>;
  publishGoal(sessionId: string, session: SessionState, goal: GoalObservation): Promise<void>;
}

/** The reply to `/status`, `/goal` (status) and `/mcp`. */
export async function statusText(
  ctx: StatusContext,
  sessionId: string,
  session: SessionState,
  kind: NonNullable<SlashCommand["status"]>,
): Promise<string> {
  if (kind === "goal") return inspectGoal(ctx, sessionId, session);
  if (kind !== "status")
    return mcpStatus(session.mcpServers, ctx.options.env ?? process.env, session.mcpFailure);
  const usage = await subscriptionUsageLine(ctx, session);
  const auth = ctx.authStatus(sessionId);
  return `${usage}\nRequested model: ${session.config.model}; provider: ${session.config.providerId ?? "configured default"}; effort: ${session.config.reasoningEffort}; mode: ${session.modeId}.\n${ctx.progressFor(sessionId, session).status()}\nCredentials: ${auth.configured ? "configured" : "not configured"}; verification: ${auth.verification}; identity: unknown.\nLatest failure: ${session.latestFailure?.kind ?? "none observed"}.`;
}

/** The goal reply: Muse's last observed goal, reading saved history when unknown. */
export async function inspectGoal(
  ctx: StatusContext,
  sessionId: string,
  session: SessionState,
): Promise<string> {
  if (!session.goal || session.goal.status === "unknown") {
    let goal: GoalObservation;
    try {
      const saved = await ctx.readSavedSession({
        sessionId: session.museSessionId,
        cwd: session.cwd,
        env: ctx.options.env ?? process.env,
        museBinary: ctx.options.museBinary,
        logger: ctx.logger,
        checkHost: !ctx.options.skipSdkHostCheck,
        readGoal: true,
        allowActive: true,
      });
      goal = saved.goal ?? { status: "unknown", reason: "No goal observation available" };
    } catch {
      goal = { status: "unknown", reason: "Goal history could not be read" };
    }
    if (!session.cancelRequested) await ctx.publishGoal(sessionId, session, goal);
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
    ctx.goalControlsAvailable()
      ? "Last observed Muse state. Change it with /goal set, edit, pause, resume or clear."
      : "Last observed Muse state. Goal controls need the SDK backend on Muse 1.4.6 or newer.",
  ].join("\n");
}

/** Muse's own subscription usage for `/status`, labeled with its source. */
async function subscriptionUsageLine(ctx: StatusContext, session: SessionState): Promise<string> {
  if (ctx.backend !== "sdk") return "Subscription usage: not available on the exec backend.";
  if (!ctx.sessionCommandsAvailable())
    return "Subscription usage: unavailable (verified from Muse 1.4.7).";
  let usage;
  try {
    usage = await session.sdkHost?.owner.readUsage();
  } catch {
    return "Subscription usage: Muse usage/read failed.";
  }
  if (usage === undefined)
    return "Subscription usage: unavailable until this session's host is running.";
  if (usage === null) return "Subscription usage: not reported by Muse (usage/read).";
  const at = (ms: number) => new Date(ms).toISOString();
  return `Subscription usage (Muse usage/read, observed ${at(usage.observedAtMs)}): tier ${usage.tier}; current window ${usage.window.usedPercent}% (resets ${at(usage.window.resetsAtMs)}); weekly ${usage.weekly.usedPercent}% (resets ${at(usage.weekly.resetsAtMs)}).`;
}
