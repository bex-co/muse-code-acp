import type { SessionNotification } from "@agentclientprotocol/sdk";

/**
 * Host notifications that become ACP `notice` updates for the running turn.
 * Neither reaches the SDK fold as state: `approval/reviewing` is a notice (the
 * approval has no pending entry yet) and a model retry is non-terminal turn
 * progress. ACP allows notices only for clients advertising `session.notices`;
 * other clients get nothing, so their transcripts stay unchanged.
 */
export const HOST_NOTICE_METHODS = new Set(["approval/reviewing", "turn/modelRetryScheduled"]);

const seconds = (ms: unknown) =>
  typeof ms === "number" && ms > 0 ? `${Math.max(1, Math.round(ms / 1000))} s` : "now";

export function hostNotice(
  method: string,
  params: Record<string, unknown>,
  scope: { sessionId: string; turnId: string | undefined },
): SessionNotification | undefined {
  if (params.sessionId !== scope.sessionId || !scope.turnId || params.turnId !== scope.turnId)
    return undefined;
  if (method === "turn/modelRetryScheduled") {
    const cause = [params.errorKind, params.httpStatus].filter((x) => x !== undefined).join(" ");
    return {
      sessionId: scope.sessionId,
      update: {
        sessionUpdate: "notice",
        severity: "warning",
        title: `Model request failed${cause ? ` (${cause})` : ""}; retrying, attempt ${String(params.nextAttempt)} of ${String(params.maxAttempts)}`,
        description: `Muse retries automatically; next attempt ${seconds(params.retryDelayMs) === "now" ? "now" : `in ${seconds(params.retryDelayMs)}`}.`,
      },
    };
  }
  if (method === "approval/reviewing") {
    const tool = typeof params.toolName === "string" ? params.toolName : "a tool call";
    return {
      sessionId: scope.sessionId,
      update: {
        sessionUpdate: "notice",
        severity: "info",
        title: `Muse's reviewer is checking ${tool} before it runs`,
        description: "You are asked only if the reviewer escalates it.",
      },
    };
  }
  return undefined;
}
