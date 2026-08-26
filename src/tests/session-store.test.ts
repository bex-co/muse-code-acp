import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStoredSessions } from "../session-store.js";
import { silentLogger } from "./helpers.js";

function fakeStore() {
  const xdg = mkdtempSync(join(tmpdir(), "muse-store-test-"));
  const write = (
    sessionId: string,
    workspace: string,
    prompt: string | null,
    day = "2026/08/25",
    extraLines: string[] = [],
  ) => {
    const dir = join(xdg, "muse", "sessions", day, sessionId);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        schema_version: 1,
        id: "r1",
        stream: { kind: "session", id: sessionId },
        sequence: 1,
        recorded_at: 1,
        record_type: "event",
        durability: "durable",
        payload_type: "runtime.session.metadata",
        payload_schema_version: 1,
        payload: { kind: "metadata", record: { workspace_root: workspace } },
      }),
      ...(prompt
        ? [
            JSON.stringify({
              schema_version: 1,
              id: "r2",
              stream: { kind: "session", id: sessionId },
              sequence: 2,
              recorded_at: 2,
              record_type: "event",
              durability: "durable",
              payload_type: "runtime.user_intent.accepted",
              payload_schema_version: 1,
              payload: { refill_blocks: [{ kind: "text", text: prompt }] },
            }),
          ]
        : []),
      ...extraLines,
    ];
    writeFileSync(join(dir, "session.jsonl"), lines.join("\n") + "\n");
    return join(dir, "session.jsonl");
  };
  return { xdg, write, env: { XDG_DATA_HOME: xdg } };
}

describe("listStoredSessions", () => {
  it("lists only sessions for the requested workspace, newest first", () => {
    const store = fakeStore();
    const ws = mkdtempSync(join(tmpdir(), "muse-store-ws-"));
    const other = mkdtempSync(join(tmpdir(), "muse-store-ws-"));
    const older = store.write("11111111-1111-4111-8111-111111111111", ws, "first prompt");
    store.write("22222222-2222-4222-8222-222222222222", other, "other workspace");
    store.write("33333333-3333-4333-8333-333333333333", ws, "second prompt");
    utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));

    const sessions = listStoredSessions(ws, store.env, silentLogger());

    expect(sessions.map((s) => s.sessionId)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(sessions[0].title).toBe("second prompt");
  });

  it("lists everything when cwd is null and titles missing prompts", () => {
    const store = fakeStore();
    store.write("44444444-4444-4444-8444-444444444444", "/anywhere", null);

    const sessions = listStoredSessions(null, store.env, silentLogger());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("(no prompt)");
  });

  it("skips corrupt logs without failing the listing", () => {
    const store = fakeStore();
    const ws = mkdtempSync(join(tmpdir(), "muse-store-ws-"));
    store.write("55555555-5555-4555-8555-555555555555", ws, "good");
    const badDir = join(store.xdg, "muse", "sessions", "2026/08/25", "bad-session");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "session.jsonl"), "total garbage\n");

    const sessions = listStoredSessions(ws, store.env, silentLogger());
    expect(sessions.map((s) => s.sessionId)).toEqual(["55555555-5555-4555-8555-555555555555"]);
  });

  it("truncates long titles and reads only the log head on large files", () => {
    const store = fakeStore();
    const ws = mkdtempSync(join(tmpdir(), "muse-store-ws-"));
    const longPrompt = "p".repeat(300);
    // ~2MB of filler after the head records: listing must stay correct.
    const filler = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ padding: "x".repeat(1000), line: i }),
    );
    store.write("66666666-6666-4666-8666-666666666666", ws, longPrompt, "2026/08/25", filler);

    const sessions = listStoredSessions(ws, store.env, silentLogger());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title.length).toBeLessThanOrEqual(80);
    expect(sessions[0].title.endsWith("…")).toBe(true);
  });

  it("returns empty on a missing store", () => {
    expect(
      listStoredSessions(null, { XDG_DATA_HOME: "/nonexistent-store" }, silentLogger()),
    ).toEqual([]);
  });
});
