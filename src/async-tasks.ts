import { RequestError } from "@agentclientprotocol/sdk";
import { MspError, type Connection, type FoldedItem } from "@muse-code/sdk";

export const ASYNC_TASKS = "muse/asyncTasks";
export const TASK_METHOD = "_muse/task";
export const workerKinds = new Set(["workflow", "subagent", "reminderChild"]);
export type TaskAction = "cancel" | "pause" | "background" | "stop";
const TASK_ACTIONS: readonly TaskAction[] = ["cancel", "pause", "background", "stop"];

export function parseTaskRequest(raw: unknown) {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    typeof value.target !== "string" ||
    !TASK_ACTIONS.includes(value.action as TaskAction)
  )
    throw RequestError.invalidParams(
      undefined,
      `task control requires sessionId, target and action ${TASK_ACTIONS.join(" | ")}`,
    );
  return { sessionId: value.sessionId, target: value.target, action: value.action as TaskAction };
}

/**
 * The verified actions a task card offers. Running workflows: cancel and pause.
 * A paused workflow offers none on Muse 1.4.6: cancel is refused (`missing_run`)
 * and resume was accepted but never observed to unpause the run. Tool calls:
 * background while foreground, stop once backgrounded.
 */
export function taskActions(item: FoldedItem, controls: ReadonlySet<TaskAction>): TaskAction[] {
  if (item.status !== "inProgress") return [];
  if (item.kind === "workflow" && item.workflowRunId && !item.paused)
    return [
      ...(controls.has("cancel") ? (["cancel"] as const) : []),
      ...(controls.has("pause") ? (["pause"] as const) : []),
    ];
  if (item.kind === "toolCall")
    return item.backgroundInitiator
      ? controls.has("stop")
        ? ["stop"]
        : []
      : controls.has("background")
        ? ["background"]
        : [];
  return [];
}

/** One public task/workflow control command (Connection.command stays untyped). */
export async function sendTaskControl(
  connection: Connection,
  method: "workflow/cancel" | "workflow/pause" | "task/background" | "task/stop",
  params: Record<string, unknown>,
) {
  const command = connection.command.bind(connection) as unknown as (
    method: string,
    params: Record<string, unknown>,
    options: { maxAttempts: number },
  ) => Promise<{ status: string }>;
  let result: { status: string };
  try {
    result = await command(method, params, { maxAttempts: 1 });
  } catch (error) {
    if (!(error instanceof MspError)) throw error;
    const reason = (error.data as { reason?: unknown }).reason;
    throw RequestError.invalidRequest(
      undefined,
      `Muse rejected ${method}: ${typeof reason === "string" ? reason : error.kind}`,
    );
  }
  if (result.status !== "accepted" && result.status !== "completed")
    throw RequestError.internalError(
      undefined,
      `Muse returned an unknown ${method} acknowledgement`,
    );
  return { status: result.status }; // An acknowledgement never substitutes for an item terminal.
}

/** Public item fields only; child usage remains separate from root totals. */
/**
 * Muse 1.4.13 spawns reminder children on every turn. Non-blocking ones run
 * beside the turn and change nothing the user sees; blocking ones hold the
 * turn open until they settle (`blocking`, ADR 41191 D4), so only those get a
 * card, named from `reminderAgentId` as the schema directs.
 */
export function isBackgroundReminder(item: FoldedItem): boolean {
  return item.kind === "reminderChild" && item.blocking !== true;
}

export function reminderTitle(item: FoldedItem): string {
  const agent = String(item.reminderAgentId ?? "reminder").replace(/-reminder$/, "");
  return `Muse reminder: ${agent}`.slice(0, 1024);
}

export const REMINDER_TEXT = "Muse runs this check before it finishes the turn.";

export function workerText(item: FoldedItem): string {
  return [
    item.fallbackText,
    item.objective,
    item.controlStatus ? `Control: ${item.controlStatus}` : undefined,
    item.result?.summary,
    item.result?.text,
    item.failureReason,
    ...(item.children ?? [])
      .slice(0, 100)
      .map(
        (c) =>
          `Child ${c.childId} attempt ${c.attempt}: ${c.status}${c.terminal ? ` (${c.terminal})` : ""}${c.label ? ` — ${c.label}` : ""}`,
      ),
    item.usage
      ? `Child/descendant usage (not root total): ${JSON.stringify(item.usage)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 65536);
}

export async function readLatestItems(
  connection: Connection,
  sessionId: string,
): Promise<FoldedItem[]> {
  const latest = new Map<string, FoldedItem>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let n = 0; n < 20; n++) {
    const page = await connection.request("view/page", {
      sessionId,
      direction: "backward",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.events)) break;
    for (const event of [...page.events].reverse()) {
      const p = event.params as { sessionId?: string; item?: FoldedItem };
      if (p.sessionId === sessionId && p.item?.itemId && !latest.has(p.item.itemId))
        latest.set(p.item.itemId, p.item);
    }
    if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor))
      break;
    cursor = page.nextCursor;
    cursors.add(cursor);
  }
  return [...latest.values()];
}

export function taskItems(items: FoldedItem[]) {
  return items.filter(
    (i) =>
      (workerKinds.has(String(i.kind)) && !isBackgroundReminder(i)) ||
      (i.status === "inProgress" && ["toolCall", "userShell"].includes(String(i.kind))),
  );
}

export function restoredTaskUpdates(
  sessionId: string,
  items: FoldedItem[],
): import("@agentclientprotocol/sdk").SessionNotification[] {
  return items.map((item) => ({
    sessionId,
    update: {
      sessionUpdate: workerKinds.has(String(item.kind)) ? "tool_call" : "tool_call_update",
      toolCallId: item.callId ?? item.itemId,
      title: `${item.kind === "reminderChild" ? reminderTitle(item) : item.kind}: ${item.status === "inProgress" ? "live state unknown" : item.status}`,
      kind: "other",
      status: item.status === "completed" ? "completed" : "failed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: `${workerText(item)}${item.status === "inProgress" ? "\nLast observed in progress; this read does not establish that work is still running. No control is available until observed on a live host." : ""}`,
          },
        },
      ],
    },
  }));
}
