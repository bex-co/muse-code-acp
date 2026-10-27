import { expect, test, vi } from "vitest";
import { parseGoalObservation, readGoalFromConnection } from "../goal-state.js";

const sessionId = "session-root";
const goal = {
  objective: "Ship it",
  status: "future-status",
  percentComplete: 140,
  currentWork: "",
  nextWork: "Review",
};
const read = (history: unknown = { mode: "inline", items: [] }) => ({
  session: { sessionId },
  history,
});
const event = (value: unknown) => ({
  method: "session/goalChanged",
  params: { sessionId, goal: value },
});
const page = (events: unknown[], nextCursor: string | null = null) => ({ events, nextCursor });

test("goal parsing preserves public values and distinguishes unknown from clearing", () => {
  expect(parseGoalObservation({ ...goal, private: "drop" })).toEqual({ status: "known", goal });
  expect(parseGoalObservation({ ...goal, percentComplete: -1 })).toMatchObject({
    status: "known",
    goal: { percentComplete: -1 },
  });
  expect(parseGoalObservation(null)).toEqual({ status: "known", goal: null });
  for (const raw of [
    undefined,
    {},
    { ...goal, percentComplete: NaN },
    { ...goal, percentComplete: Infinity },
    { ...goal, currentWork: null },
    { ...goal, status: 1 },
  ]) {
    expect(parseGoalObservation(raw)).toMatchObject({ status: "unknown" });
  }
});

test("authoritative snapshot goal including null needs no page or writer lease", async () => {
  const connection = { command: vi.fn() };
  for (const value of [goal, null]) {
    expect(
      await readGoalFromConnection(
        connection,
        sessionId,
        read({ mode: "snapshot", snapshot: { schemaVersion: 1, state: { goal: value } } }),
      ),
    ).toEqual({ status: "known", goal: value });
  }
  expect(connection.command).not.toHaveBeenCalled();
});

test("inline history falls back to backward pages and newest clear defeats stale goals", async () => {
  const connection = {
    command: vi
      .fn()
      .mockResolvedValueOnce(read())
      .mockResolvedValueOnce(page([event(goal), event(null)])),
  };
  expect(await readGoalFromConnection(connection, sessionId)).toEqual({
    status: "known",
    goal: null,
  });
  expect(connection.command.mock.calls).toEqual([
    ["session/read", { sessionId, excludeItems: true }, { maxAttempts: 1 }],
    ["view/page", { sessionId, direction: "backward", limit: 100 }, { maxAttempts: 1 }],
  ]);
});

test("backward page order and opaque cursor relay recover latest corrected goal", async () => {
  const changed = { ...goal, objective: "Corrected" };
  const connection = {
    command: vi
      .fn()
      .mockResolvedValueOnce(page([], "opaque-not-sortable"))
      .mockResolvedValueOnce(page([event(goal), event(changed)], "earlier")),
  };
  expect(await readGoalFromConnection(connection, sessionId, read())).toEqual({
    status: "known",
    goal: changed,
  });
  expect(connection.command.mock.calls[1]![1]).toMatchObject({ cursor: "opaque-not-sortable" });
});

test("missing snapshot goal falls back while explicitly malformed current goal stays unknown", async () => {
  const connection = { command: vi.fn().mockResolvedValue(page([])) };
  expect(
    await readGoalFromConnection(
      connection,
      sessionId,
      read({ mode: "snapshot", snapshot: { schemaVersion: 1, state: {} } }),
    ),
  ).toEqual({ status: "known", goal: null });
  expect(
    await readGoalFromConnection(
      connection,
      sessionId,
      read({ mode: "snapshot", snapshot: { schemaVersion: 1, state: { goal: {} } } }),
    ),
  ).toMatchObject({ status: "unknown" });
  expect(connection.command).toHaveBeenCalledTimes(1);
});

test("repeated cursors and bounded page counts cannot loop indefinitely", async () => {
  const repeated = { command: vi.fn().mockResolvedValue(page([], "same")) };
  expect(await readGoalFromConnection(repeated, sessionId, read())).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("cursor"),
  });
  expect(repeated.command).toHaveBeenCalledTimes(2);
  let index = 0;
  const endless = {
    command: vi.fn().mockImplementation(async () => page([], `cursor-${index++}`)),
  };
  expect(await readGoalFromConnection(endless, sessionId, read())).toMatchObject({
    status: "unknown",
    reason: expect.stringContaining("limit"),
  });
  expect(endless.command).toHaveBeenCalledTimes(20);
});

test("unavailable, malformed and foreign history cannot fabricate or resurrect goals", async () => {
  for (const result of [
    page([event(goal), event(undefined)]),
    page([{ method: "session/goalChanged", params: { sessionId: "foreign", goal } }]),
    {},
    { events: [], nextCursor: 4 },
  ]) {
    const connection = { command: vi.fn().mockResolvedValue(result) };
    expect(await readGoalFromConnection(connection, sessionId, read())).toMatchObject({
      status: "unknown",
    });
  }
  const rejected = {
    command: vi.fn().mockRejectedValue(new Error("secret pruned history detail")),
  };
  const observed = await readGoalFromConnection(rejected, sessionId, read());
  expect(observed).toMatchObject({ status: "unknown" });
  expect(JSON.stringify(observed)).not.toContain("secret");
});
