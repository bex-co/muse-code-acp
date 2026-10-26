import { methods, type McpServer } from "@agentclientprotocol/sdk";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  capturingLogger,
  connectTestClient,
  fixturesDir,
  initialized,
  ensureExecutable,
} from "./helpers.js";

const server = (credential: string): McpServer => ({
  name: "session-mcp",
  command: "/bin/session-mcp",
  args: [],
  env: [{ name: "TOKEN", value: credential }],
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muse-host-reuse-"));
  const binary = join(root, "fake-msp.cjs");
  copyFileSync(join(fixturesDir, "fake-msp.cjs"), binary);
  ensureExecutable(binary);
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "muse"), { recursive: true });
  const settingsPath = join(configHome, "muse", "settings.json");
  const authPath = join(configHome, "muse", "auth.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ model: "original-model", provider: "original-provider" }),
  );
  writeFileSync(authPath, JSON.stringify({ credential: "original-auth" }));
  const capturePath = join(root, "settings-capture.json");
  const pidPath = join(root, "pid");
  const requestsPath = join(root, "requests.jsonl");
  const logs: string[] = [];
  const client = connectTestClient(
    {
      backend: "sdk",
      museBinary: binary,
      skipSdkHostCheck: true,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: join(root, "data"),
        FAKE_MSP_SETTINGS_CAPTURE: capturePath,
        FAKE_MSP_PID: pidPath,
        FAKE_MSP_CAPTURE: requestsPath,
      },
    },
    capturingLogger(logs),
  );
  const ctx = await initialized(client);
  const create = (credential: string) =>
    ctx.request(methods.agent.session.new, { cwd: root, mcpServers: [server(credential)] });
  const prompt = async (sessionId: string) => {
    const before = client.updates.length;
    const result = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(
      client.updates
        .slice(before)
        .flatMap(({ update }) =>
          update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
            ? [update.content.text]
            : [],
        )
        .join(""),
    ).toBe("hello world");
    return result;
  };
  const capture = () => JSON.parse(readFileSync(capturePath, "utf8"));
  const pid = () => Number(readFileSync(pidPath, "utf8"));
  const spawnCount = () => logs.filter((line) => line.includes("muse-sdk spawn:")).length;
  const requests = () =>
    readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const close = async () => {
    await client.agent.dispose();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    settingsPath,
    authPath,
    client,
    ctx,
    create,
    prompt,
    capture,
    pid,
    spawnCount,
    requests,
    close,
  };
}

it("reuses a session host across turns, isolates another session and cleans retained overlays", async () => {
  const f = await fixture();
  try {
    const first = await f.create("first-secret");
    await f.prompt(first.sessionId);
    const firstPid = f.pid();
    const firstHome = f.capture().configHome;
    expect(f.capture().settings.mcpServers["session-mcp"].env.TOKEN).toBe("first-secret");
    expect(existsSync(firstHome)).toBe(true);
    await f.prompt(first.sessionId);
    expect(f.spawnCount()).toBe(1);
    expect(f.pid()).toBe(firstPid);
    const second = await f.create("second-secret");
    await f.prompt(second.sessionId);
    const secondPid = f.pid();
    const secondHome = f.capture().configHome;
    expect(secondPid).not.toBe(firstPid);
    expect(secondHome).not.toBe(firstHome);
    expect(f.capture().settings.mcpServers["session-mcp"].env.TOKEN).toBe("second-secret");
    expect(
      JSON.parse(readFileSync(join(firstHome, "muse", "settings.json"), "utf8")).mcpServers[
        "session-mcp"
      ].env.TOKEN,
    ).toBe("first-secret");
    expect(f.spawnCount()).toBe(2);
    const turns = f.requests().filter((r) => r.method === "turn/start");
    expect(turns.map((r) => r.params.sessionId)).toEqual([
      first.sessionId,
      first.sessionId,
      second.sessionId,
    ]);
    await f.ctx.request(methods.agent.session.close, { sessionId: first.sessionId });
    expect(existsSync(firstHome)).toBe(false);
    expect(() => process.kill(firstPid, 0)).toThrow();
    expect(existsSync(secondHome)).toBe(true);
    await f.client.agent.dispose();
    expect(existsSync(secondHome)).toBe(false);
    expect(() => process.kill(secondPid, 0)).toThrow();
  } finally {
    await f.close();
  }
});

