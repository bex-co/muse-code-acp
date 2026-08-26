import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectTestClient,
  fakeMuseBinary,
  initialized,
  museAvailable,
  TestClient,
} from "./helpers.js";
import { sleep } from "../utils.js";

async function newSession(testClient: TestClient) {
  const ctx = await initialized(testClient);
  const cwd = mkdtempSync(join(tmpdir(), "muse-prompt-test-"));
  const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
  return { ctx, sessionId, cwd };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(10);
  }
}

describe.skipIf(!museAvailable())("session/prompt (live echo provider)", () => {
  it("streams text chunks and settles with end_turn", async () => {
    const testClient = connectTestClient({
      provider: "echo",
      env: { ...process.env, XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "muse-xdg-")) },
    });
    const { ctx, sessionId } = await newSession(testClient);

    // Not "hello": muse special-cases greeting prompts with a canned reply
    // that bypasses the provider entirely (verified on muse 0.2.1).
    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "repeat the token zx12" }],
    });

    expect(response.stopReason).toBe("end_turn");
    const chunks = testClient.updates
      .filter((u) => u.sessionId === sessionId)
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.map((c) => (c.content.type === "text" ? c.content.text : "")).join("");
    expect(text).toContain("echo: repeat the token zx12");
    expect(testClient.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  }, 30_000);
});

describe("session/prompt (fake muse)", () => {
  it("cancel mid-turn settles the prompt with cancelled", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const { ctx, sessionId } = await newSession(testClient);

    const promptPromise = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "block forever" }],
    });
    await waitFor(() => testClient.updates.length > 0);
    await ctx.notify(methods.agent.session.cancel, { sessionId });

    const response = await promptPromise;
    expect(response.stopReason).toBe("cancelled");
    expect(testClient.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  }, 15_000);

  it("rejects a concurrent prompt on a busy session", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const { ctx, sessionId } = await newSession(testClient);

    const first = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "block forever" }],
    });
    await waitFor(() => testClient.updates.length > 0);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "second" }],
      }),
    ).rejects.toMatchObject({ code: -32600 });

    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
  }, 15_000);

  it("prompting again after cancel works on the same session", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const { ctx, sessionId } = await newSession(testClient);

    const first = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "one" }],
    });
    await waitFor(() => testClient.updates.length > 0);
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await first;

    const before = testClient.updates.length;
    const second = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "two" }],
    });
    await waitFor(() => testClient.updates.length > before);
    await ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(second).resolves.toMatchObject({ stopReason: "cancelled" });
  }, 15_000);

  it("rejects prompts without text content", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const { ctx, sessionId } = await newSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, { sessionId, prompt: [] }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
