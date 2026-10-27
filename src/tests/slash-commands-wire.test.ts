import { expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWireFixture } from "./acp-wire-helpers.js";
import { CAT_IMAGE_BASE64 } from "./fixtures/cat-image.js";
const text = (text: string) => ({ type: "text" as const, text });
const context = {
  type: "resource" as const,
  resource: { uri: "file:///context.txt", text: "context-marker", mimeType: "text/plain" },
};
it("executes decorated tasks once, preserves context and honors workflow semantics", async () => {
  const wire = await createWireFixture();
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wire.workspace });
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(wire.workspace, ".gitignore"), "*\n");
    git("add", "-f", ".gitignore");
    git("commit", "-qm", "fixture");
    for (const command of [
      "/goal bump muse spark acp's version and try with it to scan a small directory and ensure it works",
      "/plan task",
      "/review security",
      "/review-branch HEAD security",
      "/review-commit HEAD security",
      "/mcp explain this configuration",
    ]) {
      const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
        cwd: wire.workspace,
        mcpServers: [],
      });
      const before = wire.getTranscript().mspRequests.length;
      await expect(
        wire.ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [
            context,
            text("additional-task-marker"),
            text(command),
            context,
            { type: "image", data: CAT_IMAGE_BASE64, mimeType: "image/png" },
          ],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      const requests = wire.getTranscript().mspRequests.slice(before) as {
        method: string;
        params: any;
      }[];
      const turns = requests.filter((r) => r.method === "turn/start");
      expect(turns).toHaveLength(1);
      const input = JSON.stringify(turns[0]!.params.input);
      expect(input).toContain("context-marker");
      expect(turns[0]!.params.input.some((part: { type: string }) => part.type === "image")).toBe(
        true,
      );
      expect(input).toContain("additional-task-marker");
      if (command.startsWith("/review")) {
        expect(input).toContain("Git snapshot");
        expect(input).toContain("security");
      }
      if (command.startsWith("/plan")) {
        expect(input).toContain("Only an explicit client mode change");
        expect(
          wire.updates.some(
            (u) =>
              u.sessionId === sessionId &&
              u.update.sessionUpdate === "current_mode_update" &&
              u.update.currentModeId === "plan",
          ),
        ).toBe(true);
      }
      if (command.startsWith("/goal"))
        expect(JSON.stringify(wire.updates)).toContain("no persistent goal");
      await wire.ctx.request(methods.agent.session.close, { sessionId });
    }
  } finally {
    await wire.dispose();
  }
}, 30000);
it("local commands and rejected controls start no model work, but explicit extra tasks do", async () => {
  const wire = await createWireFixture();
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const starts = () =>
      wire.getTranscript().mspRequests.filter((r: any) => r.method === "turn/start").length;
    for (const command of [
      "/goal",
      "/goal status",
      "/mcp",
      "/mcp status",
      "/goal clear",
      "/goal pause details",
      "/plan",
    ]) {
      await expect(
        wire.ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: command === "/plan" ? [text(command)] : [context, text(command)],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(starts()).toBe(0);
    }
    await wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [text("/goal status"), text("do-task-marker"), context],
    });
    expect(starts()).toBe(1);
    expect(JSON.stringify(wire.getTranscript().mspRequests)).toContain("do-task-marker");
    await wire.ctx.request(methods.agent.session.close, { sessionId });
  } finally {
    await wire.dispose();
  }
});
it("cancels goal fallback work and validates attachments before entering plan mode", async () => {
  const wire = await createWireFixture({ fakeMspMode: "block" });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    await expect(
      wire.ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [text("/plan task"), { type: "image", mimeType: "image/png", data: "invalid" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(wire.updates.some((u) => u.update.sessionUpdate === "current_mode_update")).toBe(false);
    const running = wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [context, text("/goal task-to-cancel")],
    });
    await expect
      .poll(() => JSON.stringify(wire.getTranscript().mspRequests))
      .toContain('"method":"turn/start"');
    await expect(
      wire.ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [text("/plan other task")],
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await wire.ctx.notify(methods.agent.session.cancel, { sessionId });
    expect(await running).toEqual({ stopReason: "cancelled" });
    expect(
      wire.getTranscript().mspRequests.filter((r: any) => r.method === "turn/start"),
    ).toHaveLength(1);
    await wire.ctx.request(methods.agent.session.close, { sessionId });
  } finally {
    await wire.dispose();
  }
});
