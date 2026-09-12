import { methods } from "@agentclientprotocol/sdk";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, fixturesDir, newTestSession } from "./helpers.js";

function sdkClient(mode: string, barrier?: string) {
  const binary = join(fixturesDir, "fake-msp.cjs");
  chmodSync(binary, 0o755);
  return connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: mode,
      ...(barrier ? { FAKE_MSP_BARRIER: barrier } : {}),
      XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "muse-cancel-")),
    },
  });
}

describe("SDK cancellation races", () => {
  it.each(["handshake", "session", "ack"] as const)(
    "cancels during %s barrier and settles as cancelled",
    async (barrier) => {
      const client = sdkClient("block", barrier);
      const { ctx, sessionId } = await newTestSession(client);
      const prompt = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "blocked" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await ctx.notify(methods.agent.session.cancel, { sessionId });
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
    },
    15_000,
  );

  it("cancels while an approval is pending and rejects a late allow", async () => {
    const client = sdkClient("approval");
    let lateAllow = false;
    client.setPermissionResponder(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      lateAllow = true;
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
    const { ctx, sessionId } = await newTestSession(client);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "pending approval" }],
    });
    await expect.poll(() => client.permissionRequests.length).toBe(1);
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
    // Give the late responder time; it must not leave an active turn.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lateAllow).toBe(true);
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();

    client.setPermissionResponder(() => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "next" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("cancels during streaming and allows a second prompt after recovery", async () => {
    const blocked = sdkClient("block");
    const { ctx, sessionId } = await newTestSession(blocked);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "block" }],
    });
    await expect
      .poll(() => blocked.updates.some((u) => u.update.sessionUpdate === "agent_message_chunk"))
      .toBe(true);
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });

    const complete = sdkClient("complete");
    complete.setPermissionResponder(() => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const next = await newTestSession(complete);
    await expect(
      next.ctx.request(methods.agent.session.prompt, {
        sessionId: next.sessionId,
        prompt: [{ type: "text", text: "other" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
  }, 15_000);
});
