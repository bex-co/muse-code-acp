import { expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { SessionProgress } from "../session-progress.js";

it("replaces cumulative totals, ignores children and preserves absent counters", async () => {
  const updates: SessionNotification[] = [];
  const progress = new SessionProgress("root", true, async (n) => {
    updates.push(n);
  });
  const value = {
    sessionId: "root",
    cumulative: { promptTokens: 7, outputTokens: 3, totalTokens: 10 },
  };
  await progress.observe({ "session/tokenUsage": value });
  await progress.observe({ "session/tokenUsage": { ...value, viewCursor: "replayed" } });
  await progress.observe({
    "session/tokenUsage": { sessionId: "child", cumulative: { totalTokens: 999 } },
  });
  expect(updates).toHaveLength(1);
  expect(progress.status()).toContain("total 10");
  await progress.observe({
    "session/contextUsage": { sessionId: "root", usedTokens: 12, pressure: "warning" },
  });
  expect(progress.status()).toContain("12 / unknown");
  expect(updates.some((n) => n.update.sessionUpdate === "usage_update")).toBe(false);
  await progress.observe({
    "session/contextUsage": { usedTokens: 12, windowTokens: 100, pressure: "warning" },
  });
  expect(updates.at(-1)?.update).toEqual({
    sessionUpdate: "usage_update",
    used: 12,
    size: 100,
    _meta: {
      "muse/usage": {
        scope: "rootSession",
        context: { usedTokens: 12, windowTokens: 100, pressure: "warning" },
      },
    },
  });
});
it("replaces, modifies, clears and restores plans without revision arithmetic", async () => {
  const updates: SessionNotification[] = [];
  const progress = new SessionProgress("root", false, async (n) => {
    updates.push(n);
  });
  for (const [revision, status] of [
    [9, "pending"],
    [1, "inProgress"],
    [2, "completed"],
    [3, "cancelled"],
  ] as const)
    await progress.observe({
      "session/todoListChanged": { sessionId: "root", revision, items: [{ text: "Task", status }] },
    });
  expect(
    updates.map((n) =>
      n.update.sessionUpdate === "plan" ? n.update.entries[0]!.status : "unknown",
    ),
  ).toEqual(["pending", "in_progress", "completed", "completed"]);
  expect(JSON.stringify(updates.at(-1))).toContain("Cancelled");
  await progress.observe({ "session/todoListChanged": { items: [] } });
  await progress.observe({ "session/todoListChanged": { items: [] } });
  expect(updates).toHaveLength(5);
  expect(updates.at(-1)?.update).toEqual({ sessionUpdate: "plan", entries: [] });
  await progress.observe({}, true);
  expect(progress.status()).toContain("Plan: unknown");
  expect(updates.at(-1)?.update).toEqual({ sessionUpdate: "plan", entries: [] });
});

it("restores newest root facts from backward pages without replaying older totals or plans", async () => {
  const { readProgress } = await import("../session-progress.js");
  const { vi } = await import("vitest");
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      events: [
        {
          method: "session/tokenUsage",
          params: { sessionId: "child", cumulative: { totalTokens: 999 } },
        },
        {
          method: "session/tokenUsage",
          params: {
            sessionId: "root",
            cumulative: { promptTokens: 5, outputTokens: 2, totalTokens: 7 },
          },
        },
        { method: "session/todoListChanged", params: { sessionId: "root", items: [] } },
      ],
      nextCursor: "opaque-new",
    })
    .mockResolvedValueOnce({
      events: [
        {
          method: "session/tokenUsage",
          params: { sessionId: "root", cumulative: { totalTokens: 1 } },
        },
        {
          method: "session/todoListChanged",
          params: { sessionId: "root", items: [{ text: "obsolete", status: "pending" }] },
        },
      ],
      nextCursor: null,
    });
  const result = await readProgress({ request } as never, "root");
  expect(result["session/tokenUsage"]).toMatchObject({ cumulative: { totalTokens: 7 } });
  expect(result["session/todoListChanged"]).toMatchObject({ items: [] });
  expect(request.mock.calls[1]![1].cursor).toBe("opaque-new");
});
