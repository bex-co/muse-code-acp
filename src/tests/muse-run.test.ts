import { ensureExecutable } from "./helpers.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMuseCapture } from "../muse-run.js";

function scriptBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-run-test-"));
  const binary = join(dir, "muse");
  writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  ensureExecutable(binary);
  return binary;
}

const env = { PATH: process.env.PATH };

describe("runMuseCapture", () => {
  it("resolves with stdout on a zero exit", async () => {
    const binary = scriptBinary("echo out-text");
    await expect(runMuseCapture(["export"], env, binary)).resolves.toContain("out-text");
  });

  it("rejects with the command name, exit code, and stderr", async () => {
    const binary = scriptBinary("echo boom >&2\nexit 3");
    await expect(runMuseCapture(["export"], env, binary)).rejects.toThrow(
      /muse export exited 3: boom/,
    );
  });

  it("rejects when the binary cannot be spawned", async () => {
    await expect(
      runMuseCapture(["export"], env, "/nonexistent/muse-run-missing-binary"),
    ).rejects.toThrow(/ENOENT/);
  });
});
