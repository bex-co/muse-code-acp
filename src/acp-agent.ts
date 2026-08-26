// Placeholder until w1/m1/t003 lands the ACP server wiring.
import type { Logger } from "./logger.js";
export type { Logger } from "./logger.js";

export function runAcp(_logger?: Logger): {
  connection: { closed: Promise<void> };
  agent: { dispose(): Promise<void> };
} {
  throw new Error("ACP server not implemented yet (w1/m1/t003)");
}
