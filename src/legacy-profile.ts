import { RequestError } from "@agentclientprotocol/sdk";
import { MspError } from "@muse-code/sdk";

export const LEGACY_AUTO_REVIEW_MESSAGE =
  "This Muse host cannot resume a saved session using the :auto-review permission profile " +
  "because its automated reviewer is unavailable. Continue it in Muse with reviewer support, " +
  "or start a new ACP session. The public SDK cannot replace a saved permission profile.";

/**
 * w2/m2: a host without the automated reviewer cannot compose a saved
 * `:auto-review` profile. 1.2.1/1.3.0-R3057.1 refuse only `session/resume`
 * with the detail in the message; 1.3.0-R3401.1 also refuses the lease-free
 * `session/read` as `resume_refused_class_c` with the detail in `data.details`.
 */
export function isLegacyAutoReviewRefusal(error: unknown): boolean {
  if (!(error instanceof MspError) || error.code !== -32603) return false;
  const details = error.data?.details as { detail?: unknown } | undefined;
  const text = `${error.message} ${typeof details?.detail === "string" ? details.detail : ""}`;
  return (
    text.includes("permission profile ':auto-review' cannot be used") &&
    text.includes("the automated reviewer is unavailable on this host")
  );
}

/** The actionable ACP error for a refused read; nothing was submitted or replayed. */
export function legacyAutoReviewReadError(): RequestError {
  return RequestError.internalError(
    {
      failure: {
        source: "host",
        kind: "legacyProfileUnavailable",
        retryable: false,
        recovery: "Continue the session in Muse with reviewer support, or start a new ACP session.",
        outcome: "failed",
      },
    },
    LEGACY_AUTO_REVIEW_MESSAGE,
  );
}
