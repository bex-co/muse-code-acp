import { describe, expect, it } from "vitest";
import { MuseSdkTranslator } from "../muse-sdk-events.js";
import { fixturesDir, silentLogger } from "./helpers.js";
import type { FoldedItem } from "@muse-code/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, "msp", name), "utf8"));
}

describe("MSP → ACP message and tool contracts", () => {
  it("emits each text segment once across deltas and a final snapshot", () => {
    const events = loadFixture("agent-message-delta.json") as Array<{
      kind: string;
      item?: FoldedItem;
      delta?: { itemId: string; delta: string };
    }>;
    const translator = new MuseSdkTranslator("s1", silentLogger());
    const chunks: string[] = [];
    for (const event of events) {
      const updates =
        event.kind === "delta"
          ? translator.fromDelta(event.delta!)
          : translator.fromItem(event.item!);
      for (const update of updates) {
        if (update.update.sessionUpdate === "agent_message_chunk") {
          chunks.push(update.update.content.type === "text" ? update.update.content.text : "");
        }
      }
    }
    expect(chunks.join("")).toBe("hello world");
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("keeps concurrent tool calls distinct with stable IDs and locations", () => {
    const events = loadFixture("concurrent-tools.json") as FoldedItem[];
    const translator = new MuseSdkTranslator("s1", silentLogger());
    const updates = events.flatMap((item) => translator.fromItem(item));
    const ids = updates.map((u) => ("toolCallId" in u.update ? u.update.toolCallId : null));
    expect(ids).toEqual(["bash-1", "bash-1", "read-1", "read-1"]);
    expect(updates[1].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: { formatted_output: "/tmp" },
    });
    expect(updates[3].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      locations: [{ path: "/workspace/a.ts" }],
    });
  });

  it("surfaces completion-only tools and ignores older revisions / duplicates", () => {
    const translator = new MuseSdkTranslator("s1", silentLogger());
    const completed = loadFixture("completion-only-tool.json") as FoldedItem;
    expect(translator.fromItem(completed)[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "late-1",
      status: "completed",
    });
    expect(translator.fromItem(completed)).toEqual([]);
    const older = { ...completed, revision: 0, status: "inProgress" as const };
    expect(translator.fromItem(older)).toEqual([]);
  });

  it("does not map reasoning or usage items", () => {
    const translator = new MuseSdkTranslator("s1", silentLogger());
    const reasoning = {
      itemId: "r1",
      kind: "reasoning",
      revision: 1,
      status: "completed",
      text: "secret thoughts",
    } as unknown as FoldedItem;
    expect(translator.fromItem(reasoning)).toEqual([]);
  });
});

it("streams only public summary parts once, including completion-only parts", () => {
  const t = new MuseSdkTranslator("root", silentLogger());
  const start = {
    itemId: "r",
    kind: "reasoning",
    revision: 1,
    status: "inProgress",
    summary: [],
    text: "never render private text",
  } as unknown as FoldedItem;
  const updates = [
    ...t.fromItem(start),
    ...t.fromDelta({ itemId: "r", field: "summary.0", delta: "Public " }),
    ...t.fromItem({
      ...start,
      revision: 2,
      status: "completed",
      summary: ["Public summary", "Second part"],
    }),
  ];
  const text = updates
    .flatMap((n) =>
      n.update.sessionUpdate === "agent_thought_chunk" && n.update.content.type === "text"
        ? [n.update.content.text]
        : [],
    )
    .join("");
  expect(text).toBe("Public summary\nSecond part");
  expect(
    t.fromItem({
      ...start,
      revision: 2,
      status: "completed",
      summary: ["Public summary", "Second part"],
    }),
  ).toEqual([]);
  expect(JSON.stringify(updates)).not.toContain("private");
});
it("keeps interleaved live tool output and inaccessible references correlated", () => {
  const t = new MuseSdkTranslator("root", silentLogger());
  const a = {
    itemId: "a",
    kind: "toolCall",
    tool: "bash",
    callId: "call-a",
    revision: 1,
    status: "inProgress",
    visibleOutput: "a",
  } as unknown as FoldedItem;
  const b = { ...a, itemId: "b", callId: "call-b", visibleOutput: "b" };
  t.fromItem(a);
  t.fromItem(b);
  expect(t.fromDelta({ itemId: "a", field: "output", delta: "1" })[0].update).toMatchObject({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-a",
  });
  const final = t.fromItem({
    ...b,
    revision: 2,
    status: "completed",
    truncated: true,
    outputRef: {
      availability: "missing",
      byteLen: 100,
      id: "output",
      kind: "tool_output",
      uri: "muse://output/fixture",
    },
    modelVisibleContent: [
      { type: "image", path: "/private/image", mediaType: "image/png", sourceToolName: "tool" },
    ],
  });
  expect(JSON.stringify(final)).toContain("binary data unavailable");
  expect(JSON.stringify(final)).toContain("retrieval is not enabled");
  expect(JSON.stringify(final)).not.toContain("/private/image");
  expect(
    t.fromItem({
      itemId: "future",
      kind: "futureThing",
      status: "pausedElsewhere",
      revision: 1,
      fallbackText: "Observed future detail",
    } as unknown as FoldedItem)[0].update,
  ).toMatchObject({ toolCallId: "future", title: "futureThing: pausedElsewhere" });
});

it("treats gap catch-up as absolute text for every streamed public surface", () => {
  const t = new MuseSdkTranslator("root", silentLogger());
  const base = { revision: 1, status: "inProgress" } as const;
  t.fromItem({ ...base, itemId: "a", kind: "agentMessage", text: "" });
  t.fromDelta({ itemId: "a", delta: "hello" });
  const caught = t.fromAccumulated("a", "text", "hello world");
  expect(JSON.stringify(caught)).toContain(" world");
  expect(t.fromAccumulated("a", "text", "hello world")).toEqual([]);
  t.fromItem({ ...base, itemId: "r", kind: "reasoning", summary: [] });
  t.fromDelta({ itemId: "r", field: "summary.0", delta: "public" });
  expect(JSON.stringify(t.fromAccumulated("r", "summary.0", "public summary"))).toContain(
    " summary",
  );
  expect(t.fromAccumulated("r", "summary.0", "public summary")).toEqual([]);
  t.fromItem({ ...base, itemId: "t", kind: "toolCall", callId: "call", visibleOutput: "" });
  t.fromDelta({ itemId: "t", field: "output", delta: "first" });
  expect(t.fromAccumulated("t", "output", "first second")[0].update).toMatchObject({
    toolCallId: "call",
  });
  expect(t.fromAccumulated("t", "output", "first second")).toEqual([]);
});

it("renders SDK 1.4.4 hook runs and side chats as generic cards", () => {
  const translator = new MuseSdkTranslator("root", { log() {}, error() {} });
  const [hook] = translator.fromItem({
    itemId: "hook",
    kind: "hookRun",
    turnId: "turn",
    revision: 1,
    status: "completed",
    event: "preToolUse",
    label: "lint before edits",
    runStatus: "blocked",
  });
  expect(hook.update).toMatchObject({
    sessionUpdate: "tool_call",
    title: "Hook preToolUse: lint before edits",
    kind: "other",
    status: "completed",
  });
  const [side] = translator.fromItem({
    itemId: "side",
    kind: "sideChat",
    turnId: "turn",
    revision: 1,
    status: "completed",
    sideSessionId: "side-session",
  });
  expect(side.update).toMatchObject({ title: "sideChat: completed", kind: "other" });
});
