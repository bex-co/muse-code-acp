import { afterEach, expect, test } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MuseSdkHost,
  readMuseSdkSession,
  spawnMuseSdkTurn,
  type MuseSdkOptions,
} from "../muse-sdk.js";
import { fixturesDir, silentLogger } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture(mode = "complete", idleTimeoutMs = 60_000, maxTurns = 32, observeGoal = false) {
  const root = mkdtempSync(join(tmpdir(), "muse-reuse-"));
  const binary = join(root, "host.cjs");
  copyFileSync(join(fixturesDir, "fake-msp.cjs"), binary);
  chmodSync(binary, 0o755);
  const capture = join(root, "requests");
  let closed = 0;
  const options: MuseSdkOptions = {
    sessionId: "019546d0-60fa-7aaa-b111-111111111111",
    cwd: root,
    input: [{ type: "text", text: "hello" }],
    model: "muse-spark-1.2",
    reasoningEffort: "high",
    readOnly: false,
    museBinary: binary,
    env: {
      ...process.env,
      FAKE_MSP_MODE: mode,
      FAKE_MSP_STEER: "scripted",
      FAKE_MSP_CAPTURE: capture,
      FAKE_MSP_PID: join(root, "pid"),
    },
    logger: silentLogger(),
    checkHost: false,
    acpClient: {
      async sessionUpdate() {},
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      async createElicitation() {
        return { action: "cancel" };
      },
    },
  };
  const owner = new MuseSdkHost({
    ...options,
    idleTimeoutMs,
    maxTurns,
    ...(observeGoal ? { onGoal: () => {} } : {}),
    onClose: async () => {
      closed++;
    },
  });
  cleanup.push(async () => {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  });
  const requests = () =>
    readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const pid = () => Number(readFileSync(join(root, "pid"), "utf8"));
  return { options, owner, requests, pid, closed: () => closed };
}

test("compatible consecutive turns retain one host and release it exactly once", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const turn = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
    expect(await turn.done).toEqual({ stopReason: "end_turn" });
    const updates = [];
    for await (const update of turn.updates) updates.push(update);
    expect(updates.length).toBeGreaterThan(0);
    expect(f.owner.reusable).toBe(true);
    expect(turn.activeTurnId).toBeUndefined();
  }
  expect(f.requests().filter((r) => r.method === "initialize")).toHaveLength(1);
  expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(2);
  expect(() => process.kill(f.pid(), 0)).not.toThrow();
  await Promise.all([f.owner.close(), f.owner.close()]);
  expect(f.closed()).toBe(1);
  expect(() => process.kill(f.pid(), 0)).toThrow();
});

test("idle expiry closes host and releases its overlay callback", async () => {
  const f = fixture("complete", 30);
  await spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner }).done;
  await expect.poll(f.closed).toBe(1);
  expect(f.owner.closed).toBe(true);
  expect(() => process.kill(f.pid(), 0)).toThrow();
});

test("saved auto-review profiles fail with an actionable host limitation without replay", async () => {
  const f = fixture("autoReviewUnavailable");
  const turn = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
  await expect(turn.done).rejects.toThrow(
    "This Muse host cannot resume a saved session using the :auto-review permission profile",
  );
  await expect(turn.done).rejects.toThrow("start a new ACP session");
  await expect(turn.done).rejects.not.toThrow("internal error: compose");
  expect(f.requests().filter((r) => r.method === "session/resume")).toHaveLength(1);
  expect(
    f
      .requests()
      .some((r) => ["session/start", "turn/start", "session/setApprovalMode"].includes(r.method)),
  ).toBe(false);
  expect(f.owner.closed).toBe(true);
});

test("a refused auto-review read fails load with the same actionable limitation", async () => {
  const f = fixture("autoReviewReadRefused");
  const read = readMuseSdkSession(f.options);
  await expect(read).rejects.toThrow(
    "This Muse host cannot resume a saved session using the :auto-review permission profile",
  );
  await expect(read).rejects.toThrow("No model turn was submitted");
  await expect(read).rejects.not.toThrow("retained session refused");
  await expect(read).rejects.toMatchObject({
    code: -32603,
    data: { failure: { source: "host", kind: "legacyProfileUnavailable", outcome: "failed" } },
  });
  expect(f.requests().map((r) => r.method)).not.toContain("session/resume");
});

test("retention expiry closes a host with active native goal work and releases resources once", async () => {
  const f = fixture("nativeGoal", 30, 32, true);
  await expect(spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner }).done).resolves.toEqual({
    stopReason: "end_turn",
  });
  expect(f.owner.hasActiveTurn).toBe(true);
  expect(f.owner.closed).toBe(false);
  expect(() => process.kill(f.pid(), 0)).not.toThrow();
  await expect.poll(f.closed).toBe(1);
  expect(f.owner.closed).toBe(true);
  expect(() => process.kill(f.pid(), 0)).toThrow();
  await f.owner.close();
  expect(f.closed()).toBe(1);
});

