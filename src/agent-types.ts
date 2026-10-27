import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { SessionConfig } from "./config-options.js";
import type { GoalObservation } from "./goal-state.js";
import type { MuseMcpOverlay } from "./mcp-overlay.js";
import type { ModelDiscoveryResult } from "./model-discovery.js";
import type { MuseModeId } from "./modes.js";
import type { MuseExecHandle } from "./muse-exec.js";
import type { MuseSdkHandle, MuseSdkHost } from "./muse-sdk.js";
import type { SessionProgress } from "./session-progress.js";
import type { SteeringQueue } from "./steering-queue.js";
import type { FailureObservation } from "./turn-failure.js";

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * `ClientConnection` (acp-agent.ts) over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export interface SessionState {
  authObservation?: "unknown" | "acceptedForTurn" | "rejected";
  latestFailure?: FailureObservation | null;
  /** Working directory every Muse turn for this session runs in. */
  cwd: string;
  /** The Muse session id; minted by us and identical to the ACP session id. */
  museSessionId: string;
  /** Live CLI or SDK turn, including its owned Muse child process. */
  activeTurn: MuseExecHandle | MuseSdkHandle | null;
  /** Set by `session/cancel`; forces the turn to settle with `cancelled`. */
  cancelRequested: boolean;
  turnFinished: Promise<void> | null;
  safetyChanging?: boolean;
  /** Active ACP session mode; decides the safety flags of the next spawn. */
  modeId: MuseModeId;
  /** Model + reasoning effort applied to every spawn for this session. */
  config: SessionConfig;
  modelDiscovery?: ModelDiscoveryResult;
  /** A `/rename` made while no host was open; applied when the next turn opens one. */
  pendingNativeName?: string;
  /** The model is the built-in default: no settings named one and no turn or selection used it. */
  builtInModel?: boolean;
  modelRefresh?: { dispose(): Promise<void> };
  /** Canonical extra workspace roots (ACP additionalDirectories), sent with every turn. */
  additionalDirectories: string[];
  /** ACP-provided MCP servers injected into Muse for each turn. */
  mcpServers: McpServer[];
  mcpFailure?: string;
  goal?: GoalObservation;
  progress?: SessionProgress;
  /** Live per-turn Muse configuration overlay, if this session uses MCP. */
  activeMcpOverlay: MuseMcpOverlay | null;
  sdkHost?: { owner: MuseSdkHost; identity: string; overlay: MuseMcpOverlay };
  steering?: SteeringQueue<MuseSdkHandle, { turnId: string; status: string }>;
}

/**
 * Engine knobs threaded into every `muse exec` spawn. Production leaves them
 * empty (muse's own defaults + user settings apply); tests inject the echo
 * provider, a fake binary, and an isolated XDG data dir.
 */
export interface MuseAgentOptions {
  /** Opt-in SDK migration; the CLI backend remains the default. */
  backend?: "exec" | "sdk";
  museBinary?: string;
  provider?: "meta" | "echo";
  env?: Record<string, string | undefined>;
  /** Tests with fake-msp skip the real `muse serve --help` probe. */
  skipSdkHostCheck?: boolean;
  /** Open each session's Muse host in the background (default true). */
  prewarm?: boolean;
}
