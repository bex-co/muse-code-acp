import { SessionNotification, ToolCall } from "@agentclientprotocol/sdk";
import type { FoldedItem } from "@muse-code/sdk";
import { Logger } from "./logger.js";
import { presentResult, TOOL_KINDS } from "./tool-calls.js";

/** Subset of MSP item/delta params used for ACP text streaming. */
export interface ItemDeltaParams {
  itemId: string;
  delta: string;
  field?: string;
}

/** Translate folded MSP items/deltas into ACP session updates. */
export class MuseSdkTranslator {
  private readonly items = new Map<string, FoldedItem>();
  private readonly emittedText = new Map<string, string>();

  constructor(
    private readonly sessionId: string,
    private readonly logger: Logger,
  ) {}

  fromDelta(params: ItemDeltaParams): SessionNotification[] {
    const { itemId, delta, field } = params;
    const item = this.items.get(itemId);
    if (
      item?.kind !== "agentMessage" ||
      item.status !== "inProgress" ||
      (field && field !== "text")
    ) {
      return [];
    }
    this.emittedText.set(itemId, (this.emittedText.get(itemId) ?? "") + delta);
    return this.textUpdate(delta);
  }

  fromItem(item: FoldedItem): SessionNotification[] {
    const previous = this.items.get(item.itemId);
    if (previous && previous.revision >= item.revision) {
      return [];
    }
    this.items.set(item.itemId, item);
    if (item.kind === "agentMessage") {
      const emitted = this.emittedText.get(item.itemId) ?? "";
      const text = item.text ?? "";
      // ACP chunks are append-only. A final snapshot normally contains
      // the deltas already sent; only send its remaining suffix.
      if (!text.startsWith(emitted)) {
        this.logger.log(`muse-sdk: final text changed for ${item.itemId}`);
        return [];
      }
      this.emittedText.set(item.itemId, text);
      return this.textUpdate(text.slice(emitted.length));
    }
    if (item.kind !== "toolCall") {
      return [];
    }
    const tool = item.tool ?? "tool";
    const args = parseArgs(item.args);
    const output = item.visibleOutput ?? item.text ?? item.failureReason ?? "";
    const title = args?.description ?? args?.command ?? args?.path;
    const status =
      item.status === "inProgress"
        ? "in_progress"
        : item.status === "completed"
          ? "completed"
          : "failed";
    const call: ToolCall = {
      toolCallId: item.callId ?? item.itemId,
      name: tool,
      title: typeof title === "string" ? title : tool,
      kind: TOOL_KINDS[tool] ?? "other",
      status,
      ...presentResult(tool, output, this.logger),
      ...(args ? { rawInput: args } : {}),
    };
    return [
      {
        sessionId: this.sessionId,
        update: previous
          ? { ...call, sessionUpdate: "tool_call_update" }
          : { ...call, sessionUpdate: "tool_call" },
      },
    ];
  }

  private textUpdate(text: string): SessionNotification[] {
    return text
      ? [
          {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        ]
      : [];
  }
}

function parseArgs(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Preserve non-JSON arguments for the client too.
  }
  return { arguments: text };
}
