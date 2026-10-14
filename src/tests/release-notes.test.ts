import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error -- plain ESM release script without type declarations
import { releaseNotes } from "../../scripts/release-notes.mjs";

const changelog = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "## [2.0.0](https://example/compare) (2026-10-14)",
  "",
  "### Features",
  "",
  "- New thing.",
  "",
  "## [1.0.0](https://example/compare) (2026-10-01)",
  "",
  "### Fixes",
  "",
  "- Old thing.",
  "",
].join("\n");

it("extracts exactly one version's section without its heading", () => {
  expect(releaseNotes(changelog, "2.0.0")).toBe("### Features\n\n- New thing.\n");
  expect(releaseNotes(changelog, "1.0.0")).toBe("### Fixes\n\n- Old thing.\n");
  expect(() => releaseNotes(changelog, "3.0.0")).toThrow("no section for 3.0.0");
  expect(() => releaseNotes("## [1.1.0](x)\n\n## [1.0.0](y)\n- a\n", "1.1.0")).toThrow("empty");
});

it("finds the current package version in the real CHANGELOG", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  expect(releaseNotes(readFileSync("CHANGELOG.md", "utf8"), version)).toMatch(/^### /);
});
