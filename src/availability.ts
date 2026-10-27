import { RequestError } from "@agentclientprotocol/sdk";

export type Availability =
  | { available: true; implementation: "native" | "adapter" }
  | {
      available: false;
      kind:
        | "unknown"
        | "backend"
        | "version"
        | "guard"
        | "busy"
        | "negotiation"
        | "unverified"
        | "unsupported";
      reason: string;
    };

export function unavailable(
  kind: Exclude<Availability, { available: true }>["kind"],
  reason: string,
): Availability {
  return { available: false, kind, reason };
}

/** Advertisement and request rejection consume the same decision. */
export function requireAvailable(decision: Availability): void {
  if (decision.available) return;
  const data = { availability: decision.kind };
  if (decision.kind === "busy") throw RequestError.invalidRequest(data, decision.reason);
  throw RequestError.invalidParams(data, decision.reason);
}

/** Native policy enforcement is separate from adapter-issued once decisions. */
export function nativePolicyAvailability(
  policy: string,
  hostVersion: string | null | undefined,
): Availability {
  if (policy === "onRequest") return { available: true, implementation: "native" };
  if (!["promptUnmatched", "denyUnmatched", "allowAll"].includes(policy))
    return unavailable("unknown", "Unknown native approval policy; choose an advertised option");
  const version = hostVersion
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  const [major, minor, patch] = version ?? [];
  if (major === undefined || minor === undefined || patch === undefined)
    return unavailable(
      "unverified",
      "Native policy enforcement is unverified on this host; use onRequest with adapter bypassApprovals/rejectApprovals",
    );
  if (major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 1))))
    return { available: true, implementation: "native" };
  return unavailable(
    "version",
    `Native ${policy} enforcement is not verified on Muse ${hostVersion}; use onRequest with bypassApprovals/rejectApprovals, or Muse 1.2.1+`,
  );
}

/** The public host has one authorized workspaceRoot. Reject, never ignore extras. */
export function requireSingleWorkspace(additionalDirectories?: readonly string[] | null): void {
  if (additionalDirectories?.length)
    requireAvailable(
      unavailable(
        "unsupported",
        "Muse Code supports one workspace root; start a separate session for another workspace. No additional directory was authorized",
      ),
    );
}
