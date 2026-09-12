import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSdkHostSupport, probeSdkHost } from "../muse-host.js";
import { convertPromptContent, formatResourceLink } from "../prompt-content.js";

describe("SDK host compatibility", () => {
  it("fails clearly when serve is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-host-"));
    const binary = join(dir, "muse");
    writeFileSync(
      binary,
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 0.2.1; exit 0; fi; exit 2\n',
    );
    chmodSync(binary, 0o755);
    const probe = probeSdkHost({ PATH: dir }, binary);
    expect(probe.serveHelpOk).toBe(false);
    expect(() => assertSdkHostSupport({ PATH: dir }, binary)).toThrow(/muse serve/);
  });
});

describe("prompt content conversion", () => {
  it("preserves ordered text and resource links, including Unicode", () => {
    const converted = convertPromptContent([
      { type: "text", text: "look" },
      {
        type: "resource_link",
        name: "日本語.md",
        uri: "file:///tmp/日本語.md",
        description: "café",
      },
    ]);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.parts).toHaveLength(2);
    expect((converted.parts[1] as { text: string }).text).toContain("URI: file:///tmp/日本語.md");
    expect((converted.parts[1] as { text: string }).text).toContain("café");
    expect(
      formatResourceLink({
        type: "resource_link",
        name: "a",
        uri: "file:///a",
      }),
    ).toBe("Resource: a\nURI: file:///a");
  });

  it("rejects empty and unsupported optional content", () => {
    expect(convertPromptContent([]).ok).toBe(false);
    expect(convertPromptContent([{ type: "audio", data: "aa", mimeType: "audio/wav" }]).ok).toBe(
      false,
    );
  });
});
