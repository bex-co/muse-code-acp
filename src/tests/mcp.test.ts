import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../logger.js";
import { connectTestClient, fakeMuseBinary, initialized } from "./helpers.js";

describe("MCP passthrough (unsupported on muse 0.2.1)", () => {
  it("does not advertise mcp capabilities", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const ctx = await testClient.connect();
    const response = await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    expect(response.agentCapabilities?.mcpCapabilities ?? undefined).toBeUndefined();
  });

  it("ignores provided MCP servers with a loud warning, session still works", async () => {
    const errors: string[] = [];
    const logger: Logger = { log: () => {}, error: (...args) => errors.push(args.join(" ")) };
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() }, logger);
    const ctx = await initialized(testClient);

    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-mcp-test-")),
      mcpServers: [{ name: "tools", command: "/bin/my-mcp", args: [], env: [] }],
    });

    expect(sessionId).toBeTruthy();
    expect(errors.join("\n")).toMatch(/ignoring 1 client-provided MCP server/);
  });
});
