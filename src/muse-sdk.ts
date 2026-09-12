import {
  ClientCapabilities,
  PromptResponse,
  RequestError,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  Connection,
  MuseClient,
  MspError,
  spawnMspConnection,
  readSessionDurability,
  isLaunchFailure,
  type TurnOutcome,
  type FoldedItem,
  type Session,
} from "@muse-code/sdk";
import packageJson from "../package.json" with { type: "json" };
import { realpathSync } from "node:fs";
import type { AcpClient } from "./acp-agent.js";
import { Logger } from "./logger.js";
import { museCliPath } from "./muse-cli.js";
import { assertSdkHostSupport, sdkHostExitMessage } from "./muse-host.js";
import {
  approvalToPermissionRequest,
  MuseApprovalRequest,
  PermissionLifecycle,
  resolvePermissionChoice,
} from "./muse-permissions.js";
import { MuseSdkTranslator } from "./muse-sdk-events.js";
import type { MuseInputPart } from "./prompt-content.js";
import {
  MuseUserInputRequest,
  settleUserInput,
  UserInputLifecycle,
  userInputToElicitation,
} from "./muse-user-input.js";
import { Pushable } from "./utils.js";

export interface MuseSdkOptions {
  sessionId: string;
  cwd: string;
  /** Ordered Muse turn input parts (text encodings of ACP content). */
  input: MuseInputPart[];
  model: string;
  reasoningEffort: string;
  readOnly: boolean;
  museBinary?: string;
  env: Record<string, string | undefined>;
  logger: Logger;
  /** When false, skip the serve --help probe (tests with fake-msp). */
  checkHost?: boolean;
  acpClient: AcpClient;
  clientCapabilities?: ClientCapabilities;
  /** Read cancelRequested from the ACP session while the turn runs. */
  isCancelled?: () => boolean;
}

export interface MuseSdkHandle {
  updates: AsyncIterable<SessionNotification>;
  done: Promise<PromptResponse>;
  kill(): void;
}

/** Read authoritative saved metadata without acquiring a writer lease. */
export async function readMuseSdkSession(
  options: Pick<
    MuseSdkOptions,
    "sessionId" | "cwd" | "env" | "museBinary" | "logger" | "checkHost"
  >,
): Promise<{ modelId: string | null }> {
  if (options.checkHost !== false) assertSdkHostSupport(options.env, options.museBinary);
  const handshake = spawnMspConnection({
    command: options.museBinary ?? museCliPath(options.env),
    args: ["serve"],
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    shutdownTimeoutMs: 1000,
    onStderr: (chunk) => options.logger.log(`muse-sdk read: ${chunk.trimEnd()}`),
  });
  const timer = setTimeout(() => {
    void handshake.close().catch(() => {});
  }, 20_000);
  try {
    const host = await handshake.initialize({
      clientInfo: { name: "muse_code_acp", version: packageJson.version },
    });
    const result = await host.connection.request("session/read", {
      sessionId: options.sessionId,
      excludeItems: true,
    });
    const session = result.session as
      | {
          sessionId: string;
          workspaceRoot: string | null;
          modelId: string | null;
          activeTurnId: string | null;
        }
      | undefined;
    if (
      !session ||
      session.sessionId !== options.sessionId ||
      (session.modelId !== null && typeof session.modelId !== "string")
    ) {
      throw new Error("Muse returned invalid saved session metadata");
    }
    if (
      session.workspaceRoot &&
      realpathSync(session.workspaceRoot) !== realpathSync(options.cwd)
    ) {
      throw new Error("Saved Muse session belongs to a different workspace");
    }
    if (
      session.activeTurnId ||
      (Array.isArray(result.pendingRequests) && result.pendingRequests.length)
    ) {
      throw new Error("Saved Muse session has an unfinished turn or pending input");
    }
    return { modelId: session.modelId };
  } finally {
    clearTimeout(timer);
    await handshake.close();
  }
}

/** Map ACP/muse effort labels onto the MSP values Session.sendUserTurn accepts. */
export function sdkReasoningEffort(
  effort: string | undefined,
): "low" | "medium" | "high" | undefined {
  if (!effort) {
    return undefined;
  }
  if (effort === "low" || effort === "medium" || effort === "high") {
    return effort;
  }
  if (effort === "none" || effort === "minimal") {
    return "low";
  }
  if (effort === "xhigh" || effort === "ultra") {
    return "high";
  }
  return undefined;
}

/**
 * One durable `muse serve` host per turn. MuseClient/Session own MSP framing,
 * fold routing, and turn waits; this adapter translates folded items into ACP
 * updates and maps terminals/errors to PromptResponse / RequestError.
 */
