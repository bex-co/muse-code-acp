import { methods } from "@agentclientprotocol/sdk";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseAcpAgent } from "../acp-agent.js";
import {
  connectTestClient,
  fakeMuseBinary,
  museAvailable,
  newTestSession,
  silentLogger,
} from "./helpers.js";

type MuseCapture = {
  images: Array<{ path: string }>;
};

function capturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-close-capture-")), "capture.json");
}

function blockingClient(capture: string) {
  return connectTestClient({
    museBinary: fakeMuseBinary(),
    env: {
      ...process.env,
      FAKE_MUSE_ARGV_CAPTURE: capture,
      FAKE_MUSE_MODE: "block",
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for fake Muse");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findSessionLog(root: string, sessionId: string): string | undefined {
  const visit = (directory: string): string | undefined => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = join(directory, entry.name);
      if (entry.name === sessionId && existsSync(join(child, "session.jsonl"))) {
        return join(child, "session.jsonl");
      }
      const found = visit(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return visit(join(root, "muse", "sessions"));
}

describe("session/close", () => {
  it("closes an idle session and rejects later prompts", async () => {
    const testClient = blockingClient(capturePath());
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(ctx.request(methods.agent.session.close, { sessionId })).resolves.toEqual({});

    expect(testClient.agent.sessions.has(sessionId)).toBe(false);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "after close" }],
      }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/unknown session/) });
  });

  it("waits for an active turn and its image cleanup before acknowledging close", async () => {
    const capture = capturePath();
    const testClient = blockingClient(capture);
    const { ctx, sessionId } = await newTestSession(testClient);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data: "YQ==", mimeType: "image/png" },
        { type: "text", text: "Wait for close." },
      ],
    });
    await waitFor(
      () => existsSync(capture) && Boolean(testClient.agent.sessions.get(sessionId)?.activeTurn),
    );
    const pid = testClient.agent.sessions.get(sessionId)?.activeTurn?.pid;
    if (!pid) {
      throw new Error("fake Muse did not expose its process id");
    }
    const captured = JSON.parse(readFileSync(capture, "utf8")) as MuseCapture;
    const imagePath = captured.images[0]?.path;
    if (!imagePath) {
      throw new Error("fake Muse did not capture its image path");
    }

    const close = ctx.request(methods.agent.session.close, { sessionId });

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(close).resolves.toEqual({});
    expect(testClient.agent.sessions.has(sessionId)).toBe(false);
    expect(processIsAlive(pid)).toBe(false);
    expect(existsSync(dirname(imagePath))).toBe(false);
  });

  it("revokes admission before a close issued during image staging waits", async () => {
    const capture = capturePath();
    const testClient = blockingClient(capture);
    const { sessionId } = await newTestSession(testClient);
    const prompt = testClient.agent.prompt({
      sessionId,
      prompt: [
        { type: "image", data: "YQ==", mimeType: "image/png" },
        { type: "text", text: "Close before spawn." },
      ],
    });

    const close = testClient.agent.closeSession({ sessionId });

    await expect(
      testClient.agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Do not admit this." }],
      }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/unknown session/) });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(close).resolves.toEqual({});
    expect(existsSync(capture)).toBe(false);
  });

  it("rejects a concurrent second close after admission is revoked", async () => {
    const capture = capturePath();
    const testClient = blockingClient(capture);
    const { sessionId } = await newTestSession(testClient);
    const prompt = testClient.agent.prompt({
      sessionId,
      prompt: [
        { type: "image", data: "YQ==", mimeType: "image/png" },
        { type: "text", text: "Wait for close." },
      ],
    });

    const firstClose = testClient.agent.closeSession({ sessionId });

    await expect(testClient.agent.closeSession({ sessionId })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/unknown session/),
    });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(firstClose).resolves.toEqual({});
  });

  it("acknowledges close when the active prompt rejects during unwind", async () => {
    const updateEntered = Promise.withResolvers<void>();
    const releaseUpdate = Promise.withResolvers<void>();
    const agent = new MuseAcpAgent(
      {
        sessionUpdate: async (notification) => {
          if (notification.update.sessionUpdate !== "agent_message_chunk") {
            return;
          }
          updateEntered.resolve();
          await releaseUpdate.promise;
          throw new Error("client update failed");
        },
      },
      silentLogger(),
      {
        museBinary: fakeMuseBinary(),
        env: { ...process.env, FAKE_MUSE_MODE: "block" },
      },
    );
    const { sessionId } = await agent.newSession({
      cwd: mkdtempSync(join(tmpdir(), "muse-close-rejection-")),
      mcpServers: [],
    });
    const prompt = agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Reject while closing." }],
    });
    await updateEntered.promise;

    const close = agent.closeSession({ sessionId });
    releaseUpdate.resolve();

    await expect(prompt).rejects.toThrow("client update failed");
    await expect(close).resolves.toEqual({});
    expect(agent.sessions.has(sessionId)).toBe(false);
  });

  it.skipIf(!museAvailable())(
    "preserves the native Muse session log",
    async () => {
      const xdg = mkdtempSync(join(tmpdir(), "muse-close-xdg-"));
      const testClient = connectTestClient({
        provider: "echo",
        env: { ...process.env, XDG_DATA_HOME: xdg },
      });
      const { ctx, sessionId } = await newTestSession(testClient);

      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "repeat close-log-token" }],
      });
      const logPath = findSessionLog(xdg, sessionId);
      if (!logPath) {
        throw new Error("Muse did not create its retained session log");
      }

      await ctx.request(methods.agent.session.close, { sessionId });

      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain("close-log-token");
      const listed = await ctx.request(methods.agent.session.list, { cwd: null });
      expect(listed.sessions.some((session) => session.sessionId === sessionId)).toBe(true);
    },
    60_000,
  );
});
