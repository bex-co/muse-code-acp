import type { SessionNotification, PlanEntry } from "@agentclientprotocol/sdk";
import type { Connection, Session } from "@muse-code/sdk";

export const USAGE_EXTENSION = "muse/usage";
const families = [
  "session/tokenUsage",
  "session/contextUsage",
  "session/todoListChanged",
  "session/modelChanged",
  "session/approvalModeChanged",
] as const;
export type ProgressFacts = Partial<Record<(typeof families)[number], unknown>>;
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

export function foldedProgress(fold: Session["fold"]): ProgressFacts {
  return fold.current ? Object.fromEntries(families.map((f) => [f, fold.sessionState.get(f)])) : {};
}

/** Restore latest facts via public pages; root identity and observed cursors only. */
export async function readProgress(
  connection: Connection,
  sessionId: string,
): Promise<ProgressFacts> {
  const result: ProgressFacts = {};
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await connection.request("view/page", {
      sessionId,
      direction: "backward",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.events)) break;
    for (const event of [...page.events].reverse()) {
      if (
        event.params?.sessionId !== sessionId ||
        !families.includes(event.method as (typeof families)[number])
      )
        continue;
      const family = event.method as (typeof families)[number];
      if (!(family in result)) result[family] = event.params;
    }
    if (
      families.every((f) => f in result) ||
      typeof page.nextCursor !== "string" ||
      !page.nextCursor ||
      seen.has(page.nextCursor)
    )
      break;
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  return result;
}

/** Latest authoritative facts replace, never add to, earlier observations. */
export class SessionProgress {
  private signatures = new Map<string, string>();
  private facts: ProgressFacts = {};
  constructor(
    private readonly sessionId: string,
    private readonly negotiated: boolean,
    private readonly publish: (n: SessionNotification) => Promise<void>,
  ) {}

  async observe(values: ProgressFacts, reset = false): Promise<void> {
    if (reset) {
      this.facts = {};
      this.signatures.clear();
    }
    for (const family of families) {
      const value = values[family];
      if (value === undefined) continue;
      const data = record(value);
      if (data?.sessionId !== undefined && data.sessionId !== this.sessionId) continue;
      this.facts[family] = value;
      let update: SessionNotification["update"] | undefined;
      let canonical: unknown;
      if (family === "session/tokenUsage") {
        const cumulative = record(data?.cumulative);
        canonical = {
          promptTokens: count(cumulative?.promptTokens),
          outputTokens: count(cumulative?.outputTokens),
          totalTokens: count(cumulative?.totalTokens),
        };
        if (this.negotiated)
          update = {
            sessionUpdate: "session_info_update",
            _meta: {
              [USAGE_EXTENSION]: {
                scope: "rootSession",
                cumulative: canonical,
                lastModelCall: {
                  turnId: typeof data?.turnId === "string" ? data.turnId : undefined,
                  promptTokens: count(data?.promptTokens),
                  totalTokens: count(data?.totalTokens),
                  usage: record(data?.usage)
                    ? Object.fromEntries(
                        Object.entries(record(data?.usage)!).filter(
                          ([key, value]) =>
                            [
                              "inputTokens",
                              "outputTokens",
                              "cachedTokens",
                              "cacheReadTokens",
                              "cacheWriteTokens",
                              "reasoningTokens",
                            ].includes(key) && count(value) !== undefined,
                        ),
                      )
                    : undefined,
                },
              },
            },
          };
      } else if (family === "session/contextUsage") {
        canonical = {
          usedTokens: count(data?.usedTokens),
          windowTokens: count(data?.windowTokens),
          pressure: typeof data?.pressure === "string" ? data.pressure : undefined,
        };
        const { usedTokens, windowTokens } = canonical as {
          usedTokens?: number;
          windowTokens?: number;
        };
        if (usedTokens !== undefined && windowTokens !== undefined)
          update = {
            sessionUpdate: "usage_update",
            used: usedTokens,
            size: windowTokens,
            ...(this.negotiated
              ? { _meta: { [USAGE_EXTENSION]: { scope: "rootSession", context: canonical } } }
              : {}),
          };
        else if (this.negotiated)
          update = {
            sessionUpdate: "session_info_update",
            _meta: { [USAGE_EXTENSION]: { scope: "rootSession", context: canonical } },
          };
      } else if (family === "session/todoListChanged") {
        if (value !== null && !Array.isArray(data?.items)) continue;
        const entries: PlanEntry[] = (Array.isArray(data?.items) ? data.items : [])
          .slice(0, 500)
          .flatMap((entry: unknown) => {
            const item = record(entry);
            if (typeof item?.text !== "string") return [];
            const status = item.status;
            return [
              {
                content: `${status === "cancelled" ? "[Cancelled] " : !["pending", "inProgress", "completed"].includes(String(status)) ? `[${String(status)}] ` : ""}${item.text.slice(0, 8192)}${item.text.length > 8192 ? " [Todo text truncated]" : ""}`,
                priority: "medium" as const,
                status:
                  status === "inProgress"
                    ? ("in_progress" as const)
                    : status === "completed" || status === "cancelled"
                      ? ("completed" as const)
                      : ("pending" as const),
              },
            ];
          });
        const last = entries.at(-1);
        if (Array.isArray(data?.items) && data.items.length > 500 && last)
          last.content += ` [${data.items.length - 500} further todo entries omitted]`;
        canonical = entries;
        update = { sessionUpdate: "plan", entries };
      }
      if (canonical === undefined) continue;
      const signature = JSON.stringify(update ?? canonical);
      if (this.signatures.get(family) === signature) continue;
      this.signatures.set(family, signature);
      if (update) await this.publish({ sessionId: this.sessionId, update });
    }
    if (reset && !("session/todoListChanged" in values))
      await this.publish({
        sessionId: this.sessionId,
        update: { sessionUpdate: "plan", entries: [] },
      });
  }

  status(): string {
    const usage = record(record(this.facts["session/tokenUsage"])?.cumulative);
    const context = record(this.facts["session/contextUsage"]);
    const todos = record(this.facts["session/todoListChanged"]);
    const shown = (v: unknown) => count(v) ?? "unknown";
    const model = record(this.facts["session/modelChanged"]);
    const approval = record(this.facts["session/approvalModeChanged"]);
    return `Observed model: ${typeof model?.modelId === "string" ? model.modelId : "unknown"}; native approval: ${typeof approval?.mode === "string" ? approval.mode : "unknown"}.\nRoot-session usage: prompt ${shown(usage?.promptTokens)}, output ${shown(usage?.outputTokens)}, total ${shown(usage?.totalTokens)}.\nContext: ${shown(context?.usedTokens)} / ${shown(context?.windowTokens)} tokens; pressure ${typeof context?.pressure === "string" ? context.pressure : "unknown"}.\nPlan: ${Array.isArray(todos?.items) ? `${todos.items.length} observed entries` : "unknown"}. Child usage is separate.`;
  }
}
