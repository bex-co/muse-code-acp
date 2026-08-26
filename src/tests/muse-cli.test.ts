import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { museCliPath } from "../muse-cli.js";

function fakeMuseDir(): { dir: string; muse: string } {
  const dir = mkdtempSync(join(tmpdir(), "muse-cli-test-"));
  const muse = join(dir, "muse");
  writeFileSync(muse, "#!/bin/sh\nexit 0\n");
  chmodSync(muse, 0o755);
  return { dir, muse };
}

describe("museCliPath", () => {
  it("prefers MUSE_CODE_EXECUTABLE over PATH", () => {
    const { dir, muse } = fakeMuseDir();
    const { dir: pathDir } = fakeMuseDir();
    const resolved = museCliPath({ MUSE_CODE_EXECUTABLE: muse, PATH: pathDir });
    expect(resolved).toBe(muse);
    expect(resolved.startsWith(dir)).toBe(true);
  });

  it("rejects a MUSE_CODE_EXECUTABLE that is not an executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-test-"));
    const notExecutable = join(dir, "muse");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    expect(() => museCliPath({ MUSE_CODE_EXECUTABLE: notExecutable, PATH: "" })).toThrow(
      /not an executable file/,
    );
  });

  it("finds muse on PATH", () => {
    const { dir, muse } = fakeMuseDir();
    const emptyDir = mkdtempSync(join(tmpdir(), "muse-cli-empty-"));
    expect(museCliPath({ PATH: `${emptyDir}:${dir}` })).toBe(muse);
  });

  it("throws an actionable error when muse is absent", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "muse-cli-empty-"));
    expect(() => museCliPath({ PATH: emptyDir })).toThrow(/MUSE_CODE_EXECUTABLE/);
  });
});
