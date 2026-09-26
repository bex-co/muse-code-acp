import { RequestError } from "@agentclientprotocol/sdk";
import type { Connection, FoldedItem } from "@muse-code/sdk";

export const ASYNC_TASKS = "muse/asyncTasks";
export const TASK_METHOD = "_muse/task";
export const workerKinds = new Set(["workflow", "subagent", "reminderChild"]);
export function parseTaskRequest(raw: unknown) {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    typeof value.target !== "string" ||
    value.action !== "cancel"
  )
    throw RequestError.invalidParams(
      undefined,
      "task control requires sessionId, target and action cancel",
    );
  return { sessionId: value.sessionId, target: value.target };
}

/** Public MSP workflow/cancel (declared in SDK 1.3.0; Connection.command stays untyped). */
export async function cancelWorkflow(
  connection: Connection,
  sessionId: string,
  workflowRunId: string,
) {
  const command = connection.command.bind(connection) as unknown as (
    method: string,
    params: Record<string, unknown>,
    options: { maxAttempts: number },
  ) => Promise<{ status: string }>;
  const result = await command("workflow/cancel", { sessionId, workflowRunId }, { maxAttempts: 1 });
  if (result.status !== "accepted" && result.status !== "completed")
    throw RequestError.internalError(
      undefined,
      "Muse returned an unknown workflow cancellation acknowledgement",
    );
  return { status: result.status }; // An acknowledgement never substitutes for an item terminal.
}

/** Public item fields only; child usage remains separate from root totals. */
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
      workerKinds.has(String(i.kind)) ||
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
      title: `${item.kind}: ${item.status === "inProgress" ? "live state unknown" : item.status}`,
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
