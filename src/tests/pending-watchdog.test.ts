/**
 * Unit coverage for the stall bound, plus end-to-end proof that a host which
 * accepts a decision and then goes silent fails the prompt with diagnostics
 * instead of hanging (w2/m1 t003).
 */
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_LIMIT_MS,
  PendingWorkWatchdog,
  stallLimitMs,
  type PendingWorkItem,
} from "../pending-watchdog.js";
import { connectTestClient, fixturesDir, newTestSession, ensureExecutable } from "./helpers.js";

function item(overrides: Partial<PendingWorkItem> = {}): PendingWorkItem {
  return {
    kind: "approval",
    id: "apr1",
    signature: "0|allow_once,abort",
    inFlight: false,
    detail: "Muse approval apr1 is still pending",
    ...overrides,
  };
}

describe("pending work watchdog", () => {
  it("reports a stall only after the bound elapses with no progress", () => {
    let now = 1_000;
    const watchdog = new PendingWorkWatchdog(10_000, () => now);
    expect(watchdog.check([item()])).toBeUndefined();
    now += 9_999;
    expect(watchdog.check([item()])).toBeUndefined();
    now += 1;
    expect(watchdog.check([item()])).toMatch(/still pending; no host progress for 10s/);
  });

  it("treats a changed host signature as progress", () => {
    let now = 0;
    const watchdog = new PendingWorkWatchdog(1_000, () => now);
    watchdog.check([item()]);
    now += 2_000;
    // The requirement advanced: the host is working, so the clock restarts.
    expect(watchdog.check([item({ signature: "2|allow_once,abort" })])).toBeUndefined();
    now += 2_000;
    expect(watchdog.check([item({ signature: "2|allow_once,abort" })])).toMatch(/no host progress/);
  });

  it("never trips while the client is deciding", () => {
    let now = 0;
    const watchdog = new PendingWorkWatchdog(1_000, () => now);
    for (let tick = 0; tick < 10; tick++) {
      now += 1_000;
      expect(watchdog.check([item({ inFlight: true })])).toBeUndefined();
    }
    // Once the dialog closes the bound runs from the last in-flight tick.
    now += 500;
    expect(watchdog.check([item()])).toBeUndefined();
    now += 500;
    expect(watchdog.check([item()])).toMatch(/no host progress/);
  });

  it("forgets items the host resolved, and resets at a turn boundary", () => {
    let now = 0;
    const watchdog = new PendingWorkWatchdog(1_000, () => now);
    watchdog.check([item()]);
    expect(watchdog.check([])).toBeUndefined();
    now += 5_000;
    // Re-appearing later starts a fresh clock rather than inheriting the old one.
    expect(watchdog.check([item()])).toBeUndefined();
    watchdog.reset();
    now += 5_000;
    expect(watchdog.check([item()])).toBeUndefined();
  });

  it("reads the configured bound and ignores unusable values", () => {
    expect(stallLimitMs({})).toBe(DEFAULT_STALL_LIMIT_MS);
    expect(stallLimitMs({ MUSE_CODE_ACP_STALL_MS: "250" })).toBe(250);
    expect(stallLimitMs({ MUSE_CODE_ACP_STALL_MS: "0" })).toBe(DEFAULT_STALL_LIMIT_MS);
    expect(stallLimitMs({ MUSE_CODE_ACP_STALL_MS: "later" })).toBe(DEFAULT_STALL_LIMIT_MS);
  });
});

function stallingClient(script: string) {
  const binary = join(fixturesDir, "fake-msp.cjs");
  ensureExecutable(binary);
  mkdtempSync(join(tmpdir(), "muse-stall-"));
  return connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_SCRIPT: script,
      MUSE_CODE_ACP_STALL_MS: "400",
    },
  });
}

describe("stalled host requests fail the prompt", () => {
  it("fails with the approval's requirement and stage evidence when the host goes silent", async () => {
    const client = stallingClient("decide-then-silence");
    client.setPermissionResponder(() => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "silent host" }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "Muse approval apr-staged is still pending at requirement 0",
      ),
    });
    expect(client.permissionRequests).toHaveLength(1);
  }, 20_000);

  it("fails when an answered user input is never settled, without re-asking", async () => {
    const client = stallingClient("userinput-settle-then-silence");
    client.setElicitationResponder(() => ({
      action: "accept",
      content: { q1: "red" },
    }));
    const { ctx, sessionId } = await newTestSession(client, {
      elicitation: { form: {} },
    });
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "silent after answer" }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Muse user input ui1 is still pending"),
    });
    // The fold still lists the prompt; the adapter must not ask a second time.
    expect(client.elicitationRequests).toHaveLength(1);
  }, 20_000);

  it("does not trip on an approval the host is still advancing", async () => {
    const client = stallingClient("three-stage");
    client.setPermissionResponder(
      () =>
        new Promise((resolve) =>
          // Each dialog outlives the bound; an open dialog is not a stall.
          setTimeout(
            () => resolve({ outcome: { outcome: "selected", optionId: "allow_once" } }),
            600,
          ),
        ),
    );
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "slow user" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(client.permissionRequests).toHaveLength(3);
  }, 20_000);
});
