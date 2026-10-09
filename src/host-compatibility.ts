/**
 * What this adapter knows about the host it is actually talking to.
 *
 * The pinned SDK treats a schema-fingerprint divergence as an advisory warning
 * and keeps going, which is correct (additive evolution) but left the adapter
 * logging one line no ACP client could ever see. The w2/m1 stall happened on a
 * host that printed that warning on every run. Publishing the comparison gives
 * clients and bug reports the version facts without making a mismatch fatal.
 */
import { EXPECTED_SCHEMA_FINGERPRINT, type FingerprintWarning } from "@muse-code/sdk";
import { MIN_MUSE_HOST_FOR_SDK, SDK_PACKAGE } from "./muse-host.js";

/**
 * Muse hosts this adapter has been exercised against end to end. Membership is
 * evidence of testing, not a support promise, and never gates a connection.
 */
export const VERIFIED_MUSE_HOSTS = ["1.1.1", "1.2.1", "1.4.4"] as const;

export interface HostCompatibility {
  /** The pinned SDK package this adapter speaks MSP through. */
  sdk: string;
  /** Reported by `muse --version`; null when the probe was skipped. */
  hostVersion: string | null;
  minimumHostVersion: string;
  verifiedHosts: readonly string[];
  pinnedFingerprint: string;
  servedFingerprint: string;
  /** False when the host serves a schema the pinned SDK was not written against. */
  matches: boolean;
}

/** Read the served schema fingerprint out of an `initialize` result. */
export function servedFingerprint(initializeResult: unknown): string | undefined {
  const schema = (initializeResult as { schema?: { fingerprint?: unknown } } | undefined)?.schema;
  return typeof schema?.fingerprint === "string" ? schema.fingerprint : undefined;
}

export function hostCompatibility(options: {
  hostVersion?: string | null;
  served?: string;
  fingerprintWarning?: FingerprintWarning;
}): HostCompatibility {
  const warning = options.fingerprintWarning;
  return {
    sdk: SDK_PACKAGE,
    hostVersion: options.hostVersion ?? null,
    minimumHostVersion: MIN_MUSE_HOST_FOR_SDK,
    verifiedHosts: VERIFIED_MUSE_HOSTS,
    // A warning carries both sides; without one the host agreed with the pin.
    pinnedFingerprint: warning?.pinned ?? EXPECTED_SCHEMA_FINGERPRINT,
    servedFingerprint: warning?.served ?? options.served ?? EXPECTED_SCHEMA_FINGERPRINT,
    matches: warning === undefined,
  };
}
