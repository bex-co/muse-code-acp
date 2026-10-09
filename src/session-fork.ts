import { withSdkControlHost } from "./sdk-control-host.js";
import { MspError } from "@muse-code/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { realpathSync } from "node:fs";
import { assertSdkHostSupport } from "./muse-host.js";
import type { Logger } from "./logger.js";

interface ForkSessionMetadata {
  sessionId: string;
  workspaceRoot: string | null;
  modelId: string | null;
  activeTurnId: string | null;
  status: string;
  forkedFrom: { sessionId: string; cutCursor: string; cutExplicit: boolean } | null;
}
interface ForkResult {
  session: ForkSessionMetadata;
}

export const FORK_METADATA = "muse/fork";

export async function forkMuseSession(options: {
  sessionId: string;
  cwd: string;
  lastTurnId?: string;
  env: Record<string, string | undefined>;
  museBinary?: string;
  checkHost: boolean;
  logger: Logger;
  signal?: AbortSignal;
}): Promise<ForkResult> {
  if (options.checkHost) assertSdkHostSupport(options.env, options.museBinary);
  return withSdkControlHost(options, async ({ connection }, operation) => {
    let latestTurnId: string | undefined;
    try {
      const saved = await connection.command("session/read", {
        sessionId: options.sessionId,
        excludeItems: true,
      });
      const source = saved.session as ForkResult["session"] | undefined;
      latestTurnId = (saved as { lastTurn?: { turnId?: string } }).lastTurn?.turnId;
      if (
        !source ||
        source.sessionId !== options.sessionId ||
        !source.workspaceRoot ||
        realpathSync(source.workspaceRoot) !== realpathSync(options.cwd)
      )
        throw RequestError.invalidParams(undefined, "Fork source belongs to a different workspace");
      if (
        source.activeTurnId !== null ||
        source.status === "running" ||
        (Array.isArray(saved.pendingRequests) && saved.pendingRequests.length)
      )
        throw RequestError.invalidRequest(
          undefined,
          "Cannot fork an active session or pending interaction",
        );
      operation.enter("forking", 20_000);
      const result = (await connection.command("session/fork", {
        sessionId: options.sessionId,
        excludeItems: true,
        ...(options.lastTurnId ? { cutPoint: { lastTurnId: options.lastTurnId } } : {}),
      })) as unknown as ForkResult;
      const fork = result.session;
      if (
        !fork ||
        typeof fork.sessionId !== "string" ||
        !fork.sessionId ||
        fork.sessionId === options.sessionId ||
        !fork.workspaceRoot ||
        realpathSync(fork.workspaceRoot) !== realpathSync(options.cwd) ||
        fork.forkedFrom?.sessionId !== options.sessionId ||
        fork.activeTurnId !== null ||
        typeof fork.forkedFrom.cutCursor !== "string" ||
        fork.forkedFrom.cutExplicit !== !!options.lastTurnId ||
        (fork.modelId !== null && typeof fork.modelId !== "string")
      )
        throw new Error("Muse returned invalid fork metadata");
      if (fork.modelId !== source.modelId)
        throw new Error("Muse fork did not preserve the authoritative source model");
      return result;
    } catch (error) {
      if (error instanceof MspError) {
        // Muse 1.4.3 and 1.4.4 reject every completed turn but the latest as a boundary,
        // although its schema accepts any completed turn.
        if (
          error.kind === "forkBoundaryInvalid" &&
          latestTurnId &&
          options.lastTurnId !== latestTurnId
        )
          throw RequestError.invalidParams(
            undefined,
            `Muse fork rejected: forkBoundaryInvalid. The boundary must be a completed turn of this session, and some Muse hosts (observed on 1.4.3 and 1.4.4) accept only the latest one (${latestTurnId}); fork at that turn or fork the full session`,
          );
        if (["sessionNotFound", "notFound", "forkBoundaryInvalid"].includes(error.kind))
          throw RequestError.invalidParams(undefined, `Muse fork rejected: ${error.kind}`);
        throw RequestError.invalidRequest(undefined, `Muse fork unavailable (MSP ${error.code})`);
      }
      throw error;
    }
  });
}
