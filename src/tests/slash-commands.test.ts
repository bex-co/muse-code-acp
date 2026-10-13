import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../slash-commands.js";
const text = (text: string) => ({ type: "text" as const, text });
const context = {
  type: "resource" as const,
  resource: { uri: "file:///context", text: "/goal clear", mimeType: "text/plain" },
};
describe("slash command selection", () => {
  it.each([
    "/goal task",
    "/mcp explain",
    "/plan task",
    "/review focus",
    "/review-branch main focus",
    "/review-commit HEAD focus",
  ])("preserves surrounding content for %s", (command) => {
    const result = parseSlashCommand([
      context,
      text("extra instructions"),
      text(command),
      context,
    ])!;
    expect(result.index).toBe(2);
    expect(result.blocks[0]).toEqual(context);
    expect(result.blocks[1]).toEqual(text("extra instructions"));
    expect(result.blocks[3]).toEqual(context);
    expect(result.stop).not.toBe(true);
  });
  it.each([
    "/goalkeeper task",
    "quoted /plan work",
    "> /goal clear",
    "```\n/plan work\n```",
    "/compact",
    "/skill task",
  ])("does not reinterpret %s", (input) => {
    expect(parseSlashCommand([context, text(input)])).toBeUndefined();
  });
  it("normalizes names, merges duplicates and confines mixed operations to planning", () => {
    expect(parseSlashCommand([text("  /PLAN task  ")])?.workflow?.kind).toBe("plan");
    const duplicate = parseSlashCommand([text("/plan first"), text("/plan second")])!;
    expect(duplicate.blocks).toEqual([text("first"), text("second")]);
    const mixed = parseSlashCommand([text("/goal task"), text("/plan work")])!;
    expect(mixed.workflow?.kind).toBe("plan");
    expect(parseSlashCommand([text("/plan"), text("/review")])?.barePlan).toBe(false);
    expect(JSON.stringify(mixed.blocks)).toContain("Requested operation to plan");
    expect(parseSlashCommand([text("/review"), text("/mcp")])?.stop).toBe(true);
  });
  it("uses explicit review targets and conversational invalid-reference guidance", () => {
    expect(parseSlashCommand([text("/review-commit")])?.workflow).toMatchObject({ ref: "HEAD" });
    expect(parseSlashCommand([text("/review-branch")])?.workflow).toMatchObject({
      ref: "@{upstream}",
    });
    expect(parseSlashCommand([text("/review-branch --output=x")])?.stop).toBe(true);
    expect(parseSlashCommand([text("/review-commit HEAD security focus")])?.blocks).toEqual([
      text("security focus"),
    ]);
  });
  it("distinguishes goals, controls and status with a separate task", () => {
    expect(parseSlashCommand([text("/goal"), text("do work")])?.notice).toContain(
      "execute this task once",
    );
    for (const verb of ["pause", "resume", "clear"]) {
      expect(parseSlashCommand([text(`/goal ${verb} details`)])?.stop).toBe(true);
      expect(parseSlashCommand([text(`/goal ${verb}`)])?.goal).toEqual({ verb });
    }
    expect(parseSlashCommand([text("/goal edit details")])?.goal).toEqual({
      verb: "edit",
      objective: "details",
    });
    expect(parseSlashCommand([text("/goal set")])?.stop).toBe(true);
    expect(parseSlashCommand([text("/recap")])?.native).toEqual({ kind: "recap" });
    expect(parseSlashCommand([text("/recap please")])?.stop).toBe(true);
    expect(parseSlashCommand([text("/skills")])?.local).toEqual({ kind: "skills", argument: "" });
    expect(parseSlashCommand([text("/skills disable lint")])?.native).toEqual({
      kind: "skill",
      verb: "disable",
      selector: "lint",
    });
    expect(parseSlashCommand([text("/skills import codex --apply")])?.native).toEqual({
      kind: "skillImport",
      source: "codex",
      apply: true,
    });
    expect(parseSlashCommand([text("/skills wipe all")])?.stop).toBe(true);
    expect(parseSlashCommand([text("/feedback bad wrong answer --with-session")])?.native).toEqual({
      kind: "feedback",
      classification: "bad",
      note: "wrong answer",
      withSession: true,
    });
    expect(parseSlashCommand([text("/feedback")])?.stop).toBe(true);
    expect(parseSlashCommand([text("/goal set x"), text("more")])?.stop).toBe(true);
    expect(parseSlashCommand([context, text("/goal status")])?.stop).toBe(true);
    expect(parseSlashCommand([text("/goal status"), text("do work")])?.stop).toBe(false);
  });
});
