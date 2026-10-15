import { RequestError, type LogoutRequest, type PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import type { Logger } from "./logger.js";
import { renameSession } from "./session-title.js";
import type { SlashCommand } from "./slash-commands.js";
import { listMuseSkills } from "./skills.js";

/** What the local slash commands need from the agent. */
export interface LocalCommandContext {
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly isDisposed: boolean;
  providerEnv(sessionId: string): Record<string, string | undefined>;
  sessionCommandsAvailable(): boolean;
  assertRunning(): void;
  /** Refreshes the model catalog; the reply text, or undefined when cancelled. */
  refreshModels(sessionId: string, session: SessionState): Promise<string | undefined>;
  logout(params: LogoutRequest): Promise<unknown>;
  authStatus(): { configured: boolean };
}

/**
 * Runs a slash command the adapter answers itself (`/rename`, `/models`,
 * `/skills`, `/tasks`, `/logout`): no model turn, one reply message.
 */
export async function runLocalCommand(
  ctx: LocalCommandContext,
  sessionId: string,
  session: SessionState,
  local: NonNullable<SlashCommand["local"]>,
): Promise<PromptResponse> {
  session.safetyChanging = true;
  try {
    let text: string;
    if (local.kind === "rename") {
      const title = renameSession(sessionId, local.argument, ctx.options.env ?? process.env);
      await ctx.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: title.text,
          updatedAt: title.updatedAt,
        },
      });
      text = `Session title saved by this adapter: ${title.text}`;
      if (ctx.sessionCommandsAvailable()) {
        const owner = session.sdkHost?.owner;
        if (owner?.isOpen) {
          try {
            const name = await owner.renameNative(title.text);
            text += `\nMuse session name set to "${name}" (Muse normalizes names).`;
          } catch (error) {
            text += `\nMuse kept its own session name: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          session.pendingNativeName = title.text;
          text += "\nMuse's own session name will be set when this session's host next starts.";
        }
      }
    } else if (local.kind === "models") {
      const refreshed = await ctx.refreshModels(sessionId, session);
      if (refreshed === undefined) return { stopReason: "cancelled" };
      text = refreshed;
    } else if (local.kind === "skills") {
      const skills = await listMuseSkills(
        session.cwd,
        ctx.providerEnv(sessionId),
        ctx.options.museBinary,
        ctx.logger,
      );
      ctx.assertRunning();
      if (ctx.sessions.get(sessionId) !== session)
        throw RequestError.invalidRequest(undefined, "Session closed while listing skills");
      text =
        skills
          .slice(0, 200)
          .map((s) => `${s.id} [${s.activation}, ${s.scope}] — ${s.description.slice(0, 300)}`)
          .join("\n") || "No Muse skills were reported.";
    } else if (local.kind === "tasks") {
      const tasks = await session.sdkHost?.owner.listTasks();
      text =
        tasks === undefined
          ? "No live Muse host reports background tasks for this session (task listing needs a running host on Muse 1.4.6 or newer)."
          : tasks
              .slice(0, 200)
              .map(
                (t) =>
                  `${t.tool ?? t.kind} ${t.taskId} [${t.status}${t.backgroundInitiator ? `, backgrounded by ${t.backgroundInitiator}` : ""}]${t.startedAt ? ` since ${t.startedAt}` : ""}`,
              )
              .join("\n") || "No background tasks are running.";
    } else {
      await ctx.logout({});
      text = `Stored Muse logout completed. ${ctx.authStatus().configured ? "Credentials remain configured (including any exported META_API_KEY); verification is unknown." : "No credentials are configured."} Adapter sessions were closed.`;
    }
    if (
      !ctx.isDisposed &&
      (!ctx.sessions.has(sessionId) || ctx.sessions.get(sessionId) === session)
    )
      await ctx.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    return { stopReason: "end_turn" };
  } finally {
    session.safetyChanging = false;
  }
}
