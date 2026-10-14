#!/usr/bin/env node
/**
 * Print one version's CHANGELOG section, the body of its GitHub Release.
 * Usage: node scripts/release-notes.mjs 0.10.0 [CHANGELOG.md]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The section under `## [version](…)`, without its heading; throws when missing or empty. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG has no section for ${version}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  if (!body) throw new Error(`CHANGELOG section for ${version} is empty`);
  return `${body}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, path = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: release-notes.mjs <version> [CHANGELOG.md]");
    process.exit(2);
  }
  process.stdout.write(releaseNotes(readFileSync(path, "utf8"), version));
}
