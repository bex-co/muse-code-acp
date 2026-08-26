import { AuthMethod } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Logger } from "./logger.js";
import { museCliPath } from "./muse-cli.js";

export const MUSE_LOGIN_METHOD_ID = "muse-login";
export const META_API_KEY_METHOD_ID = "meta-api-key";

export function museAuthJsonPath(env: Record<string, string | undefined> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(configHome, "muse", "auth.json");
}

/**
 * Existence/size check only — secret material is never read into adapter
 * memory. Precedence mirrors muse: env var > stored credentials.
 */
export function isAuthenticated(env: Record<string, string | undefined> = process.env): boolean {
  if (env.META_API_KEY) {
    return true;
  }
  try {
    return statSync(museAuthJsonPath(env)).size > 2;
  } catch {
    return false;
  }
}

/**
 * Browser login runs through the `--cli` passthrough (`muse-code-acp --cli
 * login` execs `muse login` with inherited stdio); the `terminal-auth` _meta
 * mirrors claude-agent-acp's convention for clients that spawn terminal
 * commands themselves.
 */
export function museAuthMethods(): AuthMethod[] {
  const baseArgs = process.argv.slice(1).filter((arg) => arg !== "--cli");
  return [
    {
      type: "terminal",
      id: MUSE_LOGIN_METHOD_ID,
      name: "Meta account (browser)",
      description: "Opens Meta's browser OAuth flow via `muse login`.",
      args: ["--cli", "login"],
      _meta: {
        "terminal-auth": {
          command: process.execPath,
          args: [...baseArgs, "--cli", "login"],
          label: "Muse Login",
        },
      },
    },
    {
      type: "env_var",
      id: META_API_KEY_METHOD_ID,
      name: "Meta API key",
      description: "Set META_API_KEY for headless/CI use (muse env precedence applies).",
      vars: [{ name: "META_API_KEY", label: "Meta API key", secret: true }],
    },
  ];
}

/**
 * Runs `muse logout` (non-interactive). Note muse cannot unset an exported
 * META_API_KEY — callers still authenticated via env stay authenticated.
 */
export async function runMuseLogout(
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
  logger: Logger = console,
): Promise<void> {
  const binary = museBinary ?? museCliPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["logout"], {
      env: env as Record<string, string>,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`muse logout exited ${code}: ${stderr.trim()}`));
      }
    });
  });
  if (env.META_API_KEY) {
    logger.log("logout note: META_API_KEY is still exported in the environment");
  }
}
