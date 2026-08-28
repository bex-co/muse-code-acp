import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMuseExec } from "../muse-exec.js";
import { connectTestClient, fakeMuseBinary, newTestSession, silentLogger } from "./helpers.js";

function fakeMuseClient(
  mode: "block" | "exit1" | "exit2" | "failterm" | "autherr" | "maxsteps" | "approval",
) {
  return connectTestClient({
    museBinary: fakeMuseBinary(),
    env: { ...process.env, FAKE_MUSE_MODE: mode },
  });
}

describe("prompt failure modes", () => {
  it("fails a headless approval wait promptly instead of hanging", async () => {
    const testClient = fakeMuseClient("approval");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "request an approval" }],
      }),
    ).rejects.toMatchObject({
      code: -32603,
      message: expect.stringMatching(/cannot route headless approvals through ACP/),
    });
    expect(testClient.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  });
  it("exit 1 without a terminal event rejects as an internal error", async () => {
    const testClient = fakeMuseClient("exit1");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "fail please" }],
      }),
    ).rejects.toMatchObject({ code: -32603, message: expect.stringMatching(/exit 1/) });
    // The turn must be settled so the session is usable again.
    expect(testClient.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  });

  it("exit 2 (usage error) rejects, naming the cause and the spawned argv", async () => {
    const testClient = fakeMuseClient("exit2");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "anything" }],
      }),
    ).rejects.toMatchObject({
      code: -32603,
      message: expect.stringMatching(/rejected[\s\S]*argv:.*exec --json --session-id/),
    });
  });

  it("exit 1 with a terminal reason carries the reason in the error", async () => {
    const testClient = fakeMuseClient("failterm");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({
      code: -32603,
      message: expect.stringMatching(/model stream failed after 10 attempts/),
    });
  });

  it("classifies auth failures as auth_required", async () => {
    const testClient = fakeMuseClient("autherr");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/muse login|META_API_KEY/) });
  });

  it("maps a max-model-steps cap to the max_turn_requests stop reason", async () => {
    const testClient = fakeMuseClient("maxsteps");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "x" }],
      }),
    ).resolves.toEqual({ stopReason: "max_turn_requests" });
  });

  it("cancel for an unknown session is a harmless no-op", async () => {
    const testClient = fakeMuseClient("block");
    const { ctx, sessionId } = await newTestSession(testClient);

    await ctx.notify(methods.agent.session.cancel, { sessionId: crypto.randomUUID() });

    // The agent is still alive and serving the real session.
    const response = await ctx.request(methods.agent.session.new, {
      cwd: mkdtempSync(join(tmpdir(), "muse-failure-test-")),
      mcpServers: [],
    });
    expect(response.sessionId).not.toBe(sessionId);
  });

  it("double-cancel does not break the turn settlement", async () => {
    const testClient = fakeMuseClient("block");
    const { ctx, sessionId } = await newTestSession(testClient);

    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "block" }],
    });
    // Wait for the delta chunk proving the child is up.
    while (testClient.updates.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await ctx.notify(methods.agent.session.cancel, { sessionId });

    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
  });
});

describe("spawnMuseExec failure outcomes", () => {
  it("maps SIGTERM to cancelled with exit 143", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "muse-failure-test-"));
    const handle = spawnMuseExec({
      prompt: "block",
      sessionId: crypto.randomUUID(),
      cwd,
      museBinary: fakeMuseBinary(),
      logger: silentLogger(),
    });
    await handle.events[Symbol.asyncIterator]().next();
    handle.kill("SIGTERM");
    expect(await handle.done).toEqual({ kind: "cancelled", code: 143, signal: null });
  });

  it("maps a missing binary to a failed outcome without throwing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "muse-failure-test-"));
    const handle = spawnMuseExec({
      prompt: "x",
      sessionId: crypto.randomUUID(),
      cwd,
      museBinary: join(cwd, "does-not-exist"),
      logger: silentLogger(),
    });
    expect(await handle.done).toEqual({ kind: "failed", code: -1 });
  });
});
