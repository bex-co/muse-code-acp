import { RequestError, type ClientCapabilities } from "@agentclientprotocol/sdk";
import type { FoldedItem, SessionFoldView } from "@muse-code/sdk";

/**
 * Opt-in: `session/prompt` resolves only once the session's background work,
 * and the host-owned turns Muse starts to report it, have finished.
 */
export const BACKGROUND_HOLD = "muse/backgroundHold";

export function supportsBackgroundHold(capabilities: ClientCapabilities | undefined): boolean {
  return capabilities?._meta?.[BACKGROUND_HOLD] === 1;
}

const MAX_SETTLE_MS = 600_000;

/**
 * How long a held prompt waits, once nothing runs, for Muse to start the turn
 * that reports finished background work. Muse 1.4.14-R7309.1 publishes nothing
 * between a background item's terminal revision and that turn's `turn/started`
 * (observed 32–43 ms apart), so the window is a bound, not a signal.
 */
export function wakeSettleMs(env: Record<string, string | undefined>): number {
  const key = "MUSE_CODE_ACP_WAKE_SETTLE_MS";
  const value = env[key];
  if (value === undefined) return 3_000;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed > MAX_SETTLE_MS)
    throw RequestError.invalidParams(undefined, `${key} must be an integer in 0..${MAX_SETTLE_MS}`);
  return parsed;
}

/**
 * A subagent's item stays `inProgress` while its child session is open, also
 * after it reported (Muse 1.4.14: a finished workflow leaves its children at
 * `controlStatus: "resultReady"`). Only these control states mean it still works.
 */
const WORKING_SUBAGENT = new Set([undefined, "accepted", "starting", "running", "recoveryPending"]);

/**
 * Work that outlives the turn that started it: a running workflow or subagent,
 * a tool call Muse sent to the background (`task/background`, or `bash` past
 * its `yield_time_ms`), or a user shell. A paused workflow cannot progress
 * without a control the adapter does not offer, so it does not hold a prompt.
 */
export function backgroundWork(items: readonly FoldedItem[]): FoldedItem[] {
  return items.filter(
    (item) =>
      item.status === "inProgress" &&
      !item.paused &&
      (item.kind === "subagent"
        ? WORKING_SUBAGENT.has(item.controlStatus as string | undefined)
        : ["workflow", "toolCall", "userShell"].includes(String(item.kind))),
  );
}

/** Workers a turn launched; even finished ones may still wake a reporting turn. */
export function launchedWorkers(items: readonly FoldedItem[], turnId: string): boolean {
  return items.some(
    (item) => item.turnId === turnId && (item.kind === "workflow" || item.kind === "subagent"),
  );
}

/** Nothing left for a held prompt to wait for, apart from a turn it already ran. */
export function quiescent(fold: SessionFoldView, ran: ReadonlySet<string>): boolean {
  return (
    (fold.activeTurnId === undefined || ran.has(fold.activeTurnId)) &&
    fold.pendingApprovals().length === 0 &&
    fold.pendingUserInputs().length === 0 &&
    backgroundWork(fold.items.list()).length === 0
  );
}
