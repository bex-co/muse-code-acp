import { methods, PROTOCOL_VERSION, type ContentBlock } from "@agentclientprotocol/sdk";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { capturingLogger, connectTestClient, fakeMuseBinary, newTestSession } from "./helpers.js";

type MuseCapture = {
  argv: string[];
  directoryMode: number | null;
  images: Array<{ path: string; data: string; mode: number }>;
};

function capturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-content-capture-")), "capture.json");
}

function fakeClient(capture: string, mode = "exit0") {
  return connectTestClient({
    museBinary: fakeMuseBinary(),
    env: {
      ...process.env,
      FAKE_MUSE_ARGV_CAPTURE: capture,
      FAKE_MUSE_MODE: mode,
    },
  });
}

function readCapture(path: string): MuseCapture {
  return JSON.parse(readFileSync(path, "utf8")) as MuseCapture;
}

describe("ACP prompt content", () => {
  it("advertises image support without claiming audio or embedded resources", async () => {
    const testClient = fakeClient(capturePath());
    const ctx = await testClient.connect();

    const response = await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(response.agentCapabilities?.promptCapabilities).toEqual({ image: true });
  });

  it("renders baseline resource links in a deterministic single line", async () => {
    const capture = capturePath();
    const testClient = fakeClient(capture);
    const { ctx, sessionId } = await newTestSession(testClient);

    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "Review this input." },
        {
          type: "resource_link",
          name: 'config "prod"',
          uri: "file:///workspace/config.json",
          mimeType: "application/json",
          size: 1284,
          title: "Production config",
          description: "Current settings;\nuri=spoof",
        },
      ],
    });

    expect(readCapture(capture).argv.at(-1)).toBe(
      'Review this input.\n\nResource link: name="config \\"prod\\""; ' +
        'uri="file:///workspace/config.json"; mimeType="application/json"; size=1284; ' +
        'title="Production config"; description="Current settings;\\nuri=spoof"',
    );
  });

  it("omits absent resource-link metadata without placeholders", async () => {
    const capture = capturePath();
    const testClient = fakeClient(capture);
    const { ctx, sessionId } = await newTestSession(testClient);

    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "resource_link", name: "notes", uri: "file:///workspace/notes.txt" }],
    });

    expect(readCapture(capture).argv.at(-1)).toBe(
      'Resource link: name="notes"; uri="file:///workspace/notes.txt"',
    );
  });

  it("stages supported images privately and removes them after the turn", async () => {
    const capture = capturePath();
    const testClient = fakeClient(capture);
    const { ctx, sessionId } = await newTestSession(testClient);
    const data = Buffer.from("image bytes").toString("base64");

    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data, mimeType: "image/png" },
        { type: "image", data, mimeType: "image/jpeg" },
        { type: "image", data, mimeType: "image/gif" },
        { type: "image", data, mimeType: "image/webp" },
        { type: "text", text: "Describe the images." },
      ],
    });

    const result = readCapture(capture);
    expect(result.directoryMode).toBe(0o700);
    expect(result.images.map((image) => image.mode)).toEqual([0o600, 0o600, 0o600, 0o600]);
    expect(result.images.map((image) => image.data)).toEqual([data, data, data, data]);
    expect(result.images.map((image) => image.path.slice(image.path.lastIndexOf(".")))).toEqual([
      ".png",
      ".jpg",
      ".gif",
      ".webp",
    ]);
    expect(result.images.every((image) => !existsSync(image.path))).toBe(true);
    expect(result.argv.at(-1)).toBe("Describe the images.");
  });

  it("reserves the session while image files are being staged", async () => {
    const testClient = fakeClient(capturePath());
    const { sessionId } = await newTestSession(testClient);
    const first = testClient.agent.prompt({
      sessionId,
      prompt: [
        { type: "image", data: "YQ==", mimeType: "image/png" },
        { type: "text", text: "First prompt." },
      ],
    });

    await expect(
      testClient.agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Second prompt." }],
      }),
    ).rejects.toMatchObject({
      code: -32600,
      message: expect.stringMatching(/already has a prompt/),
    });
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("honors cancellation while image files are being staged", async () => {
    const capture = capturePath();
    const testClient = fakeClient(capture);
    const { sessionId } = await newTestSession(testClient);
    const prompt = testClient.agent.prompt({
      sessionId,
      prompt: [
        { type: "image", data: "YQ==", mimeType: "image/png" },
        { type: "text", text: "Cancel before spawn." },
      ],
    });

    await testClient.agent.cancel({ sessionId });

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(existsSync(capture)).toBe(false);
  });

  it.each([
    {
      name: "audio",
      block: { type: "audio", data: "YQ==", mimeType: "audio/wav" } satisfies ContentBlock,
      message: /unsupported ACP prompt content: audio/,
    },
    {
      name: "embedded resource",
      block: {
        type: "resource",
        resource: { uri: "file:///context.txt", text: "context" },
      } satisfies ContentBlock,
      message: /send embedded resources as resource_link blocks/,
    },
    {
      name: "unsupported image MIME",
      block: { type: "image", data: "YQ==", mimeType: "image/bmp" } satisfies ContentBlock,
      message: /supported MIME types/,
    },
    {
      name: "invalid image base64",
      block: { type: "image", data: "not base64!", mimeType: "image/png" } satisfies ContentBlock,
      message: /invalid base64 data/,
    },
  ])("rejects $name before spawning Muse", async ({ block, message }) => {
    const lines: string[] = [];
    const testClient = connectTestClient(
      { museBinary: fakeMuseBinary(), env: { ...process.env, FAKE_MUSE_MODE: "exit0" } },
      capturingLogger(lines),
    );
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Use this." }, block],
      }),
    ).rejects.toMatchObject({ code: -32602, message });
    expect(lines.some((line) => line.includes("muse-exec spawn"))).toBe(false);
  });

  it("rejects image-only prompts with the native Muse requirement", async () => {
    const testClient = fakeClient(capturePath());
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/requires text or a resource link alongside image content/),
    });
  });

  it("removes staged images when the Muse child fails", async () => {
    const capture = capturePath();
    const testClient = fakeClient(capture, "exit1");
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "image", data: "YQ==", mimeType: "image/png" },
          { type: "text", text: "Fail after staging." },
        ],
      }),
    ).rejects.toMatchObject({ code: -32603 });

    const [image] = readCapture(capture).images;
    if (!image) {
      throw new Error("fake Muse did not capture the staged image");
    }
    expect(existsSync(dirname(image.path))).toBe(false);
  });

  it("removes staged images when the Muse process cannot spawn", async () => {
    const lines: string[] = [];
    const testClient = connectTestClient(
      {
        museBinary: join(tmpdir(), "missing-muse-binary"),
        env: { ...process.env },
      },
      capturingLogger(lines),
    );
    const { ctx, sessionId } = await newTestSession(testClient);

    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "image", data: "YQ==", mimeType: "image/png" },
          { type: "text", text: "Fail before starting." },
        ],
      }),
    ).rejects.toMatchObject({ code: -32603 });

    const spawnLine = lines.find((line) => line.includes("muse-exec spawn"));
    const imagePath = spawnLine?.match(/--image (\S+)/u)?.[1];
    if (!imagePath) {
      throw new Error("spawn diagnostics did not include the staged image path");
    }
    expect(existsSync(dirname(imagePath))).toBe(false);
  });
});