export function spawnMuseSdkTurn(options: MuseSdkOptions): MuseSdkHandle {
  if (options.checkHost !== false) {
    assertSdkHostSupport(options.env, options.museBinary);
  }
  const updates = new Pushable<SessionNotification>();
  const translator = new MuseSdkTranslator(options.sessionId, options.logger);
  const permissions = new PermissionLifecycle();
  const userInputs = new UserInputLifecycle();
  const args = ["serve", ...(options.readOnly ? ["--disable-write", "--disable-shell"] : [])];
  const binary = options.museBinary ?? museCliPath(options.env);
  options.logger.log(`muse-sdk spawn: ${binary} ${args.join(" ")}`);

  let client: MuseClient | undefined;
  let connection: Connection | undefined;
  let turnId: string | undefined;
  let generation = 0;
  let cancelled = false;
  let finished = false;
  let settled = false;
  let stopInteractions!: () => void;
  const interactionsStopped = new Promise<null>((resolve) => {
    stopInteractions = () => resolve(null);
  });
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let failTurn!: (error: unknown) => void;
  const turnFailure = new Promise<never>((_, reject) => {
    failTurn = reject;
  });
  void turnFailure.catch(() => {});

  const handshake = spawnMspConnection({
    command: binary,
    args,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    shutdownTimeoutMs: 1_000,
    onStderr: (chunk) => options.logger.log(`muse-sdk stderr: ${chunk.trimEnd()}`),
  });

  const close = async () => {
    permissions.disposeAll();
    userInputs.disposeAll();
    if (client) {
      await client.close().catch(() => {});
      return;
    }
    await handshake.close().catch(() => {});
  };

  const startupTimer = setTimeout(() => {
    failTurn(new Error("Muse SDK startup timed out"));
    void close();
  }, 20_000);

  function kill(): void {
    if (cancelled || finished) {
      return;
    }
    cancelled = true;
    stopInteractions();
    if (turnId) {
      permissions.disposeTurn(turnId);
      userInputs.disposeTurn(turnId);
    }
    if (connection && turnId) {
      void connection
        .command("turn/cancel", { sessionId: options.sessionId, turnId }, { maxAttempts: 1 })
        .catch(() => close());
      cancelTimer = setTimeout(() => void close(), 5_000);
    } else {
      void close();
    }
  }

  const done = (async (): Promise<PromptResponse> => {
    try {
      const host = await handshake.initialize({
        clientInfo: { name: "muse_code_acp", version: packageJson.version },
      });
      if (host.fingerprintWarning) {
        options.logger.log(`muse-sdk: ${host.fingerprintWarning.message}`);
      }
      connection = host.connection;
      client = new MuseClient(host.connection, {
        durability: readSessionDurability(host.initializeResult),
        host,
      });

      void host.child.exit.then((exit) => {
        if (finished || cancelled) {
          return;
        }
        if (exit.kind === "sdkSurfaceUnavailable") {
          failTurn(
            new Error(
              sdkHostExitMessage(exit.stderrTail.join("\n")) ??
                "the experimental SDK tier is disabled",
            ),
          );
          return;
        }
        if (exit.kind !== "cleanShutdown") {
          failTurn(new Error(`Muse SDK host exited abnormally (${exit.kind})`));
        }
      });

      let session: Session;
      let startedFresh = false;
      try {
        session = await client.resumeSession({
          sessionId: options.sessionId,
          excludeItems: true,
        });
      } catch (error) {
        if (!(error instanceof MspError) || error.code !== -32020) {
          throw error;
        }
        session = await client.startSession({
          sessionId: options.sessionId,
          workspaceRoot: options.cwd,
          modelId: options.model,
          // Force client gating for unmatched/protected tools over ACP.
          approvalMode: "onRequest",
        });
        startedFresh = true;
      }

      // Resume path must still select onRequest; fresh start already did.
      if (!startedFresh) {
        await connection.command("session/setApprovalMode", {
          sessionId: options.sessionId,
          mode: "onRequest",
        });
      }

      const opening = session.opening;
      const openedSession =
        opening?.verb === "session/resume"
          ? opening.result.session
          : opening?.verb === "session/start"
            ? opening.result.session
            : undefined;
      if (!openedSession || openedSession.sessionId !== options.sessionId) {
        throw new Error("Muse SDK returned a different session ID");
      }
      if (
        openedSession.workspaceRoot &&
        realpathSync(openedSession.workspaceRoot) !== realpathSync(options.cwd)
      ) {
        throw new Error("Muse SDK cannot switch a saved session to a different workspace");
      }
      const pending =
        opening?.verb === "session/resume" ? (opening.result.pendingRequests ?? []) : [];
      if (openedSession.activeTurnId || pending.length > 0) {
        throw new Error(
          "The saved Muse session has an unfinished turn or pending input; resolve it in Muse before continuing",
        );
      }
      if (openedSession.modelId !== options.model) {
        await connection.command("session/setModel", {
          sessionId: options.sessionId,
          model: { modelId: options.model },
        });
      }

      const adoptTurn = (nextTurnId: string) => {
        if (turnId === nextTurnId && generation > 0) {
          return;
        }
        turnId = nextTurnId;
        generation = permissions.beginTurn(nextTurnId);
        userInputs.beginTurn(nextTurnId);
      };

      session.onApproval(async (request) => {
        if (cancelled || options.isCancelled?.()) {
          throw new Error("permission request cancelled");
        }
        const approval = request as unknown as MuseApprovalRequest;
        // Approvals can arrive before turn/start acknowledgement.
        if (turnId && approval.turnId !== turnId) {
          throw new Error("stale approval for a different turn");
        }
        adoptTurn(approval.turnId);
        const approvalGeneration = generation;
        if (
          !permissions.track(
            approval.approvalId,
            approval.turnId,
            approval.toolCallId,
            approvalGeneration,
          )
        ) {
          throw new Error("stale approval after turn disposal");
        }
        try {
          const response = await Promise.race([
            options.acpClient.requestPermission(
              approvalToPermissionRequest(options.sessionId, approval),
            ),
            interactionsStopped,
          ]);
          if (!response) {
            throw new Error("permission request ended with its turn");
          }
          if (!permissions.isLive(approval.approvalId, approval.turnId, approvalGeneration)) {
            throw new Error("stale permission response");
          }
          if (cancelled || options.isCancelled?.()) {
            throw new Error("permission request cancelled");
          }
          return { choiceId: resolvePermissionChoice(approval, response) };
        } finally {
          permissions.resolve(approval.approvalId);
        }
      });
      session.onApprovalError((failure) => {
        if (cancelled || options.isCancelled?.()) {
          return;
        }
        failTurn(
          failure.kind === "handlerThrew"
            ? failure.error
            : new Error(`Muse approval round-trip failed (${failure.kind})`),
        );
      });
      // Gap fill runs automatically on wired Sessions. Only hard fill failures
      // become turn errors; recoverable gaps must not abort the prompt.
      session.onGapError((error) => {
        if (cancelled || options.isCancelled?.()) {
          return;
        }
        failTurn(
          new Error(
            `Muse SDK gap fill failed (${error.reason}); reload the session before continuing`,
          ),
        );
      });

      if (cancelled || options.isCancelled?.()) {
        return { stopReason: "cancelled" };
      }

      const turn = await session.sendUserTurn({
        input: options.input,
        ...(sdkReasoningEffort(options.reasoningEffort)
          ? { reasoningEffort: sdkReasoningEffort(options.reasoningEffort)! }
          : {}),
      });
      adoptTurn(turn.turnId);
      clearTimeout(startupTimer);

      const emitItem = (item: FoldedItem) => {
        // Hold publication while a gap fill is reconstituting the fold.
        if (!session.fold.current) {
          return;
        }
        for (const update of translator.fromItem(item)) {
          updates.push(update);
        }
      };

      const emitCaughtUp = (item: FoldedItem, accumulated: string): void => {
        emitItem(item);
        const base = item.text ?? "";
        if (!accumulated || accumulated === base) {
          return;
        }
        const delta =
          accumulated.startsWith(base) && accumulated.length > base.length
            ? accumulated.slice(base.length)
            : !base
              ? accumulated
              : "";
        if (!delta) {
          return;
        }
        for (const update of translator.fromDelta({ itemId: item.itemId, delta })) {
          updates.push(update);
        }
      };

      const flushFold = () => {
        if (!session.fold.current) {
          return;
        }
        for (const held of session.fold.items.list()) {
          if (held.turnId === turn.turnId) {
            emitCaughtUp(held, session.fold.items.accumulated(held.itemId) ?? "");
          }
        }
      };

      const handlePendingUserInputs = async () => {
        for (const pendingInput of session.fold.pendingUserInputs()) {
          const request = pendingInput as unknown as MuseUserInputRequest & {
            userInputId: string;
            turnId: string;
          };
          if (request.turnId !== turnId) {
            continue;
          }
          if (userInputs.has(request.userInputId)) {
            continue;
          }
          if (!userInputs.track(request.userInputId, turnId!, generation)) {
            continue;
          }
          const support = options.clientCapabilities?.elicitation;
          const formOk = support?.form != null;
          if (!formOk || !connection) {
            // Reject the ACP prompt first so turn/completed from cancel cannot
            // win Promise.race and report a successful end_turn.
            failTurn(
              new Error(
                "Muse requested user input but the ACP client did not advertise form elicitation",
              ),
            );
            await connection
              ?.command(
                "userInput/cancel",
                {
                  sessionId: options.sessionId,
                  userInputId: request.userInputId,
                  reason: "client has no form elicitation support",
                },
                { maxAttempts: 1 },
              )
              .catch(() => {});
            userInputs.resolve(request.userInputId);
            return;
          }
          try {
            if (cancelled || options.isCancelled?.()) {
              await settleUserInput(connection, options.sessionId, request, {
                action: "cancel",
              });
              return;
            }
            const response = await Promise.race([
              options.acpClient.createElicitation(
                userInputToElicitation(options.sessionId, request),
              ),
              interactionsStopped,
            ]);
            if (!response || !userInputs.isLive(request.userInputId, turnId!, generation)) {
              return;
            }
            await settleUserInput(connection, options.sessionId, request, response);
          } catch (error) {
            // Invalid answers and failed client RPCs must fail the prompt, not
            // silently terminate a pump while Muse waits forever for input.
            failTurn(error);
            await connection
              .command(
                "userInput/cancel",
                {
                  sessionId: options.sessionId,
                  userInputId: request.userInputId,
                  reason: "client input failed validation or delivery",
                },
                { maxAttempts: 1 },
              )
              .catch(() => {});
            return;
          } finally {
            userInputs.resolve(request.userInputId);
          }
        }
      };

      // deltas() is live-only; catch up anything folded before the turn ack.
      flushFold();

      let foldWasCurrent = session.fold.current;
      const pumpItems = (async () => {
        for await (const item of turn.items()) {
          await handlePendingUserInputs();
          // Replay held items only when a gap fill restores currency.
          if (!foldWasCurrent && session.fold.current) {
            flushFold();
          }
          foldWasCurrent = session.fold.current;
          emitItem(item);
        }
      })();
      const pumpDeltas = (async () => {
        for await (const delta of turn.deltas()) {
          if (!session.fold.current) {
            continue;
          }
          for (const update of translator.fromDelta(delta)) {
            updates.push(update);
          }
        }
      })();
      const pumpUserInput = (async () => {
        while (!finished && !settled && !cancelled) {
          await handlePendingUserInputs();
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();
      // Observe pump failures immediately, before waiting for turn completion.
      void pumpItems.catch(failTurn);
      void pumpDeltas.catch(failTurn);
      void pumpUserInput.catch(failTurn);

      const outcome = await Promise.race([turn.completed, turnFailure]);
      settled = true;
      stopInteractions();
      await Promise.all([
        pumpItems.catch(() => {}),
        pumpDeltas.catch(() => {}),
        pumpUserInput.catch(() => {}),
      ]);
      // Flush any items that arrived only through gap fill after the last yield.
      flushFold();
      return terminalResponse(outcome);
    } catch (error) {
      if (cancelled || options.isCancelled?.()) {
        return { stopReason: "cancelled" };
      }
      if (error instanceof RequestError) {
        throw error;
      }
      const stderr = handshake.child.stderrTail.join("\n").trim();
      const mapped = sdkHostExitMessage(stderr);
      throw RequestError.internalError(
        undefined,
        `Muse SDK turn failed: ${mapped ?? (error instanceof Error ? error.message : String(error))}` +
          (stderr && !mapped ? `\n${stderr}` : ""),
      );
    } finally {
      finished = true;
      stopInteractions();
      clearTimeout(startupTimer);
      clearTimeout(cancelTimer);
      if (turnId) {
        permissions.disposeTurn(turnId);
        userInputs.disposeTurn(turnId);
      }
      await close();
      updates.end();
    }
  })();
  void done.catch(() => {});
  return { updates, done, kill };
}

function terminalResponse(outcome: TurnOutcome): PromptResponse {
  if (outcome.kind === "terminalUnknown") {
    throw RequestError.internalError(
      undefined,
      "Muse SDK host died before the turn completed; reload the session",
    );
  }
  if (outcome.kind === "unqueued") {
    throw RequestError.internalError(undefined, "Muse SDK turn was unqueued before launch");
  }
  if (isLaunchFailure(outcome)) {
    throw RequestError.internalError(undefined, "Muse SDK failed to launch the turn");
  }
  const params = outcome.params;
  if (params.terminal === "completed") {
    return { stopReason: "end_turn" };
  }
  if (params.terminal === "cancelled") {
    return { stopReason: "cancelled" };
  }
  if (params.error?.kind === "stepLimit") {
    return { stopReason: "max_turn_requests" };
  }
  const detail = params.error?.message ?? params.reason ?? params.terminal;
  if (params.error?.kind === "authRequired") {
    throw RequestError.authRequired(undefined, `${detail}. Run muse login or set META_API_KEY.`);
  }
  throw RequestError.internalError(undefined, `Muse SDK turn ${params.terminal}: ${detail}`);
}
