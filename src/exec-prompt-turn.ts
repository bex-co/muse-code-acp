import { RequestError, type ContentBlock, type PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient, MuseAgentOptions, SessionState } from "./agent-types.js";
import type { Logger } from "./logger.js";
import { createMuseMcpOverlay, type MuseMcpOverlay } from "./mcp-overlay.js";
import type { MuseModeId } from "./modes.js";
import { spawnMuseExec } from "./muse-exec.js";
import { compileMusePrompt, type CompiledMusePrompt } from "./prompt-files.js";
import { TurnTranslator } from "./translate.js";
import { unreachable } from "./utils.js";

/** What a legacy `muse exec` prompt turn needs from the agent. */
export interface ExecTurnContext {
  readonly client: AcpClient;
  readonly logger: Logger;
  readonly options: MuseAgentOptions;
  execArgs(modeId: MuseModeId): string[];
}

/**
 * One prompt turn on the legacy exec backend. Owns the turn's MCP overlay,
 * prompt files and child: the child is stopped before either is removed.
 */
export async function runExecTurn(
  ctx: ExecTurnContext,
  sessionId: string,
  session: SessionState,
  prompt: ContentBlock[],
  baseEnv: Record<string, string | undefined>,
): Promise<PromptResponse> {
  let mcpOverlay: MuseMcpOverlay | null = null;
  let compiledPrompt: CompiledMusePrompt | undefined;
  try {
    if (session.mcpServers.length > 0) {
      mcpOverlay = createMuseMcpOverlay(session.mcpServers, baseEnv);
      session.activeMcpOverlay = mcpOverlay;
    }
    compiledPrompt = await compileMusePrompt(prompt);
    if (session.cancelRequested) return { stopReason: "cancelled" };
    const translator = new TurnTranslator(sessionId);
    const handle = spawnMuseExec({
      prompt: compiledPrompt.prompt,
      imagePaths: compiledPrompt.imagePaths,
      sessionId: session.museSessionId,
      cwd: session.cwd,
      museBinary: ctx.options.museBinary,
      provider: ctx.options.provider,
      // Model/effort flags only apply to the real provider; muse rejects or
      // ignores them for echo, so tests with the echo provider skip them.
      ...(ctx.options.provider === "echo"
        ? {}
        : { model: session.config.model, reasoningEffort: session.config.reasoningEffort }),
      env: mcpOverlay?.env ?? ctx.options.env,
      extraArgs: ctx.execArgs(session.modeId),
      logger: ctx.logger,
    });
    session.activeTurn = handle;
    for await (const envelope of handle.events) {
      for (const notification of translator.toUpdates(envelope)) {
        await ctx.client.sessionUpdate(notification);
      }
      if (translator.approvalWait !== null) {
        handle.kill();
        break;
      }
    }
    const outcome = await handle.done;
    const stall = handle.approvalStall();
    if (stall)
      throw RequestError.internalError(
        undefined,
        `muse exec stopped: its ${stall.taskKind} call waited for an approval decision that headless exec cannot receive (Muse's reviewer likely escalated to a user). Use the SDK backend for interactive approvals, or choose Read-only or Auto-approve mode`,
      );
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
        throw execTurnFailure(outcome.code, terminal);
      }
      default:
        return (unreachable(outcome, ctx.logger), { stopReason: "end_turn" });
    }
  } finally {
    try {
      session.activeTurn?.kill();
      await session.activeTurn?.done.catch(() => {});
      mcpOverlay?.cleanup();
    } finally {
      await compiledPrompt?.cleanup();
    }
  }
}

/**
 * Classifies an exit-1 turn using the run's own terminal record. Note: exit
 * codes describe run completion, not code correctness — an exit-0 turn where
 * the agent reports failing tests is still `end_turn`; only run-level
 * failures land here.
 */
function execTurnFailure(
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
