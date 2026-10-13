import { expect, it } from "vitest";
import { MuseSdkTranslator } from "../muse-sdk-events.js";
import { restoredTaskUpdates, parseTaskRequest } from "../async-tasks.js";
const item = {
  itemId: "worker",
  kind: "workflow",
  turnId: "turn",
  revision: 1,
  status: "inProgress",
  workflowRunId: "native-run",
  children: [
    { childId: "one", attempt: 1, status: "started" },
    { childId: "two", attempt: 2, status: "started" },
  ],
} as const;
it("correlates worker revisions, terminals, nested attempts and negotiated controls", () => {
  const translator = new MuseSdkTranslator("root", { log() {}, error() {} });
  translator.configureWorkers("generation", new Set(["cancel"] as const), true);
  const first = translator.fromItem(item)[0].update;
  expect(first).toMatchObject({
    sessionUpdate: "tool_call",
    toolCallId: "worker",
    status: "in_progress",
    _meta: { "muse/asyncTasks": { target: "generation:worker", actions: ["cancel"] } },
  });
  expect(JSON.stringify(first)).toContain("Child two attempt 2");
  expect(translator.fromItem(item)).toEqual([]);
  expect(
    translator.fromItem({ ...item, revision: 2, status: "cancelled" })[0].update,
  ).toMatchObject({
    sessionUpdate: "tool_call_update",
    toolCallId: "worker",
    status: "failed",
    _meta: { "muse/asyncTasks": { observedStatus: "cancelled", actions: [] } },
  });
  expect(translator.lostWork()).toEqual([]);
});
it("host loss and read-only restoration cannot imply active work or available controls", () => {
  const translator = new MuseSdkTranslator("root", { log() {}, error() {} });
  translator.fromItem(item);
  expect(JSON.stringify(translator.lostWork())).toContain("outcome is unknown");
  const restored = restoredTaskUpdates("root", [item]);
  expect(restored[0].update).toMatchObject({
    status: "failed",
    title: "workflow: live state unknown",
  });
  expect(JSON.stringify(restored)).not.toContain('"cancel"');
  expect(() =>
    parseTaskRequest({ sessionId: "root", target: "generation:worker", action: "delete" }),
  ).toThrow();
});

it("offers only verified actions for the task's current state", async () => {
  const { taskActions } = await import("../async-tasks.js");
  const all = new Set(["cancel", "pause", "background", "stop"] as const);
  const workflow = {
    itemId: "w",
    kind: "workflow",
    turnId: "t",
    revision: 1,
    workflowRunId: "run",
  };
  expect(taskActions({ ...workflow, status: "inProgress" }, all)).toEqual(["cancel", "pause"]);
  expect(taskActions({ ...workflow, status: "inProgress", paused: true }, all)).toEqual([]);
  expect(taskActions({ ...workflow, status: "inProgress" }, new Set(["cancel"] as const))).toEqual([
    "cancel",
  ]);
  expect(taskActions({ ...workflow, status: "completed" }, all)).toEqual([]);
  const tool = { itemId: "c", kind: "toolCall", turnId: "t", revision: 1, status: "inProgress" };
  expect(taskActions(tool, all)).toEqual(["background"]);
  expect(taskActions({ ...tool, backgroundInitiator: "user" }, all)).toEqual(["stop"]);
  expect(taskActions(tool, new Set(["cancel"] as const))).toEqual([]);
  for (const action of ["cancel", "pause", "background", "stop"])
    expect(parseTaskRequest({ sessionId: "s", target: "g:i", action })).toMatchObject({ action });
});
