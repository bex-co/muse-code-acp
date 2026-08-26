import { z } from "zod";

/**
 * Muse Code JSONL event envelope, as emitted by `muse exec --json` (verified
 * against muse 0.2.1). Every stdout line is one envelope. Payloads are kept
 * open: unknown `payload_type`s must flow through untouched so newer muse
 * versions degrade gracefully instead of breaking the adapter.
 */
export const MUSE_ENVELOPE_SCHEMA_VERSION = 1;

const streamRefSchema = z.object({
  kind: z.string(),
  id: z.string(),
});

export const museEnvelopeSchema = z.looseObject({
  schema_version: z.number(),
  id: z.string(),
  stream: streamRefSchema,
  sequence: z.number(),
  recorded_at: z.number(),
  /** Observed: "event" | "status" | "reconciliation" — treated as an open set. */
  record_type: z.string(),
  /** Observed: "durable" | "ephemeral". */
  durability: z.string(),
  causation_id: z.string().nullish(),
  payload_type: z.string(),
  payload_schema_version: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

export type MuseEnvelope = z.infer<typeof museEnvelopeSchema>;

/** `payload_type: "run.output.delta"` — streamed assistant text. */
export const runOutputDeltaPayloadSchema = z.looseObject({
  kind: z.literal("run_output_delta"),
  text: z.string(),
});

/** `payload_type: "run.terminal.*"` — end of a run. */
export const runTerminalPayloadSchema = z.looseObject({
  kind: z.literal("run_terminal"),
  terminal: z.string(),
  text: z.string().nullish(),
  reason: z.string().nullish(),
});

/** `payload_type: "turn.input.user"` — echo of the submitted prompt. */
export const turnInputUserPayloadSchema = z.looseObject({
  kind: z.literal("turn_input_user"),
  prompt: z.string(),
});

export type RunOutputDeltaPayload = z.infer<typeof runOutputDeltaPayloadSchema>;
export type RunTerminalPayload = z.infer<typeof runTerminalPayloadSchema>;

/**
 * Incremental line splitter + envelope parser for a muse `--json` stdout
 * stream. Non-JSON lines and schema mismatches never throw: they are reported
 * to `onGarbage` (file logger territory) and skipped, because losing one event
 * must not kill a turn.
 */
export class MuseLineParser {
  private buffer = "";

  constructor(
    private readonly onEnvelope: (envelope: MuseEnvelope) => void,
    private readonly onGarbage: (line: string, reason: string) => void = () => {},
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.parseLine(line);
    }
  }

  /** Flush any trailing partial line (call once, at stream end). */
  end(): void {
    if (this.buffer.length > 0) {
      this.parseLine(this.buffer);
      this.buffer = "";
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      this.onGarbage(trimmed, "not JSON");
      return;
    }
    const parsed = museEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      this.onGarbage(trimmed, `not a muse envelope: ${parsed.error.issues[0]?.message}`);
      return;
    }
    if (parsed.data.schema_version !== MUSE_ENVELOPE_SCHEMA_VERSION) {
      // Emit anyway: payload consumers validate what they use. The warning is
      // the signal that a muse upgrade may need adapter attention.
      this.onGarbage(
        trimmed,
        `unexpected schema_version ${parsed.data.schema_version} (expected ${MUSE_ENVELOPE_SCHEMA_VERSION}); passing through`,
      );
    }
    this.onEnvelope(parsed.data);
  }
}
