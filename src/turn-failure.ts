import { RequestError, type PromptResponse } from "@agentclientprotocol/sdk";
import { MspError, type TurnOutcome } from "@muse-code/sdk";
import { upstreamFixHint } from "./upstream-fixes.js";

export interface FailureObservation {
  source: "host" | "provider" | "transport" | "adapter";
  phase?: string;
  mutation?: "possiblyApplied";
  execution?: "notSubmitted" | "possiblySubmitted";
  kind: string;
  retryable?: boolean;
  recovery: string;
  outcome: "failed" | "unknown";
}

/** Diagnostics are bounded and never copy arbitrary protocol data or host stderr. */
export function safeDiagnostic(text: string, env: Record<string, string | undefined> = {}): string {
  for (const [name, value] of Object.entries(env))
    if (value && /(?:key|token|secret|password|credentials?)$/i.test(name))
      text = text.split(value).join("[redacted]");
  return text
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api_key|key|token|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 4096);
}

function observation(kind: string, retryable?: boolean): FailureObservation {
  const recovery =
    kind === "authRequired"
      ? "Replace the rejected provider credentials or run muse login, then explicitly submit again."
      : ["configError", "environmentError", "projectionError"].includes(kind)
        ? "Check the selected model, provider, workspace and input configuration before submitting again."
        : kind === "terminalUnknown" || kind === "transportError"
          ? "Reload and inspect the session before deciding whether to submit again; execution may have occurred."
          : "Inspect the failure and session state before explicitly submitting again.";
  return {
    source:
      kind === "modelError" || kind === "authRequired"
        ? "provider"
        : kind === "terminalUnknown" || kind === "transportError"
          ? "transport"
          : "host",
    kind,
    ...(retryable === undefined ? {} : { retryable }),
    recovery,
    outcome: kind === "terminalUnknown" || kind === "transportError" ? "unknown" : "failed",
  };
}

export function failureError(
  kind: string,
  message: string,
  retryable?: boolean,
  env: Record<string, string | undefined> = {},
): RequestError {
  const failure = observation(safeDiagnostic(kind, env), retryable);
  const hint = upstreamFixHint(message);
  const detail = `Muse SDK turn failed: ${safeDiagnostic(message, env)}. ${failure.recovery}${hint ? ` ${hint}` : ""}`;
  return kind === "authRequired"
    ? RequestError.authRequired({ failure }, detail)
    : RequestError.internalError({ failure }, detail);
}

export function sdkTerminalResponse(
  outcome: TurnOutcome,
  env: Record<string, string | undefined>,
): PromptResponse {
  if (outcome.kind === "terminalUnknown")
    throw failureError(
      "terminalUnknown",
      "Muse SDK host died before the turn completed",
      undefined,
      env,
    );
  if (outcome.kind === "unqueued")
    throw failureError("unqueued", "Muse SDK turn was unqueued before launch", false, env);
  const { params } = outcome;
  if (params.terminal === "completed") return { stopReason: "end_turn" };
  if (params.terminal === "cancelled") return { stopReason: "cancelled" };
  if (params.error?.kind === "stepLimit") return { stopReason: "max_turn_requests" };
  throw failureError(
    params.error?.kind ?? params.terminal,
    params.error?.message ?? params.reason ?? params.terminal,
    params.error?.retryable,
    env,
  );
}

export function sdkThrownError(
  error: unknown,
  env: Record<string, string | undefined>,
): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof MspError)
    return failureError(error.kind ?? "hostError", error.message, error.retryable, env);
  return failureError(
    "transportError",
    error instanceof Error ? error.message : "Muse SDK connection failed",
    undefined,
    env,
  );
}

export function observedFailure(error: unknown): FailureObservation | undefined {
  if (!(error instanceof RequestError)) return;
  return (error.data as { failure?: FailureObservation } | undefined)?.failure;
}
