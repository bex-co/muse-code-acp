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
import { afterEach } from "vitest";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentConnection, Logger, MuseAcpAgent, MuseAgentOptions } from "../acp-agent.js";
import { museCliPath } from "../muse-cli.js";
import {
  atLeast,
  probeSdkHost,
  supportsCompaction,
  supportsGoalControls,
  supportsSessionCommands,
  supportsTaskControls,
} from "../muse-host.js";

const agents = new Set<MuseAcpAgent>();
afterEach(async () => {
  const owned = [...agents];
  agents.clear();
  await Promise.all(owned.map((agent) => agent.dispose()));
});

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

/** Host capabilities that gate live suites, with the version each was verified from. */
const HOST_CAPABILITIES = {
  // Muse's automated approval reviewer decides exec tool calls from 1.4.4.
  "exec-reviewer": (version: string | null | undefined) => atLeast(version, [1, 4, 4]),
  compaction: supportsCompaction,
  "goal-controls": supportsGoalControls,
  "session-commands": supportsSessionCommands,
  "task-controls": supportsTaskControls,
};
export type HostCapability = keyof typeof HOST_CAPABILITIES;

/**
 * Whether a capability-gated live suite runs on the installed host. Unsupported
 * capabilities skip, unless MUSE_CODE_ACP_REQUIRE_HOST_FEATURES names them
 * (comma-separated, or `all`): then the run fails instead, so a CI leg cannot
 * pass with the suites it exists to verify silently skipped.
 */
export function hostSupports(
  name: HostCapability,
  version: string | null | undefined = museAvailable() ? probeSdkHost().version : null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (HOST_CAPABILITIES[name](version)) return true;
  const required = (env.MUSE_CODE_ACP_REQUIRE_HOST_FEATURES ?? "").split(",").map((s) => s.trim());
  if (required.includes("all") || required.includes(name))
    throw new Error(
      `Muse host ${version ?? "(not found)"} lacks required capability "${name}" ` +
        "(MUSE_CODE_ACP_REQUIRE_HOST_FEATURES)",
    );
  return false;
}

/** The blocking fake `muse exec` used by deterministic cancellation tests. */
/**
 * Make a fixture executable without touching it when it already is: chmod
 * always bumps ctime, which is part of the Muse host identity, so a redundant
 * chmod from a parallel suite would look like a changed binary.
 */
export function ensureExecutable(path: string): void {
  if ((statSync(path).mode & 0o111) !== 0o111) chmodSync(path, 0o755);
}

export function fakeMuseBinary(): string {
  const fakeMuse = join(fixturesDir, "fake-muse.cjs");
  ensureExecutable(fakeMuse);
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

  // Fake hosts (host check skipped) default to no background prewarm: it
  // doubles fixture processes for every session, which starves suites with
  // short probe deadlines. prewarm.test.ts and real-host suites exercise it.
  const { agent } = createAgentConnection(clientApp, logger, {
    ...options,
    prewarm: options.prewarm ?? !options.skipSdkHostCheck,
  });
  agents.add(agent);
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
