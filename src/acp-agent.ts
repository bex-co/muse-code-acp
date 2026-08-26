import {
  agent as acpAgent,
  AgentContext,
  CancelNotification,
  ClientApp,
  InitializeRequest,
  InitializeResponse,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  PROTOCOL_VERSION,
  RequestError,
  SessionNotification,
  Stream,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { Logger } from "./logger.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";

export type { Logger } from "./logger.js";

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
}

/**
 * Bridges {@link AcpClient} to the connection-scoped {@link AgentContext}. The
 * peer handle is valid for the entire connection lifetime, so it is captured
 * once at construction. All agent→client traffic funnels through here.
 */
class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params);
  }
}

export interface SessionState {
  /** Working directory every `muse exec` turn for this session runs in. */
  cwd: string;
  /** The muse `--session-id`; minted by us and identical to the ACP session id. */
  museSessionId: string;
}

export class MuseAcpAgent {
  readonly sessions = new Map<string, SessionState>();

  constructor(
    readonly client: AcpClient,
    readonly logger: Logger = console,
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      // Only advertise what is actually implemented; capabilities grow with
      // the milestones that ship them.
      agentCapabilities: {
        promptCapabilities: {},
      },
      agentInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        undefined,
        `cwd must be an absolute path, got "${params.cwd}"`,
      );
    }
    // The ACP session id doubles as the muse `--session-id`. Muse creates its
    // on-disk session log lazily on the first exec, so nothing is spawned here.
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { cwd: params.cwd, museSessionId: sessionId });
    return { sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.requireSession(params.sessionId);
    throw RequestError.internalError(undefined, "session/prompt not implemented yet (w1/m1/t005)");
  }

  async cancel(params: CancelNotification): Promise<void> {
    // No active turn tracking yet (w1/m1/t005); a cancel with no live turn is a no-op.
    this.requireSession(params.sessionId);
  }

  requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(undefined, `unknown session: ${sessionId}`);
    }
    return session;
  }

  async dispose(): Promise<void> {
    // Live children are reaped here once prompt turns exist (w1/m1/t005).
  }
}

/**
 * Builds the ACP agent app and connects it to `target` (a transport stream in
 * production, a `ClientApp` for in-process tests). The handlers close over
 * `agent`, which is assigned synchronously right after `connect()` returns —
 * before the connection processes any inbound message.
 */
export function createAgentConnection(target: Stream | ClientApp, logger: Logger = console) {
  // eslint-disable-next-line prefer-const
  let agent: MuseAcpAgent;
  const connection = acpAgent({ name: "muse-code-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(target as Stream);

  agent = new MuseAcpAgent(new ClientConnection(connection.client), logger);
  return { connection, agent };
}

export function runAcp(logger?: Logger) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  return createAgentConnection(stream, logger);
}
