import { spawn } from "node:child_process";
import { museCliPath } from "./muse-cli.js";

/**
 * Runs a non-streaming muse subcommand (`export`, `logout`, `skills list`)
 * and captures stdout. Rejects with the command name and stderr on a nonzero
 * exit. Streaming turns use `spawnMuseExec` instead.
 */
export function runMuseCapture(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  museBinary?: string,
): Promise<string> {
  const binary = museBinary ?? museCliPath();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: env as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`muse ${args[0]} exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}
