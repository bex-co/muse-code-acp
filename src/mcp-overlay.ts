import { McpServer } from "@agentclientprotocol/sdk";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface MuseMcpOverlay {
  env: Record<string, string | undefined>;
  configHome: string;
  cleanup(): void;
}

/**
 * Builds the Muse settings shape for the stdio transport every ACP agent must
 * support. Remote and ACP transports are not advertised by this adapter.
 */
export function museMcpServers(mcpServers: McpServer[]): Record<string, unknown> {
  return Object.fromEntries(
    mcpServers.map((server) => {
      if (!("command" in server)) {
        throw new Error(`unsupported MCP transport for server ${JSON.stringify(server.name)}`);
      }
      return [
        server.name,
        {
          transport: "stdio",
          command: server.command,
          args: server.args,
          env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        },
      ];
    }),
  );
}

/**
 * Muse 0.2.1 only reads MCP servers from $XDG_CONFIG_HOME/muse/settings.json.
 * Create a private, per-turn overlay so ACP-provided servers can be injected
 * without changing the user's settings or leaking across concurrent sessions.
 * Existing XDG entries are symlinked into the overlay; only settings.json is a
 * temporary merged copy.
 */
export function createMuseMcpOverlay(
  mcpServers: McpServer[],
  baseEnv: Record<string, string | undefined> = process.env,
): MuseMcpOverlay {
  const sourceConfigHome = baseEnv.XDG_CONFIG_HOME || join(baseEnv.HOME ?? homedir(), ".config");
  const configHome = mkdtempSync(join(tmpdir(), "muse-code-acp-"));
  chmodSync(configHome, 0o700);

  try {
    mirrorDirectory(sourceConfigHome, configHome, "muse");

    const sourceMuseDir = join(sourceConfigHome, "muse");
    const overlayMuseDir = join(configHome, "muse");
    mkdirSync(overlayMuseDir, { mode: 0o700 });
    mirrorDirectory(sourceMuseDir, overlayMuseDir, "settings.json");

    const sourceSettingsPath = join(sourceMuseDir, "settings.json");
    const settings = readSettingsDocument(sourceSettingsPath);
    const existingMcp = settings.mcp_servers;
    if (existingMcp !== undefined && !isRecord(existingMcp)) {
      throw new Error(`muse settings mcp_servers at ${sourceSettingsPath} is not an object`);
    }

    const merged = {
      schema_version: 1,
      ...settings,
      mcp_servers: {
        ...(existingMcp ?? {}),
        ...museMcpServers(mcpServers),
      },
    };
    const overlaySettingsPath = join(overlayMuseDir, "settings.json");
    writeFileSync(overlaySettingsPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    chmodSync(overlaySettingsPath, 0o600);

    return {
      env: { ...baseEnv, XDG_CONFIG_HOME: configHome },
      configHome,
      cleanup: () => rmSync(configHome, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(configHome, { recursive: true, force: true });
    throw err;
  }
}

function readSettingsDocument(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`muse settings at ${path} is not an object`);
  }
  return parsed;
}

function mirrorDirectory(source: string, destination: string, excludedName: string): void {
  let names: string[];
  try {
    names = readdirSync(source);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return;
    }
    throw err;
  }

  for (const name of names) {
    if (name === excludedName) {
      continue;
    }
    const target = join(source, name);
    const type = lstatSync(target).isDirectory() ? "junction" : "file";
    symlinkSync(target, join(destination, name), type);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err;
}
