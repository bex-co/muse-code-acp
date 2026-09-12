import {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { TOOL_KINDS } from "./tool-calls.js";
import { TurnScopedLifecycle } from "./turn-lifecycle.js";

/** Minimal MSP approval choice fields used by the ACP bridge. */
export interface MuseApprovalChoice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
}

export interface MuseApprovalRequest {
  approvalId: string;
  availableChoices: MuseApprovalChoice[];
  currentRequirementId: { approvalId: string; sourceIndex: number };
  itemId: string;
  rawArgs: string;
  toolCallId: string;
  toolName: string;
  turnId: string;
  taskId?: string;
}

/**
 * Map host-offered MSP approval choices onto ACP permission options.
 * optionId is the host choiceId so the selected value round-trips exactly.
 * Session/local-persistent allow scopes are only offered when the host
 * actually lists them; we never invent allow-always.
 */
export function choicesToPermissionOptions(choices: MuseApprovalChoice[]): PermissionOption[] {
  return choices.map((choice) => ({
    optionId: choice.choiceId,
    name: choice.label,
    kind: permissionKindFor(choice),
    _meta: {
      museDecision: choice.decision,
      museScope: choice.scope,
    },
  }));
}

function permissionKindFor(choice: MuseApprovalChoice): PermissionOptionKind {
  if (choice.decision === "approved" || choice.decision === "approvedForSession") {
    if (choice.scope === "session" || choice.scope === "localPersistent") {
      return "allow_always";
    }
    return "allow_once";
  }
  if (choice.scope === "localPersistent" || choice.decision === "deniedPolicyAmendment") {
    return "reject_always";
  }
  return "reject_once";
}

export function approvalToPermissionRequest(
  sessionId: string,
  request: MuseApprovalRequest,
): RequestPermissionRequest {
  let rawInput: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(request.rawArgs || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      rawInput = parsed as Record<string, unknown>;
    }
  } catch {
    rawInput = { arguments: request.rawArgs };
  }
  const title =
    (typeof rawInput?.description === "string" && rawInput.description) ||
    (typeof rawInput?.command === "string" && rawInput.command) ||
    (typeof rawInput?.path === "string" && rawInput.path) ||
    request.toolName;
  return {
    sessionId,
    toolCall: {
      toolCallId: request.toolCallId,
      title,
      kind: (TOOL_KINDS[request.toolName] ?? "other") as ToolKind,
      status: "pending",
      rawInput,
    },
    options: choicesToPermissionOptions(request.availableChoices),
    _meta: {
      museApprovalId: request.approvalId,
      museTurnId: request.turnId,
      museItemId: request.itemId,
      museRequirementId: request.currentRequirementId,
      museTaskId: request.taskId,
    },
  };
}

/**
 * Resolve an ACP permission response to a host choiceId.
 * Cancellation and unknown options never grant — prefer an explicit deny/abort
 * choice when the host offered one; otherwise throw for the SDK error path.
 */
export function resolvePermissionChoice(
  request: MuseApprovalRequest,
  response: RequestPermissionResponse,
): string {
  if (response.outcome.outcome === "cancelled") {
    const deny = request.availableChoices.find(
      (choice) =>
        choice.decision === "denied" ||
        choice.decision === "abort" ||
        choice.decision === "deniedPolicyAmendment",
    );
    if (deny) {
      return deny.choiceId;
    }
    throw new Error("permission request cancelled without a host deny choice");
  }
  const optionId = response.outcome.optionId;
  if (!request.availableChoices.some((choice) => choice.choiceId === optionId)) {
    throw new Error(`permission response selected unknown option: ${optionId}`);
  }
  return optionId;
}

/** Tracks in-flight permission request IDs so stale replies cannot grant. */
export class PermissionLifecycle {
  private readonly life = new TurnScopedLifecycle();

  beginTurn(turnId: string): number {
    return this.life.beginTurn(turnId);
  }

  track(approvalId: string, turnId: string, _toolCallId: string, generation: number): boolean {
    return this.life.track(approvalId, turnId, generation);
  }

  isLive(approvalId: string, turnId: string, generation: number): boolean {
    return this.life.isLive(approvalId, turnId, generation);
  }

  resolve(approvalId: string): void {
    this.life.resolve(approvalId);
  }

  disposeTurn(turnId: string): void {
    this.life.disposeTurn(turnId);
  }

  disposeAll(): void {
    this.life.disposeAll();
  }
}
