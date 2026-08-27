import { McpServer, methods } from "@agentclientprotocol/sdk";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMuseMcpOverlay } from "../mcp-overlay.js";
import { connectTestClient, fakeMuseBinary, initialized } from "./helpers.js";

const stdioServer: McpServer = {
  name: "security-tools",
  command: "/bin/security-mcp",
  args: ["--stdio"],
  env: [{ name: "SCAN_ROOT", value: "/workspace" }],
};

describe("MCP passthrough", () => {
  it("advertises the ACP-required stdio transport without remote transports", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const ctx = await testClient.connect();
    const response = await ctx.request(methods.agent.initialize, { protocolVersion: 1 });

    expect(response.agentCapabilities?.mcpCapabilities).toEqual({});
  });

  it("merges session MCP with user settings in a private disposable overlay", () => {
    const configHome = mkdtempSync(join(tmpdir(), "muse-mcp-source-"));
    const museDir = join(configHome, "muse");
    mkdirSync(museDir);
    mkdirSync(join(configHome, "other-tool"));
    writeFileSync(join(museDir, "auth.json"), '{"credential":"stored"}\n');
    writeFileSync(
      join(museDir, "settings.json"),
      JSON.stringify({
        schema_version: 1,
        provider: "meta",
        mcp_servers: {
          existing: { transport: "stdio", command: "/bin/existing", args: [], env: {} },
          "security-tools": { transport: "stdio", command: "/bin/old", args: [], env: {} },
        },
      }),
    );
    const original = readFileSync(join(museDir, "settings.json"), "utf8");

    const overlay = createMuseMcpOverlay([stdioServer], { XDG_CONFIG_HOME: configHome });
    const settings = JSON.parse(
      readFileSync(join(overlay.configHome, "muse", "settings.json"), "utf8"),
    );

    expect(settings.provider).toBe("meta");
    expect(settings.mcp_servers.existing.command).toBe("/bin/existing");
    expect(settings.mcp_servers["security-tools"]).toEqual({
      transport: "stdio",
      command: "/bin/security-mcp",
      args: ["--stdio"],
      env: { SCAN_ROOT: "/workspace" },
    });
    expect(lstatSync(join(overlay.configHome, "muse", "auth.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(overlay.configHome, "other-tool")).isSymbolicLink()).toBe(true);
    expect(statSync(join(overlay.configHome, "muse", "settings.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(museDir, "settings.json"), "utf8")).toBe(original);

    const overlayPath = overlay.configHome;
    overlay.cleanup();
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("injects the overlay for a prompt and removes it after Muse exits", async () => {
    const configHome = mkdtempSync(join(tmpdir(), "muse-mcp-prompt-source-"));
    const capturePath = join(mkdtempSync(join(tmpdir(), "muse-mcp-capture-")), "capture.json");
    mkdirSync(join(configHome, "muse"));
    writeFileSync(
      join(configHome, "muse", "settings.json"),
      '{"schema_version":1,"model":"original-model"}\n',
    );
    const testClient = connectTestClient({
      museBinary: fakeMuseBinary(),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        FAKE_MUSE_MODE: "exit0",
        FAKE_MUSE_SETTINGS_CAPTURE: capturePath,
      },
    });
    const ctx = await initialized(testClient);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-mcp-workspace-")),
      mcpServers: [stdioServer],
    });

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "use the security tools" }],
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(capture.settings.model).toBe("original-model");
    expect(capture.settings.mcp_servers["security-tools"].command).toBe("/bin/security-mcp");
    expect(existsSync(capture.configHome)).toBe(false);
  });
});
