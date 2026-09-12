import { spawnSync } from "node:child_process";
import { RequestError } from "@agentclientprotocol/sdk";
import { museCliPath } from "./muse-cli.js";

/** Pinned `@muse-code/sdk` and the Muse host verified against it for `serve`. */
export const SDK_PACKAGE = "@muse-code/sdk@0.1.1";
export const MIN_MUSE_HOST_FOR_SDK = "1.1.1";

export interface SdkHostCheck {
  binary: string;
  version: string | null;
  serveHelpOk: boolean;
}

const probed = new Map<string, SdkHostCheck>();

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
