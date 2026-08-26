import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const INSTALL_HINT =
  "Install Muse Code (the `muse` CLI) and make sure it is on PATH, " +
  "or set MUSE_CODE_EXECUTABLE to its location. " +
  "See https://dev.meta.ai/docs/muse-code/";

/**
 * Resolve the `muse` binary this adapter wraps. `MUSE_CODE_EXECUTABLE` wins;
 * otherwise the PATH is searched. Throws with an actionable hint when absent
 * so editors surface a useful error instead of a failed spawn later.
 */
export function museCliPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.MUSE_CODE_EXECUTABLE;
  if (override) {
    if (!isExecutableFile(override)) {
      throw new Error(
        `MUSE_CODE_EXECUTABLE points to "${override}", which is not an executable file. ${INSTALL_HINT}`,
      );
    }
    return resolve(override);
  }

  const names = process.platform === "win32" ? ["muse.exe", "muse.cmd", "muse.bat"] : ["muse"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(`Could not find the \`muse\` CLI on PATH. ${INSTALL_HINT}`);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    // X_OK is meaningless on Windows; existence as a file is the best signal.
    if (process.platform !== "win32") {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
