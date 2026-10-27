import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { methods } from "@agentclientprotocol/sdk";
import { createWireFixture } from "./acp-wire-helpers.js";
import { connectTestClient, fixturesDir, silentLogger, newTestSession } from "./helpers.js";
import { sessionInfo } from "../session-discovery.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("traverses 123 public rows in bounded pages without acquiring a writer lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "m19-pages-"));
  roots.push(root);
  const data = join(root, "sessions.json");
  const rows = Array.from({ length: 123 }, (_, i) => ({
    sessionId: `s${i}`,
    workspaceRoot: realpathSync(root),
    path: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 123 - i)).toISOString(),
    forkedFrom: i === 52 ? { sessionId: "s1", cutCursor: "cut-1", cutExplicit: true } : null,
  }));
  writeFileSync(data, JSON.stringify(rows));
  const wire = await createWireFixture({
    env: { FAKE_MSP_SESSIONS: data },
    clientCapabilities: { _meta: { "muse/fork": 1 } },
  });
  try {
    const found = [];
    let cursor: string | undefined;
    do {
      const page = await wire.ctx.request(methods.agent.session.list, {
        cwd: root,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.sessions.length).toBeLessThanOrEqual(50);
      found.push(...page.sessions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found.map((s) => s.sessionId)).toEqual(rows.map((s) => s.sessionId));
    expect(found[52]!._meta).toMatchObject({
      "muse/fork": { sourceSessionId: "s1", cutCursor: "cut-1" },
    });
    const first = await wire.ctx.request(methods.agent.session.list, { cwd: root });
    await expect(
      wire.ctx.request(methods.agent.session.list, {
        cwd: wire.workspace,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      wire.ctx.request(methods.agent.session.list, { cwd: root, cursor: "bad!" }),
    ).rejects.toMatchObject({ code: -32602 });
    const requests = wire.getTranscript().mspRequests as { method: string }[];
    expect(
      requests.some((r) => ["session/start", "session/resume", "turn/start"].includes(r.method)),
    ).toBe(false);
  } finally {
    await wire.dispose();
  }
});
it("uses bounded first-prompt titles only when no authoritative title exists", () => {
  const root = mkdtempSync(join(tmpdir(), "m19-title-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(
    path,
    [
      {
        stream: { id: "s" },
        payload_type: "runtime.session.metadata",
        payload: { record: { workspace_root: root } },
      },
      {
        payload_type: "runtime.user_intent.accepted",
        payload: { refill_blocks: [{ text: "first prompt" }] },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
  const row = { sessionId: "s", workspaceRoot: root, path, updatedAt: "2026-01-01T00:00:00Z" };
  expect(sessionInfo(row).title).toBe("first prompt");
  expect(sessionInfo({ ...row, title: "renamed by host" }).title).toBe("renamed by host");
  expect(sessionInfo({ ...row, sessionId: "wrong" }).title).toBe("(no prompt)");
  expect(readFileSync(path, "utf8")).toContain("first prompt");
  expect(() => sessionInfo({ ...row, workspaceRoot: null })).toThrow("invalid session");
});

it("disposal stops an outstanding discovery host and waits for cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "m19-dispose-"));
  roots.push(root);
  const capture = join(root, "requests.jsonl"),
    pid = join(root, "pid");
  const client = connectTestClient(
    {
      backend: "sdk",
      skipSdkHostCheck: true,
      museBinary: join(fixturesDir, "fake-msp.cjs"),
      env: {
        ...process.env,
        FAKE_MSP_MODE: "list-delay",
        FAKE_MSP_CAPTURE: capture,
        FAKE_MSP_PID: pid,
      },
    },
    silentLogger(),
  );
  const operation = client.agent.listSessions({ cwd: root });
  const rejected = expect(operation).rejects.toThrow();
  try {
    await expect
      .poll(() => {
        try {
          return readFileSync(capture, "utf8").includes('"session/list"');
        } catch {
          return false;
        }
      })
      .toBe(true);
    await client.agent.dispose();
    await rejected;
    expect(() => process.kill(Number(readFileSync(pid, "utf8")), 0)).toThrow();
  } finally {
    await client.agent.dispose();
  }
});

it("metadata timeout preserves completion and retires the host without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "m19-timeout-"));
  roots.push(root);
  const capture = join(root, "requests.jsonl");
  const client = connectTestClient(
    {
      backend: "sdk",
      skipSdkHostCheck: true,
      museBinary: join(fixturesDir, "fake-msp.cjs"),
      env: {
        ...process.env,
        META_API_KEY: "dummy",
        FAKE_MSP_MODE: "metadata-timeout",
        FAKE_MSP_CAPTURE: capture,
      },
    },
    silentLogger(),
  );
  try {
    const { ctx, sessionId, cwd } = await newTestSession(client);
    roots.push(cwd);
    for (let i = 0; i < 2; i++) {
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "complete" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(client.agent.sessions.get(sessionId)?.sdkHost?.owner.closed).toBe(true);
    }
    const requests = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(requests.filter((x) => x.method === "turn/start")).toHaveLength(2);
  } finally {
    await client.agent.dispose();
  }
});
