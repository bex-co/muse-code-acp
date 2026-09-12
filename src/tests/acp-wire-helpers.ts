/**
 * Spawned ACP stdio contract harness — drives `dist/index.js` over real NDJSON.
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
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fixturesDir } from "./helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const agentEntrypoint = join(repoRoot, "dist/index.js");

export interface WireTranscript {
  acpInbound: string[];
  mspRequests: unknown[];
  stderr: string;
}

export interface WireFixture {
  ctx: ClientContext;
  updates: SessionNotification[];
  workspace: string;
  getTranscript(): WireTranscript;
  dispose(): Promise<void>;
}

export interface WireOptions {
  backend?: "exec" | "sdk";
  fakeMspMode?: string;
  env?: Record<string, string | undefined>;
  /** Split each client→agent write in half to exercise NDJSON buffering. */
  fragmentWrites?: boolean;
}

/**
 * Launch the built ACP entrypoint with a fake MSP child and connect a real
 * ACP client over stdin/stdout NDJSON.
 */
export async function createWireFixture(options: WireOptions = {}): Promise<WireFixture> {
  const workspace = mkdtempSync(join(tmpdir(), "muse-acp-wire-"));
  const capture = join(workspace, "msp-requests.jsonl");
  const fakeMsp = join(fixturesDir, "fake-msp.cjs");
  chmodSync(fakeMsp, 0o755);

  const updates: SessionNotification[] = [];
  const acpInbound: string[] = [];
  let stderr = "";

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [agentEntrypoint], {
    cwd: workspace,
    env: {
      ...process.env,
      ...options.env,
      MUSE_CODE_ACP_BACKEND: options.backend ?? "sdk",
      MUSE_CODE_EXECUTABLE: fakeMsp,
      FAKE_MSP_MODE: options.fakeMspMode ?? "complete",
      FAKE_MSP_CAPTURE: capture,
      XDG_CONFIG_HOME: join(workspace, "config"),
      XDG_DATA_HOME: join(workspace, "data"),
      HOME: workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [stdoutForClient, stdoutForRecord] = (
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  ).tee();
  void recordLines(stdoutForRecord, acpInbound);

  let agentStdin: WritableStream<Uint8Array> = Writable.toWeb(child.stdin);
  if (options.fragmentWrites) {
    const writer = agentStdin.getWriter();
    agentStdin = new WritableStream<Uint8Array>({
      async write(chunk) {
        const mid = Math.max(1, Math.floor(chunk.byteLength / 2));
        await writer.write(chunk.slice(0, mid));
        await writer.write(chunk.slice(mid));
      },
      async close() {
        await writer.close();
      },
      abort(reason) {
        return writer.abort(reason);
      },
    });
  }

  let resolveCtx!: (ctx: ClientContext) => void;
  const ctxPromise = new Promise<ClientContext>((resolve) => {
    resolveCtx = resolve;
  });

  const connection = client({ name: "wire-test-client" })
    .onNotification(methods.client.session.update, (handlerCtx) => {
      updates.push(handlerCtx.params);
    })
    .onConnect((conn) => resolveCtx(conn.agent))
    .connect(ndJsonStream(agentStdin, stdoutForClient));

  const ctx = await Promise.race([
    ctxPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`wire connect timeout\nstderr:\n${stderr}`)), 10_000),
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
    workspace,
    getTranscript(): WireTranscript {
      try {
        const mspRequests = readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return { acpInbound: [...acpInbound], mspRequests, stderr };
      } catch {
        return { acpInbound: [...acpInbound], mspRequests: [], stderr };
      }
    },
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
        }, 2_000);
        child.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

async function recordLines(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        into.push(line);
      }
    }
  }
}
