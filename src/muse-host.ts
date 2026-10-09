import { nativePolicyAvailability, requireAvailable } from "./availability.js";
import { DEFAULT_SAFETY, safetyArgs, type SafetySettings } from "./safety-settings.js";
import { spawnSync } from "node:child_process";
import { RequestError } from "@agentclientprotocol/sdk";
import { museCliPath } from "./muse-cli.js";

/** Pinned `@muse-code/sdk` and the Muse host verified against it for `serve`. */
export const SDK_PACKAGE = "@muse-code/sdk@1.4.4";
export const MIN_MUSE_HOST_FOR_SDK = "1.1.1";

export interface SdkHostCheck {
  binary: string;
  version: string | null;
  serveHelpOk: boolean;
  serveHelp?: string;
}

const probed = new Map<string, SdkHostCheck>();
const execProfiles = new Map<string, boolean>();

/** Built-in exec permission profiles are verified from Muse 1.4.4. */
const EXEC_PROFILE_MIN_HOST = [1, 4, 4];

/**
 * Whether `muse exec` accepts `--permission-profile` with the built-in
 * profiles: the flag must be in its help and the host at least 1.4.4.
 */
export function execSupportsPermissionProfile(
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
): boolean {
  const binary = museBinary ?? museCliPath(env);
  const cached = execProfiles.get(binary);
  if (cached !== undefined) return cached;
  const version = probeSdkHost(env, binary).version?.split(".").map(Number);
  const help = spawnSync(binary, ["exec", "--help"], {
    encoding: "utf8",
    env: env as Record<string, string>,
    timeout: 5_000,
  });
  const supported =
    !!version &&
    EXEC_PROFILE_MIN_HOST.reduce<number>(
      (order, part, i) => order || Math.sign((version[i] ?? 0) - part),
      0,
    ) >= 0 &&
    `${help.stdout ?? ""}`.includes("--permission-profile");
  execProfiles.set(binary, supported);
  return supported;
}

/**
 * Probe whether the resolved Muse binary exposes `serve` (MSP host). Used
 * before starting an SDK turn so missing/disabled hosts fail with an upgrade
 * hint instead of hanging on model submission.
 */
export function probeSdkHost(
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
): SdkHostCheck {
  const binary = museBinary ?? museCliPath(env);
  const cached = probed.get(binary);
  if (cached) {
    return cached;
  }
  const version = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env: env as Record<string, string>,
    timeout: 5_000,
  });
  const help = spawnSync(binary, ["serve", "--help"], {
    encoding: "utf8",
    env: env as Record<string, string>,
    timeout: 5_000,
  });
  const versionText = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim();
  const match = versionText.match(/(\d+\.\d+\.\d+)/);
  const check = {
    binary,
    version: match?.[1] ?? null,
    serveHelpOk: help.status === 0,
    serveHelp: `${help.stdout ?? ""}${help.stderr ?? ""}`,
  };
  probed.set(binary, check);
  return check;
}

/** Fail before a model turn when the host cannot run the pinned SDK path. */
export function assertSdkHostSupport(
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
): SdkHostCheck {
  let check: SdkHostCheck;
  try {
    check = probeSdkHost(env, museBinary);
  } catch (error) {
    throw RequestError.internalError(
      undefined,
      `Muse SDK backend requires a Muse host with \`serve\` support ` +
        `(verified with ${MIN_MUSE_HOST_FOR_SDK}+, SDK ${SDK_PACKAGE}). ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!check.serveHelpOk) {
    throw RequestError.internalError(
      undefined,
      `Muse binary at ${check.binary} does not support \`muse serve\` ` +
        `(needed for ${SDK_PACKAGE}). Upgrade Muse Code to ${MIN_MUSE_HOST_FOR_SDK} or newer, ` +
        `or set MUSE_CODE_ACP_BACKEND=exec.`,
    );
  }
  return check;
}

/** Map an SDK host exit into an actionable ACP error when possible. */
export function sdkHostExitMessage(stderr: string): string | undefined {
  if (/experimental SDK tier is disabled/i.test(stderr)) {
    return (
      "the experimental SDK tier is disabled on this Muse host; " +
      `upgrade Muse Code to ${MIN_MUSE_HOST_FOR_SDK}+ with SDK support enabled, ` +
      "or set MUSE_CODE_ACP_BACKEND=exec"
    );
  }
  return undefined;
}

/** Validate requested controls before binding them or starting a model turn. */
export function assertSdkSafetySupport(
  safety: SafetySettings = DEFAULT_SAFETY,
  env: Record<string, string | undefined> = process.env,
  binary?: string,
): void {
  const check = assertSdkHostSupport(env, binary);
  requireAvailable(nativePolicyAvailability(safety.nativeApprovalPolicy, check.version));
  for (const flag of safetyArgs(safety).filter((arg) => arg.startsWith("--"))) {
    if (!check.serveHelp?.includes(flag))
      throw RequestError.invalidParams(
        undefined,
        `Muse SDK host does not advertise ${flag}; use default posture or upgrade Muse`,
      );
  }
}
