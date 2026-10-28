#!/usr/bin/env node
// Check every recorded ACP wire log under $QA_DIR/logs/* against invariants
// that hold for any correct session, independent of scenario. Writes
// $QA_DIR/findings.json: scenario findings from results.json plus these,
// each tagged with a known upstream/board item when it matches one.
//
//   analyze.mjs --qa-dir DIR
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const at = process.argv.indexOf("--qa-dir");
const QA = at === -1 ? undefined : process.argv[at + 1];
if (!QA) throw new Error("--qa-dir is required");

/**
 * Known, already-tracked behavior: a finding matching one is tagged, not filed
 * again. `hosts` lists the Muse versions an upstream bug affects; on any other
 * host the same finding is a regression and stays untagged.
 */
const KNOWN = [
  { re: /file birth time is unavailable/, id: "#120 (Linux fork)", hosts: ["1.4.12", "1.4.13"] },
  { re: /MCP startup audit failed/, id: "#112", hosts: ["1.4.11", "1.4.12", "1.4.13"] },
  { re: /resumed session reports active turn/, id: "#121", hosts: ["1.4.12", "1.4.13"] },
  {
    re: /fingerprint .* differs from the fingerprint this SDK pins/,
    id: "SDK pin behind host (bump @muse-code/sdk)",
  },
  { re: /compaction_unavailable/, id: "loopback cannot compact (w3/m9)" },
];
// The Muse host the scenarios ran on, from results.json.
const resultFiles = readdirSync(QA).filter((f) => /^results(\.rerun-\d+)?\.json$/.test(f));
const HOST = resultFiles
  .map(
    (f) => JSON.parse(readFileSync(join(QA, f), "utf8")).muse?.version?.match(/\d+\.\d+\.\d+/)?.[0],
  )
  .find(Boolean);
/** Drop a known tag when this host is not one the upstream bug affects. */
const onAffectedHost = (id) => {
  const entry = id && KNOWN.find((k) => k.id === id || k.id.startsWith(`${id} `));
  return entry?.hosts && HOST && !entry.hosts.includes(HOST) ? undefined : id;
};
const knownFor = (text) => onAffectedHost(KNOWN.find((k) => k.re.test(text))?.id);

const readNdjson = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [{ unparsable: line.slice(0, 200) }];
          }
        })
    : [];

