import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { compileMusePrompt } from "../prompt-files.js";

const IMAGE_DATA = Buffer.from("fake-png-bytes").toString("base64");

function imageBlock(mimeType = "image/png", data = IMAGE_DATA): ContentBlock {
  return { type: "image", mimeType, data } as ContentBlock;
}

describe("compileMusePrompt", () => {
  it("returns text directly when there are no images", () => {
    return expect(
      compileMusePrompt([{ type: "text", text: "fix the bug" }]),
    ).resolves.toMatchObject({ prompt: "fix the bug", imagePaths: [] });
  });

  it("writes each image to disk and removes the directory on cleanup", async () => {
    const compiled = await compileMusePrompt([
      { type: "text", text: "compare these" },
      imageBlock(),
      imageBlock("image/jpeg"),
    ]);
    expect(compiled.prompt).toBe("compare these");
    expect(compiled.imagePaths).toHaveLength(2);
    expect(compiled.imagePaths[0].endsWith("image-1.png")).toBe(true);
    expect(compiled.imagePaths[1].endsWith("image-2.jpg")).toBe(true);
    for (const imagePath of compiled.imagePaths) {
      expect(existsSync(imagePath)).toBe(true);
      expect((await readFile(imagePath)).toString()).toBe("fake-png-bytes");
    }
    await compiled.cleanup();
    for (const imagePath of compiled.imagePaths) {
      expect(existsSync(imagePath)).toBe(false);
    }
  });

  it("normalizes uppercase MIME types before choosing the extension", async () => {
    const compiled = await compileMusePrompt([
      { type: "text", text: "look" },
      imageBlock("IMAGE/PNG"),
    ]);
    try {
      expect(compiled.imagePaths).toHaveLength(1);
      expect(compiled.imagePaths[0].endsWith("image-1.png")).toBe(true);
    } finally {
      await compiled.cleanup();
    }
  });

  it("rejects images without accompanying text", async () => {
    await expect(compileMusePrompt([imageBlock()])).rejects.toThrow(
      /requires text or a resource link/,
    );
  });

  it("rejects unsupported content before touching the filesystem", async () => {
    // Watch a private temp directory: image tests in other files share the OS one.
    const scratch = mkdtempSync(join(tmpdir(), "prompt-files-"));
    vi.stubEnv("TMPDIR", scratch);
    try {
      expect(tmpdir()).toBe(scratch);
      await expect(
        compileMusePrompt([{ type: "bogus" } as unknown as ContentBlock]),
      ).rejects.toThrow(/unsupported prompt content/);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
