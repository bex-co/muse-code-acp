/**
 * Spawn the built ACP entrypoint against a real Muse binary (no fake MSP).
 */
import {
  client,
  ClientContext,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { agentEntrypoint } from "./acp-wire-helpers.js";

export interface RealHostAgent {
  ctx: ClientContext;
  updates: SessionNotification[];
  dispose(): Promise<void>;
}

export async function spawnAcpAgent(options: {
  env: Record<string, string | undefined>;
  cwd: string;
}): Promise<RealHostAgent> {
  const updates: SessionNotification[] = [];
  let stderr = "";
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [agentEntrypoint], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      MUSE_CODE_ACP_BACKEND: "sdk",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let resolveCtx!: (ctx: ClientContext) => void;
  const ctxPromise = new Promise<ClientContext>((resolve) => {
    resolveCtx = resolve;
  });

  const connection = client({ name: "real-host-test-client" })
    .onNotification(methods.client.session.update, (handlerCtx) => {
      updates.push(handlerCtx.params);
    })
    .onConnect((conn) => resolveCtx(conn.agent))
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));

  const ctx = await Promise.race([
    ctxPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`real-host connect timeout\nstderr:\n${stderr}`)), 20_000),
    ),
  ]);

  await ctx.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { auth: { terminal: true } },
  });

  let disposed = false;
  return {
    ctx,
    updates,
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        connection.close();
      } catch {
        // ignore
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3_000);
        child.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
