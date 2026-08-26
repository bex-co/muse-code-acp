import { SessionNotification } from "@agentclientprotocol/sdk";
import { Logger } from "./logger.js";
import { MuseEnvelope, runOutputDeltaPayloadSchema } from "./muse-events.js";
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

  constructor(
    private readonly sessionId: string,
    logger: Logger = console,
  ) {
    this.tools = new ToolCallTracker(sessionId, logger);
  }

  toUpdates(envelope: MuseEnvelope): SessionNotification[] {
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
