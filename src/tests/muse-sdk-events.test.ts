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
