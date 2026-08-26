import { SessionNotification } from "@agentclientprotocol/sdk";
import { MuseEnvelope, runOutputDeltaPayloadSchema } from "./muse-events.js";

/**
 * Translates one muse JSONL envelope into zero or more ACP session updates.
 * Unknown payload types translate to nothing — muse emits far more event
 * types than ACP clients care about (task lifecycle, reconciliation,
 * observer noise), and new muse versions must degrade gracefully.
 */
export function envelopeToUpdates(
  sessionId: string,
  envelope: MuseEnvelope,
): SessionNotification[] {
  switch (envelope.payload_type) {
    case "run.output.delta": {
      const parsed = runOutputDeltaPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success || parsed.data.text.length === 0) {
        return [];
      }
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: parsed.data.text },
          },
        },
      ];
    }
    default:
      return [];
  }
}
