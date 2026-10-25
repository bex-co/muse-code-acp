import { describe, expect, it } from "vitest";
import { spawnMspConnection } from "@muse-code/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { museCliPath } from "../muse-cli.js";
import { FORK_BIRTH_TIME_ERROR, forkUnavailable } from "./acp-real-host-helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";
import { connectTestClient, initialized, museAvailable, silentLogger } from "./helpers.js";
const available = museAvailable();
if (process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1" && !available)
  throw new Error("Muse required for session discovery acceptance");
describe.skipIf(!available)("real Muse public session discovery", () => {
  it("paginates source/fork sessions without leases and preserves full load history", async () => {
    const provider = await startLoopbackProvider({
      scriptedToolCallWhen: ["never-script"],
      scriptedToolCallCommand: "",
      holdMs: 10,
    });
    const cwd = realpathSync(provider.root);
    const env = {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    };
    const host = spawnMspConnection({
      command: museCliPath(),
      args: ["serve"],
      cwd,
      env: env as Record<string, string>,
      shutdownTimeoutMs: 1000,
    });
    let extraHost: ReturnType<typeof spawnMspConnection> | undefined;
    const client = connectTestClient({ backend: "sdk", env }, silentLogger());
    try {
      const { connection } = await host.initialize({
        clientInfo: { name: "discovery_test", version: "1" },
      });
      // Muse discards a session with no completed turn when its host closes, and
      // other processes see such sessions only partially while it runs (observed
      // on 1.1.1 and 1.4.7). Every listed session is therefore durable: one turn,
      // or a fork of a session that has one. Muse 1.1.1 holds about 32 loaded
      // sessions per host, so a second host creates half of them.
      type MspConnection = typeof connection;
      const completions = new Map<string, () => void>();
      const durableSession = async (conn: MspConnection, text: string) => {
        conn.onNotification((n) => {
          if (n.method === "turn/completed")
            completions.get((n.params as { sessionId: string }).sessionId)?.();
        });
        const started = await conn.command("session/start", {
          workspaceRoot: cwd,
          modelId: "fake-model",
        });
        const sessionId = (started.session as { sessionId: string }).sessionId;
        const completed = new Promise<void>((resolve) => completions.set(sessionId, resolve));
        await conn.command("turn/start", { sessionId, input: [{ type: "text", text }] });
        await completed;
        return sessionId;
      };
      const forks = async (conn: MspConnection, sessionId: string, count: number) => {
        for (let i = 0; i < count; i++) await conn.command("session/fork", { sessionId });
      };
      const source = await durableSession(connection, "discovery original marker");
      if (forkUnavailable()) {
        await expect(connection.command("session/fork", { sessionId: source })).rejects.toThrow(
          FORK_BIRTH_TIME_ERROR,
        );
        return;
      }
      const fork = await connection.command("session/fork", { sessionId: source });
      const forkId = (fork.session as { sessionId: string }).sessionId;
      await forks(connection, source, 25);
      extraHost = spawnMspConnection({
        command: museCliPath(),
        args: ["serve"],
        cwd,
        env: env as Record<string, string>,
        shutdownTimeoutMs: 1000,
      });
      const extra = await extraHost.initialize({
        clientInfo: { name: "discovery_fixture", version: "1" },
      });
      await forks(extra.connection, await durableSession(extra.connection, "second host"), 24);
      // Close the writers so everything is persisted. Each adapter listing starts
      // a fresh discovery host; poll until Muse's eventually consistent index
      // (docs/session-discovery.md) includes every session.
      await extraHost.close();
      await host.close();
      const settle = { timeout: 30_000, interval: 500 };
      const ctx = await initialized(client, { _meta: { "muse/fork": 1 } });
      const list = (cursor?: string | null) =>
        ctx.request(methods.agent.session.list, { cwd, ...(cursor ? { cursor } : {}) });
      let first = await list();
      await expect
        .poll(async () => {
          first = await list();
          return first.nextCursor ? first.sessions.length : 0;
        }, settle)
        .toBe(50);
      const second = await list(first.nextCursor);
      expect(second.sessions).toHaveLength(2);
      expect(second.nextCursor).toBeUndefined();
      const all = [...first.sessions, ...second.sessions];
      expect(new Set(all.map((s) => s.sessionId)).size).toBe(52);
      expect(all.find((s) => s.sessionId === source)?.title).toBe("discovery original marker");
      expect(all.find((s) => s.sessionId === forkId)?._meta).toMatchObject({
        "muse/fork": { sourceSessionId: source },
      });
      const before = provider.requests().length;
      await ctx.request(methods.agent.session.load, { sessionId: source, cwd, mcpServers: [] });
      expect(
        client.updates.filter((n) => n.update.sessionUpdate === "user_message_chunk"),
      ).toHaveLength(1);
      expect(
        client.updates.some(
          (n) =>
            n.update.sessionUpdate === "session_info_update" &&
            n.update.title === "discovery original marker",
        ),
      ).toBe(true);
      expect(provider.requests()).toHaveLength(before);
    } finally {
      await client.agent.dispose();
      await host.close();
      await extraHost?.close();
      await provider.close();
      rmSync(provider.root, { recursive: true, force: true });
    }
  }, 120_000);
});