it.each(["effort", "readOnly", "mcp", "settings", "auth"] as const)(
  "applies %s changes with only necessary host replacement",
  async (change) => {
    const f = await fixture();
    try {
      const { sessionId } = await f.create("old-mcp-secret");
      await f.prompt(sessionId);
      const oldPid = f.pid();
      const oldHome = f.capture().configHome;
      if (change === "effort") {
        await f.ctx.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: "reasoningEffort",
          value: "minimal",
        });
      } else if (change === "readOnly") {
        await f.ctx.request(methods.agent.session.setMode, { sessionId, modeId: "readOnly" });
      } else if (change === "mcp") {
        await f.ctx.request(methods.agent.session.resume, {
          sessionId,
          cwd: f.root,
          mcpServers: [server("fresh-mcp-secret")],
        });
      } else if (change === "settings") {
        writeFileSync(
          f.settingsPath,
          JSON.stringify({ provider: "fresh-provider", model: "original-model" }),
        );
      } else {
        writeFileSync(f.authPath, JSON.stringify({ credential: "fresh-auth" }));
      }
      await f.prompt(sessionId);
      expect(f.spawnCount()).toBe(change === "effort" ? 1 : 2);
      if (change === "effort") {
        expect(f.pid()).toBe(oldPid);
        expect(existsSync(oldHome)).toBe(true);
      } else {
        expect(f.pid()).not.toBe(oldPid);
        expect(() => process.kill(oldPid, 0)).toThrow();
        expect(existsSync(oldHome)).toBe(false);
      }
      const capture = f.capture();
      expect(existsSync(capture.configHome)).toBe(true);
      if (change === "effort")
        expect(
          f
            .requests()
            .filter((r) => r.method === "turn/start")
            .at(-1).params.reasoningEffort,
        ).toBe("minimal");
      if (change === "readOnly") {
        expect(capture.args).toContain("--disable-write");
        expect(capture.args).toContain("--disable-shell");
      }
      if (change === "mcp") {
        expect(capture.settings.mcpServers["session-mcp"].env.TOKEN).toBe("fresh-mcp-secret");
        expect(JSON.stringify(capture.settings)).not.toContain("old-mcp-secret");
      }
      if (change === "settings") expect(capture.settings.provider).toBe("original-provider");
      if (change === "auth")
        expect(
          JSON.parse(readFileSync(join(capture.configHome, "muse", "auth.json"), "utf8"))
            .credential,
        ).toBe("fresh-auth");
      await f.ctx.request(methods.agent.session.close, { sessionId });
      expect(existsSync(capture.configHome)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it("updates the execution model with a public setter even when resume metadata already agrees", async () => {
  const f = await fixture();
  try {
    const { sessionId } = await f.create("token");
    await f.prompt(sessionId);
    const pid = f.pid();
    await f.ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "original-model",
    });
    expect(f.pid()).toBe(pid);
    expect(f.spawnCount()).toBe(1);
    await f.ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "new-model",
    });
    await f.prompt(sessionId);
    expect(f.client.agent.sessions.get(sessionId)!.config.model).toBe("new-model");
    expect(f.pid()).not.toBe(pid);
    expect(f.spawnCount()).toBe(2);
    expect(
      f
        .requests()
        .filter((r) => r.method === "session/setModel")
        .at(-1).params.model,
    ).toMatchObject({ modelId: "new-model", providerId: "original-provider" });
  } finally {
    await f.close();
  }
});
