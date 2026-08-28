import { SessionNotification } from "@agentclientprotocol/sdk";
import { Logger } from "./logger.js";
import {
  approvalWaitStartedPayloadSchema,
  MuseEnvelope,
  RunTerminalPayload,
  runOutputDeltaPayloadSchema,
  runTerminalPayloadSchema,
} from "./muse-events.js";
import { ToolCallTracker } from "./tool-calls.js";

/**
 * Translates one prompt turn's muse JSONL envelopes into ACP session updates.
 * Stateful per turn: tool intents and results are correlated by call id.
 *
 * Unknown payload types translate to nothing — muse emits far more event
 * types than ACP clients care about (task lifecycle, reconciliation,
 * observer noise), and new muse versions must degrade gracefully.
 */
export class TurnTranslator {
  private readonly tools: ToolCallTracker;
  /** The last `run.terminal.*` payload seen — the run's own account of how it
   *  ended, used to enrich stop reasons and error messages. */
  lastTerminal: RunTerminalPayload | null = null;
  /** Muse 0.2.1 cannot route this wait through ACP. The caller must stop the
   * child and fail the turn instead of leaving a headless prompt blocked. */
  approvalWait: { toolName: string; toolCallId: string } | null = null;

  constructor(
    private readonly sessionId: string,
    logger: Logger = console,
  ) {
    this.tools = new ToolCallTracker(sessionId, logger);
  }

  toUpdates(envelope: MuseEnvelope): SessionNotification[] {
    if (envelope.payload_type === "approval_wait.effect.started") {
      const parsed = approvalWaitStartedPayloadSchema.safeParse(envelope.payload);
      if (parsed.success) {
        this.approvalWait = {
          toolName: parsed.data.record.tool_name,
          toolCallId: parsed.data.record.tool_call_id,
        };
      }
      return [];
    }
    if (envelope.payload_type.startsWith("run.terminal.")) {
      const parsed = runTerminalPayloadSchema.safeParse(envelope.payload);
      if (parsed.success) {
        this.lastTerminal = parsed.data;
      }
      return [];
    }
    switch (envelope.payload_type) {
      case "run.output.delta": {
        const parsed = runOutputDeltaPayloadSchema.safeParse(envelope.payload);
        if (!parsed.success || parsed.data.text.length === 0) {
          return [];
        }
        return [
          {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: parsed.data.text },
            },
          },
        ];
      }
      case "task.lifecycle.side_effect_intent":
        return this.tools.intentToUpdates(envelope);
      case "tool.result":
        return this.tools.resultToUpdates(envelope);
      default:
        return [];
    }
  }
}
