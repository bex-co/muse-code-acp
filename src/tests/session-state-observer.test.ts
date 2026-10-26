import { expect, it, vi } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { Connection, SessionFold, type Session } from "@muse-code/sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStateObserver,
  SESSION_STATE_EXTENSION,
  type SessionStateObservation,
} from "../session-state-observer.js";
import { connectTestClient, fixturesDir, newTestSession, ensureExecutable } from "./helpers.js";

it.each([false, true])(
  "reports observed state and post-resolve persistence over ACP (negotiated: %s)",
  async (negotiated) => {
    const root = mkdtempSync(join(tmpdir(), "muse-observe-"));
    const binary = join(fixturesDir, "fake-msp.cjs");
    ensureExecutable(binary);
    const capture = join(root, "requests.jsonl");
    const client = connectTestClient({
      backend: "sdk",
      museBinary: binary,
      skipSdkHostCheck: true,
      env: {
        ...process.env,
        FAKE_MSP_MODE: "approval",
        FAKE_MSP_OBSERVE: "1",
        FAKE_MSP_CAPTURE: capture,
      },
    });
    client.setPermissionResponder(() => ({
      outcome: { outcome: "selected", optionId: "allow-persistent" },
    }));
    try {
      const { ctx, sessionId } = await newTestSession(
        client,
        negotiated ? { _meta: { [SESSION_STATE_EXTENSION]: 1 } } : {},
      );
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "observe" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      const reports = () =>
        client.updates.flatMap((n) =>
          n.update._meta?.[SESSION_STATE_EXTENSION]
            ? [n.update._meta[SESSION_STATE_EXTENSION]]
            : [],
        );
      if (negotiated) {
        await expect
          .poll(() => reports())
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                model: { modelId: "host-model", providerId: "meta", source: "policy" },
                approvalMode: { mode: "denyUnmatched", source: "approvalReconfigure" },
              }),
              { policyPersistence: { approvalId: "apr1", status: "unverified" } },
              { policyPersistence: { approvalId: "apr1", status: "failed" } },
              { model: { modelId: "idle-model", source: "policy" } },
            ]),
          );
        expect(reports().filter((r) => JSON.stringify(r).includes("idle-model"))).toHaveLength(1);
        expect(JSON.stringify(reports())).not.toContain("secret-policy-detail");
      } else {
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(reports()).toEqual([]);
      }
      const requests = readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.filter((r) => r.method === "view/page").length > 0).toBe(negotiated);
      expect(requests.filter((r) => r.method === "approval/decide")).toHaveLength(1);
      // Observations never rewrite the ACP configuration; startup applies the requested policy once.
      expect(client.agent.sessions.get(sessionId)?.config.model).not.toBe("idle-model");
      expect(requests.filter((r) => r.method === "session/setApprovalMode")).toHaveLength(1);
      await ctx.request(methods.agent.session.close, { sessionId });
      const count = reports().length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(reports()).toHaveLength(count);
    } finally {
      await client.agent.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("keeps absent state absent, reports clears, and waits for a current fold", async () => {
  const seen: SessionStateObservation[] = [];
  const observer = new SessionStateObserver(
    "s",
    async (value) => {
      seen.push(value);
    },
    () => {},
  );
  const values = new Map<string, unknown>();
  const fold = {
    current: true,
    sessionState: { get: (key: string) => values.get(key) },
  } as Session["fold"];
  const connection = {} as Connection;
  await observer.poll(fold, connection);
  expect(seen).toEqual([]);
  values.set("session/modelChanged", null);
  await observer.poll({ ...fold, current: false }, connection);
  expect(seen).toEqual([]);
  await observer.poll(fold, connection);
  await observer.poll(fold, connection);
  expect(seen).toEqual([{ model: null }]);
});

it("bounds failed evidence reads and never invents persistence success", async () => {
  const reports: SessionStateObservation[] = [];
  const logs: string[] = [];
  const observer = new SessionStateObserver(
    "s",
    async (value) => {
      reports.push(value);
    },
    (line) => logs.push(line),
  );
  const request = vi.fn(async () => {
    throw new Error("private-host-detail");
  });
  const connection = { request } as unknown as Connection;
  const fold = new SessionFold();
  observer.watchPolicy("a", "opaque:observed");
  await observer.poll(fold, connection);
  await observer.poll(fold, connection);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("view/page", {
    sessionId: "s",
    cursor: "opaque:observed",
    direction: "forward",
    limit: 100,
  });
  expect(reports).toEqual([{ policyPersistence: { approvalId: "a", status: "unverified" } }]);
  expect(logs.join()).not.toContain("private-host-detail");
  observer.stop();
  await observer.poll(fold, connection);
  expect(request).toHaveBeenCalledTimes(1);
});

it("times out observation without retrying or publishing a late result after stop", async () => {
  vi.useFakeTimers();
  const reports: SessionStateObservation[] = [];
  let resolve!: (value: Record<string, unknown>) => void;
  const request = vi.fn(
    () =>
      new Promise<Record<string, unknown>>((r) => {
        resolve = r;
      }),
  );
  const observer = new SessionStateObserver(
    "s",
    async (value) => {
      reports.push(value);
    },
    () => {},
  );
  try {
    observer.watchPolicy("a", "observed");
    const poll = observer.poll(new SessionFold(), { request } as unknown as Connection);
    await vi.advanceTimersByTimeAsync(1001);
    await poll;
    observer.stop();
    resolve({
      events: [
        {
          method: "approval/updated",
          params: {
            sessionId: "s",
            approvalId: "a",
            viewCursor: "late",
            change: { kind: "policyPersistence", status: "succeeded" },
          },
        },
      ],
      nextCursor: null,
    });
    await Promise.resolve();
    expect(reports).toEqual([{ policyPersistence: { approvalId: "a", status: "unverified" } }]);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    observer.stop();
    vi.useRealTimers();
  }
});
