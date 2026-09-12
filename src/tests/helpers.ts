import {
  client,
  ClientContext,
  CreateElicitationRequest,
  CreateElicitationResponse,
  methods,
  PROTOCOL_VERSION,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentConnection, Logger, MuseAcpAgent, MuseAgentOptions } from "../acp-agent.js";
import { museCliPath } from "../muse-cli.js";

export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function silentLogger(): Logger {
  return { log: () => {}, error: () => {} };
}

/** Logger that records log lines (e.g. to assert spawned argv). */
export function capturingLogger(lines: string[]): Logger {
  return { log: (...args) => lines.push(args.join(" ")), error: () => {} };
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

export type PermissionResponder = (
  params: RequestPermissionRequest,
) => RequestPermissionResponse | Promise<RequestPermissionResponse>;

export type ElicitationResponder = (
  params: CreateElicitationRequest,
) => CreateElicitationResponse | Promise<CreateElicitationResponse>;

export interface TestClient {
  /** Every session/update notification the agent sent, in order. */
  updates: SessionNotification[];
  /** Permission requests the agent sent to the client, in order. */
  permissionRequests: RequestPermissionRequest[];
  /** Elicitation requests the agent sent to the client, in order. */
  elicitationRequests: CreateElicitationRequest[];
  agent: MuseAcpAgent;
  setPermissionResponder(responder: PermissionResponder): void;
  setElicitationResponder(responder: ElicitationResponder): void;
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
  const permissionRequests: RequestPermissionRequest[] = [];
  const elicitationRequests: CreateElicitationRequest[] = [];
  let permissionResponder: PermissionResponder = () => ({
    outcome: { outcome: "cancelled" },
  });
  let elicitationResponder: ElicitationResponder = () => ({ action: "cancel" });
  let resolveCtx!: (ctx: ClientContext) => void;
  const ctxPromise = new Promise<ClientContext>((resolve) => {
    resolveCtx = resolve;
  });

  const clientApp = client({ name: "test-client" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      permissionRequests.push(ctx.params);
      return permissionResponder(ctx.params);
    })
    .onRequest(methods.client.elicitation.create, async (ctx) => {
      elicitationRequests.push(ctx.params);
      return elicitationResponder(ctx.params);
    })
    .onConnect((conn) => resolveCtx(conn.agent));

  const { agent } = createAgentConnection(clientApp, logger, options);
  return {
    updates,
    permissionRequests,
    elicitationRequests,
    agent,
    setPermissionResponder(responder) {
      permissionResponder = responder;
    },
    setElicitationResponder(responder) {
      elicitationResponder = responder;
    },
    connect: () => ctxPromise,
  };
}

export async function initialized(
  testClient: TestClient,
  clientCapabilities: Record<string, unknown> = { auth: { terminal: true } },
): Promise<ClientContext> {
  const ctx = await testClient.connect();
  await ctx.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities,
  });
  return ctx;
}

/** initialize + session/new in a fresh temp cwd — the common test opening. */
export async function newTestSession(
  testClient: TestClient,
  clientCapabilities?: Record<string, unknown>,
) {
  const ctx = await initialized(testClient, clientCapabilities);
  const cwd = mkdtempSync(join(tmpdir(), "muse-acp-test-"));
  const { sessionId, modes, configOptions } = await ctx.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
  });
  return { ctx, sessionId, cwd, modes, configOptions };
}
