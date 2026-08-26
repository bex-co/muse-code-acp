import {
  client,
  ClientContext,
  methods,
  PROTOCOL_VERSION,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentConnection, Logger, MuseAcpAgent, MuseAgentOptions } from "../acp-agent.js";
import { museCliPath } from "../muse-cli.js";

export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function silentLogger(): Logger {
  return { log: () => {}, error: () => {} };
}

/** True when the real muse CLI is installed (live echo-provider tests). */
export function museAvailable(): boolean {
  try {
    museCliPath();
    return true;
  } catch {
    return false;
  }
}

/** The blocking fake `muse exec` used by deterministic cancellation tests. */
export function fakeMuseBinary(): string {
  const fakeMuse = join(fixturesDir, "fake-muse.cjs");
  chmodSync(fakeMuse, 0o755);
  return fakeMuse;
}

export interface TestClient {
  /** Every session/update notification the agent sent, in order. */
  updates: SessionNotification[];
  agent: MuseAcpAgent;
  /** Context for sending agent-side requests (initialize, session/new, …). */
  connect(): Promise<ClientContext>;
}

/**
 * Connects an in-process ACP client to a fresh agent instance. Drives the
 * real SDK connection layer (schema validation included) without a transport.
 */
export function connectTestClient(
  options: MuseAgentOptions = {},
  logger: Logger = silentLogger(),
): TestClient {
  const updates: SessionNotification[] = [];
  let resolveCtx!: (ctx: ClientContext) => void;
  const ctxPromise = new Promise<ClientContext>((resolve) => {
    resolveCtx = resolve;
  });

  const clientApp = client({ name: "test-client" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onConnect((conn) => resolveCtx(conn.agent));

  const { agent } = createAgentConnection(clientApp, logger, options);
  return { updates, agent, connect: () => ctxPromise };
}

export async function initialized(testClient: TestClient): Promise<ClientContext> {
  const ctx = await testClient.connect();
  await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
  return ctx;
}