test("steering targets only an acknowledged active turn and never a later turn", async () => {
  const f = fixture("block");
  const first = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner, steering: true });
  await expect(first.steer([{ type: "text", text: "too early" }], "absent")).rejects.toMatchObject({
    code: -32600,
  });
  await expect.poll(() => first.activeTurnId).toBeTypeOf("string");
  const target = first.activeTurnId!;
  await expect(first.steer([{ type: "text", text: "wrong" }], "other")).rejects.toMatchObject({
    code: -32600,
  });
  expect(await first.steer([{ type: "text", text: "correct" }], target)).toEqual({
    turnId: target,
    status: "accepted",
  });
  expect(await first.done).toEqual({ stopReason: "end_turn" });
  const metadata = [];
  for await (const notification of first.updates) {
    // Steering metadata only: a turn also announces host compatibility, and
    // other negotiated `_meta` keys ride the same notification kind.
    if (
      notification.update.sessionUpdate === "session_info_update" &&
      notification.update._meta &&
      "muse/activeTurnId" in notification.update._meta
    )
      metadata.push(notification.update._meta);
  }
  expect(metadata).toEqual([{ "muse/activeTurnId": target }, { "muse/activeTurnId": null }]);
  const second = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
  await expect.poll(() => second.activeTurnId).toBeTypeOf("string");
  await expect(first.steer([{ type: "text", text: "stale" }], target)).rejects.toMatchObject({
    code: -32600,
  });
  expect(f.requests().filter((r) => r.method === "turn/steer")).toHaveLength(1);
  second.kill();
  expect(await second.done).toEqual({ stopReason: "cancelled" });
  expect(f.owner.closed).toBe(true);
});

test("host death fails one active turn without replay and incompatible settings are rejected", async () => {
  const f = fixture("block");
  const turn = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
  const failure = expect(turn.done).rejects.toMatchObject({ code: -32603 });
  await expect.poll(() => turn.activeTurnId).toBeTypeOf("string");
  process.kill(f.pid(), "SIGKILL");
  await failure;
  expect(f.owner.closed).toBe(true);
  expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
  const changed = fixture();
  await expect(
    spawnMuseSdkTurn({ ...changed.options, model: "other", hostOwner: changed.owner }).done,
  ).rejects.toMatchObject({ code: -32603 });
});

test("unknown steering status is not success and closing settles a hung acknowledgement", async () => {
  const f = fixture("block");
  const turn = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
  await expect.poll(() => turn.activeTurnId).toBeTypeOf("string");
  await expect(
    turn.steer([{ type: "text", text: "bad-status" }], turn.activeTurnId!),
  ).rejects.toMatchObject({ code: -32603 });
  const steering = turn.steer([{ type: "text", text: "hang" }], turn.activeTurnId!);
  const steeringFailure = expect(steering).rejects.toThrow();
  const turnFailure = expect(turn.done).rejects.toMatchObject({ code: -32603 });
  await f.owner.close();
  await Promise.all([steeringFailure, turnFailure]);
  expect(f.closed()).toBe(1);
});

test("bounded successful turns rotate an idle host and release its resources", async () => {
  const f = fixture("complete", 60_000, 2);
  await spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner }).done;
  expect(f.owner.reusable).toBe(true);
  await spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner }).done;
  expect(f.owner.reusable).toBe(false);
  expect(f.owner.closed).toBe(true);
  expect(f.closed()).toBe(1);
  expect(() => process.kill(f.pid(), 0)).toThrow();
  expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(2);
});

test("completion with an unacknowledged correction retires the host before reuse", async () => {
  const f = fixture("block");
  const turn = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
  await expect.poll(() => turn.activeTurnId).toBeTypeOf("string");
  const failed = expect(
    turn.steer([{ type: "text", text: "complete-without-ack" }], turn.activeTurnId!),
  ).rejects.toThrow();
  expect(await turn.done).toEqual({ stopReason: "end_turn" });
  await failed;
  expect(f.owner.reusable).toBe(false);
  expect(f.closed()).toBe(1);
  expect(f.requests().filter((r) => r.method === "turn/steer")).toHaveLength(1);
  expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
});

test("an acknowledgement deadline fails the active turn without replay", async () => {
  const f = fixture("block");
  const turn = spawnMuseSdkTurn({ ...f.options, hostOwner: f.owner });
  await expect.poll(() => turn.activeTurnId).toBeTypeOf("string");
  const turnFailure = expect(turn.done).rejects.toMatchObject({ code: -32603 });
  await expect(turn.steer([{ type: "text", text: "hang" }], turn.activeTurnId!)).rejects.toThrow(
    "outcome is unknown",
  );
  await turnFailure;
  expect(f.owner.closed).toBe(true);
  expect(f.requests().filter((r) => r.method === "turn/steer")).toHaveLength(1);
  expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
}, 15_000);