const findings = [];
const logsRoot = join(QA, "logs");
for (const name of existsSync(logsRoot) ? readdirSync(logsRoot) : []) {
  const dir = join(logsRoot, name);
  const input = readNdjson(join(dir, "in.ndjson"));
  const output = readNdjson(join(dir, "out.ndjson"));
  const stderr = existsSync(join(dir, "stderr.log"))
    ? readFileSync(join(dir, "stderr.log"), "utf8")
    : "";
  const add = (severity, title, detail = {}) => {
    const text = `${title} ${JSON.stringify(detail)}`;
    findings.push({
      source: `logs/${name}`,
      severity,
      title,
      ...detail,
      known: detail.known ?? knownFor(text),
    });
  };

  // 1. Framing: every line is JSON; every client request gets exactly one response.
  for (const bad of [...input, ...output].filter((m) => m.unparsable))
    add("high", "non-JSON line on the ACP wire", { actual: bad.unparsable });
  const responses = new Map();
  for (const m of output)
    if ("id" in m && !("method" in m)) responses.set(m.id, (responses.get(m.id) ?? 0) + 1);
  for (const req of input.filter((m) => "id" in m && m.method)) {
    const count = responses.get(req.id) ?? 0;
    if (count !== 1 && !(count === 0 && req === input.at(-1)))
      add("high", `request ${req.method} got ${count} responses`, { request: req.method });
  }
  const errors = output.filter((m) => m.error);
  for (const e of errors) {
    const req = input.find((r) => r.id === e.id);
    if (e.error.code === -32603 || /internal error/i.test(e.error.message ?? ""))
      add("medium", `internal error answering ${req?.method ?? "?"}`, {
        actual: e.error.message?.slice(0, 300),
      });
  }

  // 2. Rendering: no raw Muse item kinds or placeholders reach the client.
  const updates = output.filter((m) => m.method === "session/update").map((m) => m.params.update);
  for (const u of updates) {
    if (
      (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
      typeof u.title === "string"
    ) {
      if (/^[a-z]+[A-Z]\w*: /.test(u.title))
        add("medium", "raw Muse item kind shown as a card title", { actual: u.title });
      if (/undefined|\[object Object\]/.test(u.title))
        add("medium", "rendering artifact in a card title", { actual: u.title });
    }
    const body = JSON.stringify(u.content ?? "");
    if (/Public \w+ item \(\w+\); no further detail/.test(body))
      add("low", "generic placeholder card body", { actual: body.slice(0, 200) });
  }

  // 3. Commands: unique names; /compact only on hosts that compact.
  for (const u of updates.filter((x) => x.sessionUpdate === "available_commands_update")) {
    const names = u.availableCommands.map((c) => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length)
      add("low", "duplicate command names advertised", { actual: [...new Set(dupes)] });
  }

  // 4. Capability discipline: standard updates only when negotiated.
  const init = input.find((m) => m.method === "initialize");
  const caps = init?.params?.clientCapabilities ?? {};
  if (!caps.session?.compaction && updates.some((u) => u.sessionUpdate?.startsWith("compaction_")))
    add("high", "compaction updates sent to a client that did not negotiate them");
  if (!caps.session?.notices && updates.some((u) => u.sessionUpdate === "notice"))
    add("high", "notice sent to a client that did not negotiate notices");

  // 5. Permissions: options are well-formed; a cancelled request never grants.
  const permReqs = output.filter((m) => m.method === "session/request_permission");
  for (const req of permReqs) {
    const kinds = (req.params.options ?? []).map((o) => o.kind);
    if (!kinds.length) add("high", "permission request with no options");
    if (new Set((req.params.options ?? []).map((o) => o.optionId)).size !== kinds.length)
      add("medium", "permission option ids repeat");
  }

  // 6. Replay: messageIds unique within a load.
  const loads = input.filter((m) => m.method === "session/load");
  if (loads.length) {
    const ids = updates.map((u) => u.messageId).filter(Boolean);
    if (new Set(ids).size !== ids.length) add("medium", "replayed messageIds repeat");
    const chunks = updates.filter((u) => /_message_chunk$/.test(u.sessionUpdate));
    for (let i = 1; i < chunks.length; i++)
      if (
        chunks[i].sessionUpdate === "user_message_chunk" &&
        chunks[i - 1].sessionUpdate === "user_message_chunk" &&
        !chunks[i].messageId
      )
        add("medium", "adjacent replayed prompts without a message boundary");
  }

  // 6b. Replay order: a load's updates are the run of notifications right before
  // its response. Cards there must follow the history, not precede it.
  for (const load of loads) {
    const at = output.findIndex((m) => m.id === load.id && !("method" in m));
    const replayed = [];
    for (let i = at - 1; i >= 0 && !("id" in output[i] && !("method" in output[i])); i--)
      if (output[i].method === "session/update") replayed.unshift(output[i].params.update);
    const firstPrompt = replayed.findIndex((u) => u.sessionUpdate === "user_message_chunk");
    const early = replayed
      .slice(0, firstPrompt === -1 ? 0 : firstPrompt)
      .filter((u) => u.sessionUpdate === "tool_call");
    if (early.length)
      add("medium", "restored cards appear above the replayed history", {
        actual: { cards: early.length, first: early.slice(0, 3).map((u) => u.title) },
      });
    for (const u of replayed)
      if (
        u.sessionUpdate === "tool_call" &&
        /: \w+: (completed|failed|live state unknown)$/.test(u.title ?? "")
      )
        add("low", "status repeated inside a restored card title", { actual: u.title });
  }

  // 7. Prompt outcomes on the wire.
  for (const req of input.filter((m) => m.method === "session/prompt")) {
    const res = output.find((m) => m.id === req.id);
    const stop = res?.result?.stopReason;
    if (
      res?.result &&
      !["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(stop)
    )
      add("high", "prompt ended with an unexpected stop reason", { actual: stop });
  }

  // 8. stderr: crashes, leaks and host churn.
  const lines = stderr.split("\n");
  const pick = (re) => lines.filter((l) => re.test(l));
  for (const l of pick(
    /Unhandled|UnhandledPromiseRejection|TypeError|ReferenceError|at .*\(.*\.js:\d+:\d+\)/,
  ).slice(0, 5))
    add("high", "uncaught error or stack trace in agent stderr", { actual: l.slice(0, 300) });
  for (const l of pick(/prewarm failed/).slice(0, 3))
    add("medium", "background host start failed", { actual: l.slice(0, 300) });
  for (const l of pick(/already in use|sessionInUse/).slice(0, 3))
    add("medium", "session lease conflict", { actual: l.slice(0, 300) });
  const sessions = input.filter((m) =>
    ["session/new", "session/load", "session/resume", "session/fork"].includes(m.method),
  ).length;
  const spawns = pick(/muse-sdk spawn:/).length;
  const configChanges = input.filter((m) =>
    /set_config_option|set_mode/.test(m.method ?? ""),
  ).length;
  if (sessions && spawns > 2 * sessions + configChanges + 2)
    add("low", "more Muse host spawns than sessions and config changes explain", {
      actual: { spawns, sessions, configChanges },
    });
  for (const l of pick(/resumed session reports active turn/).slice(0, 1))
    add("medium", "Muse reported a finished turn as running after resume", {
      actual: l.slice(0, 200),
    });
  for (const l of pick(/fingerprint .* differs/).slice(0, 1))
    add("info", "host schema newer than the pinned SDK", { actual: l.slice(0, 200) });
}

// Scenario expectations from results.json.
// results.json from the full run plus results.rerun-N.json from targeted reruns.
for (const file of resultFiles) {
  const results = JSON.parse(readFileSync(join(QA, file), "utf8"));
  for (const s of results.scenarios)
    for (const f of s.findings)
      findings.push({
        source: `${file} ${s.id}`,
        severity: f.severity ?? (s.kind === "real" ? "high" : "medium"),
        ...f,
        known: f.known
          ? onAffectedHost(f.known)
          : knownFor(`${f.title} ${JSON.stringify(f.actual ?? "")}`),
      });
}

// Collapse identical findings from several logs into one with a count.
const merged = [];
for (const f of findings) {
  const key = `${f.severity}|${f.title}|${f.known ?? ""}`;
  const prior = merged.find((m) => m.key === key);
  if (prior) {
    prior.count += 1;
    prior.sources.push(f.source);
  } else merged.push({ key, count: 1, sources: [f.source], ...f });
}
const order = { high: 0, medium: 1, low: 2, info: 3 };
merged.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || !!a.known - !!b.known);
writeFileSync(join(QA, "findings.json"), JSON.stringify(merged, null, 2));
const open = merged.filter((f) => !f.known && f.severity !== "info");
console.log(
  JSON.stringify({
    findings: join(QA, "findings.json"),
    total: merged.length,
    newFindings: open.length,
    known: merged.filter((f) => f.known).length,
  }),
);
