#!/usr/bin/env node
// Install or remove the "Muse Code (QA)" agent server in Bex's user settings.
//
//   bex-agent.mjs install <run.sh> <logDir> [museExecutable]
//   bex-agent.mjs remove
//   bex-agent.mjs status
//
// settings.json is JSONC (comments, trailing commas), so the entry is inserted
// as text right after `"agent_servers": {` between two marker comments, and
// removal deletes exactly that span. A timestamped backup is written before
// any change; removal refuses when the markers are missing or malformed.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS = process.env.BEX_SETTINGS ?? join(homedir(), ".config", "bex", "settings.json");
const BEGIN = "// qa-find-bugs:begin (temporary; removed by bex-agent.mjs remove)";
const END = "// qa-find-bugs:end";
export const AGENT_NAME = "Muse Code (QA)";

function read() {
  if (!existsSync(SETTINGS)) throw new Error(`Bex settings not found: ${SETTINGS}`);
  return readFileSync(SETTINGS, "utf8");
}

function span(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 && end === -1) return undefined;
  if (begin === -1 || end === -1 || end < begin || text.indexOf(BEGIN, begin + 1) !== -1)
    throw new Error("qa-find-bugs markers are malformed; fix settings.json by hand");
  const lineStart = text.lastIndexOf("\n", begin) + 1;
  const lineEnd = text.indexOf("\n", end);
  return [lineStart, lineEnd === -1 ? text.length : lineEnd + 1];
}

function install(runSh, logDir, muse) {
  if (!runSh || !logDir) throw new Error("usage: install <run.sh> <logDir> [museExecutable]");
  const text = read();
  if (span(text)) throw new Error("a QA agent entry is already installed; run `remove` first");
  const anchor = '"agent_servers": {';
  const at = text.indexOf(anchor);
  if (at === -1 || text.indexOf(anchor, at + 1) !== -1)
    throw new Error('expected exactly one `"agent_servers": {` in Bex settings');
  const backup = SETTINGS.replace(/\.json$/, `.before-qa-${Date.now()}.json`);
  copyFileSync(SETTINGS, backup);
  const entry = {
    type: "custom",
    command: runSh,
    args: [logDir],
    env: muse ? { MUSE_CODE_EXECUTABLE: muse } : {},
  };
  const block = `\n    ${BEGIN}\n    ${JSON.stringify(AGENT_NAME)}: ${JSON.stringify(entry)},\n    ${END}`;
  const insertAt = at + anchor.length;
  writeFileSync(SETTINGS, text.slice(0, insertAt) + block + text.slice(insertAt));
  console.log(JSON.stringify({ installed: AGENT_NAME, backup, settings: SETTINGS }));
}

function remove() {
  const text = read();
  const found = span(text);
  if (!found) return console.log(JSON.stringify({ removed: false, reason: "not installed" }));
  // The insertion added a newline before the block; take it back too.
  const [start, end] = found;
  const before = text.slice(0, start).replace(/\n$/, "");
  writeFileSync(SETTINGS, before + "\n" + text.slice(end).replace(/^\n/, ""));
  console.log(JSON.stringify({ removed: true, settings: SETTINGS }));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "install") install(...args);
  else if (command === "remove") remove();
  else if (command === "status") console.log(JSON.stringify({ installed: !!span(read()) }));
  else throw new Error("usage: bex-agent.mjs install <run.sh> <logDir> [muse] | remove | status");
} catch (error) {
  console.error(`bex-agent: ${error.message}`);
  process.exit(1);
}
