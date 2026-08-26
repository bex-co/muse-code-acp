import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableModes, MODES } from "../modes.js";
import { Logger } from "../logger.js";
import { connectTestClient, fakeMuseBinary, initialized } from "./helpers.js";

const noYolo = { env: {}, isRoot: false };
const yoloOptIn = { env: { MUSE_CODE_ACP_ALLOW_YOLO: "1" }, isRoot: false };
const root = { env: { MUSE_CODE_ACP_ALLOW_YOLO: "1" }, isRoot: true };

describe("availableModes guard", () => {
  it("hides yolo without the env opt-in", () => {
    expect(availableModes(noYolo).map((m) => m.id)).toEqual([
      "default",
      "readOnly",
      "bypassApprovals",
    ]);
  });

  it("offers yolo with the opt-in", () => {
    expect(availableModes(yoloOptIn).map((m) => m.id)).toContain("yolo");
  });

  it("refuses all dangerous modes as root, opt-in or not", () => {
    expect(availableModes(root).map((m) => m.id)).toEqual(["default", "readOnly"]);
  });

  it("documents next-prompt latency and report-only default in descriptions", () => {
    for (const mode of Object.values(MODES)) {
      expect(mode.description).toMatch(/Applies from the next prompt/);
    }
    expect(MODES.default.description).toMatch(/reported, not asked/);
  });
});

describe("session/set_mode", () => {
  function capturingLogger(lines: string[]): Logger {
    return { log: (...args) => lines.push(args.join(" ")), error: () => {} };
  }

  async function newSession(testClient: ReturnType<typeof connectTestClient>) {
    const ctx = await initialized(testClient);
    const cwd = mkdtempSync(join(tmpdir(), "muse-modes-test-"));
    const { sessionId, modes } = await ctx.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    return { ctx, sessionId, modes };
  }

  it("advertises modes on session/new with default current", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const { modes } = await newSession(testClient);

    expect(modes?.currentModeId).toBe("default");
    expect(modes?.availableModes.map((m) => m.id)).toContain("bypassApprovals");
    expect(modes?.availableModes.map((m) => m.id)).not.toContain("yolo");
  });

  it("applies the mode's flags to the next spawn", async () => {
    const lines: string[] = [];
    const testClient = connectTestClient(
      { museBinary: fakeMuseBinary(), env: { ...process.env, FAKE_MUSE_MODE: "exit1" } },
      capturingLogger(lines),
    );
    const { ctx, sessionId } = await newSession(testClient);

    await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "bypassApprovals" });
    await ctx
      .request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "x" }],
      })
      .catch(() => {});

    const spawnLine = lines.find((l) => l.includes("muse-exec spawn:"));
    expect(spawnLine).toMatch(/--disable-approval/);
  });

  it("default mode spawns without safety flags", async () => {
    const lines: string[] = [];
    const testClient = connectTestClient(
      { museBinary: fakeMuseBinary(), env: { ...process.env, FAKE_MUSE_MODE: "exit1" } },
      capturingLogger(lines),
    );
    const { ctx, sessionId } = await newSession(testClient);

    await ctx
      .request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "x" }],
      })
      .catch(() => {});

    const spawnLine = lines.find((l) => l.includes("muse-exec spawn:"));
    expect(spawnLine).not.toMatch(/--disable-approval|--yolo|--disable-write/);
  });

  it("rejects unknown or unavailable modes", async () => {
    const testClient = connectTestClient({ museBinary: fakeMuseBinary() });
    const { ctx, sessionId } = await newSession(testClient);

    await expect(
      ctx.request(methods.agent.session.setMode, { sessionId, modeId: "yolo" }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      ctx.request(methods.agent.session.setMode, { sessionId, modeId: "no-such-mode" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
