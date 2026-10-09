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
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { expect } from "vitest";
import { museCliPath } from "../muse-cli.js";
import { Readable, Writable } from "node:stream";
import { agentEntrypoint } from "./acp-wire-helpers.js";

/**
 * w2/m2: these exact hosts cannot compose legacy :auto-review profiles in serve.
 * Builds stay enumerated so an unlisted host is expected to succeed — that is how
 * 1.3.0-R3057.1 and then 1.3.0-R3401.1 were caught still reproducing it.
 * R3401.1 also refuses the lease-free session/read, so load itself fails there,
 * and so does 1.4.3-R5018.1 (w3/m2), whose `muse exec` commits :auto-review by default.
 */
const LEGACY_PROFILE_LIMITED = [
  "(1.2.1-R2847.1)",
  "(1.3.0-R3057.1)",
  "(1.3.0-R3401.1)",
  "(1.4.3-R5018.1)",
  "(1.4.4-R5419.1)",
];
const LEGACY_PROFILE_READ_REFUSED = ["(1.3.0-R3401.1)", "(1.4.3-R5018.1)", "(1.4.4-R5419.1)"];
const LEGACY_PROFILE_ERROR = {
  code: -32603,
  message: expect.stringContaining(
    "This Muse host cannot resume a saved session using the :auto-review permission profile",
  ),
};
/**
 * w3/m2: these hosts accept only the latest completed turn as a fork boundary,
 * although their schema documents any completed turn. Enumerated like the above.
 */
const FORK_CUT_LATEST_ONLY = ["(1.4.3-R5018.1)", "(1.4.4-R5419.1)"];
export const forkCutLatestOnly = () =>
  FORK_CUT_LATEST_ONLY.some((build) => museVersion().includes(build));
const museVersion = () =>
  spawnSync(museCliPath(), ["--version"], { encoding: "utf8" }).stdout ?? "";

/** Resolves true when the legacy session loaded and the continuation steps should run. */
export async function expectLegacyLoad(load: Promise<unknown>): Promise<boolean> {
  const version = museVersion();
  if (LEGACY_PROFILE_READ_REFUSED.some((build) => version.includes(build))) {
    await expect(load).rejects.toMatchObject(LEGACY_PROFILE_ERROR);
    return false;
  }
  await load;
  return true;
}

export async function expectLegacyContinuation(prompt: Promise<unknown>): Promise<void> {
  const version = museVersion();
  if (LEGACY_PROFILE_LIMITED.some((build) => version.includes(build))) {
    await expect(prompt).rejects.toMatchObject(LEGACY_PROFILE_ERROR);
  } else {
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  }
}

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
