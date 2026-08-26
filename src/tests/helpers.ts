import {
  client,
  ClientContext,
  methods,
  PROTOCOL_VERSION,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { createAgentConnection, Logger, MuseAcpAgent, MuseAgentOptions } from "../acp-agent.js";

export function silentLogger(): Logger {
  return { log: () => {}, error: () => {} };
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
