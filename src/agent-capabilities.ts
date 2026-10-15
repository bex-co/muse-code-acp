import {
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import packageJson from "../package.json" with { type: "json" };
import type { MuseAgentOptions } from "./agent-types.js";
import { ASYNC_TASKS, TASK_METHOD } from "./async-tasks.js";
import { AUTH_EXTENSION, museAuthMethods } from "./auth.js";
import { PROVIDER_EXTENSION, RECOMMENDATION_EXTENSION } from "./client-provider.js";
import { FILE_REPORT_CAPABILITIES, supportsFileReport } from "./file-change-evidence.js";
import { probeSdkHost } from "./muse-host.js";
import { FORK_METADATA } from "./session-fork.js";
import { USAGE_EXTENSION } from "./session-progress.js";
import { SESSION_STATE_EXTENSION } from "./session-state-observer.js";
import {
  STEER_METHOD,
  STEERING_CAPABILITY,
  supportsCompatibleSteering,
  supportsSteering,
} from "./steering-protocol.js";
import {
  MAX_OUTPUT_READ,
  OUTPUT_EXTENSION,
  OUTPUT_METHOD,
  supportsStoredOutput,
} from "./stored-output.js";

/** Host checks the advertisement needs; each runs only where the original did. */
export interface CapabilityHost {
  supportsFork(): boolean;
  goalControlsAvailable(): boolean;
  authStatus(): object;
}

/**
 * The `initialize` response: standard capabilities plus each negotiated
 * `muse/*` extension the client asked for and this backend and host support.
 */
export function initializeResponse(
  clientCapabilities: ClientCapabilities,
  backend: "exec" | "sdk",
  options: MuseAgentOptions,
  host: CapabilityHost,
): InitializeResponse {
  const authMethods = museAuthMethods({
    includeTerminal: clientCapabilities.auth?.terminal === true,
  });
  const forkSupported = host.supportsFork();
  return {
    protocolVersion: PROTOCOL_VERSION,
    // Only advertise what is actually implemented; capabilities grow with
    // the milestones that ship them. Images work on both backends.
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: backend === "sdk" ? { http: true } : {},
      loadSession: true,
      sessionCapabilities: {
        list: {},
        close: {},
        resume: {},
        ...(forkSupported ? { fork: {} } : {}),
      },
      auth: { logout: {} },
    },
    authMethods,
    agentInfo: {
      name: packageJson.name,
      version: packageJson.version,
    },
    _meta: {
      ...(backend === "sdk" &&
      clientCapabilities._meta?.[OUTPUT_EXTENSION] === 1 &&
      supportsStoredOutput(probeSdkHost(options.env, options.museBinary).version)
        ? {
            [OUTPUT_EXTENSION]: {
              version: 1,
              method: OUTPUT_METHOD,
              maxLengthBytes: MAX_OUTPUT_READ,
            },
          }
        : {}),
      ...(backend === "sdk" && supportsCompatibleSteering(clientCapabilities)
        ? { steering: { supported: true, idle: "reject", targeting: "active-at-admission" } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.[ASYNC_TASKS] === 1
        ? { [ASYNC_TASKS]: { version: 1, method: TASK_METHOD, actionsPerTask: true } }
        : {}),
      ...(clientCapabilities._meta?.[AUTH_EXTENSION] === 1
        ? { [AUTH_EXTENSION]: { version: 1, ...host.authStatus() } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.[PROVIDER_EXTENSION] === 1
        ? {
            [PROVIDER_EXTENSION]: {
              version: 1,
              providerIds: ["meta"],
              credentials: "session-only",
              endpointChanges: "new-session",
            },
          }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.[RECOMMENDATION_EXTENSION] === 1
        ? { [RECOMMENDATION_EXTENSION]: { version: 1 } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.[SESSION_STATE_EXTENSION] === 1
        ? { [SESSION_STATE_EXTENSION]: { version: 1, reportingOnly: true } }
        : {}),
      ...(backend === "sdk" && supportsFileReport(clientCapabilities)
        ? FILE_REPORT_CAPABILITIES
        : {}),
      ...(forkSupported && clientCapabilities._meta?.[FORK_METADATA] === 1
        ? { [FORK_METADATA]: { version: 1, completedTurnBoundary: true } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.["muse/review"] === 1
        ? { "muse/review": { version: 1 } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.["muse/approval"] === 1
        ? { "muse/approval": { version: 1 } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.["muse/goal"] === 1
        ? {
            "muse/goal": {
              version: 1,
              observation: true,
              controls: host.goalControlsAvailable()
                ? ["set", "edit", "pause", "resume", "clear"]
                : [],
            },
          }
        : {}),
      ...(backend === "sdk" && supportsSteering(clientCapabilities)
        ? { [STEERING_CAPABILITY]: { version: 1, method: STEER_METHOD } }
        : {}),
      ...(backend === "sdk" && clientCapabilities._meta?.[USAGE_EXTENSION] === 1
        ? { [USAGE_EXTENSION]: { version: 1, scope: "rootSession", cumulative: true } }
        : {}),
      "bex.security/capabilities": {
        delegatedWorkers: false,
        usage: backend === "sdk" ? "observed" : "unavailable",
        interactivePermissions: backend === "sdk",
      },
    },
  };
}
