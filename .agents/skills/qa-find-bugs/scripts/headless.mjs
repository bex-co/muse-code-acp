#!/usr/bin/env node
// Headless QA pass: drive the packed release candidate over real ACP exactly as
// Bex does (its initialize params, its option restore right after session/new)
// and run the scenario catalogue (scenarios.md). Each agent process writes its
// own wire log under $QA_DIR/logs/<scenario>/ through rc/run.sh; analyze.mjs
// checks those logs afterwards. Scenario expectations that fail here become
// findings in results.json.
//
//   headless.mjs --qa-dir DIR [--loopback-only | --real-only] [--only L1,R3]
//                [--budget 80] [--muse /path/to/muse] [--caps bex|negotiated]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith("--"))
      acc.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const QA = args["qa-dir"];
if (!QA) throw new Error("--qa-dir is required (run pack-rc.sh first)");
const REPO = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const RC = JSON.parse(readFileSync(join(QA, "rc", "rc.json"), "utf8"));
const BUDGET = Number(args.budget ?? process.env.QA_TURN_BUDGET ?? 80);
const ONLY = typeof args.only === "string" ? new Set(args.only.split(",")) : undefined;
const MUSE =
  typeof args.muse === "string"
    ? args.muse
    : (process.env.MUSE_CODE_EXECUTABLE ?? join(homedir(), ".local", "bin", "muse"));
const NEGOTIATED = args.caps === "negotiated";
const REAL_MODEL = process.env.QA_REAL_MODEL ?? "muse-spark-1.3";

const acp = await import(
  pathToFileURL(join(REPO, "node_modules/@agentclientprotocol/sdk/dist/acp.js")).href
);
const loopback = await import(pathToFileURL(join(REPO, "dist/tests/loopback-provider.js")).href);

/** Bex 1.20's initialize, captured from its wire log (2026-10-25). */
const BEX_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  session: {
    configOptions: { boolean: {} },
    ...(NEGOTIATED ? { compaction: {}, notices: {} } : {}),
  },
  auth: { terminal: true },
  elicitation: { form: {}, url: {} },
  _meta: {
    terminal_output: true,
    "terminal-auth": true,
    ...(NEGOTIATED
      ? Object.fromEntries(
          [
            "muse/approval",
            "muse/asyncTasks",
            "muse/authStatus",
            "muse/configRecommendations",
            "muse/fork",
            "muse/goal",
            "muse/output",
            "muse/review",
            "muse/sessionState",
            "muse/steering",
            "muse/usage",
          ].map((k) => [k, 1]),
        )
      : {}),
  },
};
const BEX_CLIENT_INFO = { name: "zed", title: "Bex", version: "qa-find-bugs" };

const museVersion = spawnSync(MUSE, ["--version"], { encoding: "utf8" }).stdout.trim();
const results = {
  rc: RC,
  muse: { path: MUSE, version: museVersion },
  caps: NEGOTIATED ? "negotiated" : "bex",
  budget: BUDGET,
  turnsUsed: 0,
  startedAt: new Date().toISOString(),
  scenarios: [],
};
// The first run writes results.json; any later run in the same QA_DIR (a
// targeted --only rerun or a second --caps pass) gets its own file so the
// evidence of earlier runs survives.
let RESULTS_FILE = join(QA, "results.json");
for (let n = 1; existsSync(RESULTS_FILE); n++) RESULTS_FILE = join(QA, `results.rerun-${n}.json`);
const save = () => writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    sleep(ms).then(() => Promise.reject(new Error(`timeout after ${ms} ms: ${what}`))),
  ]);

async function spawnAgent(name, env) {
  // A rerun (e.g. to confirm a finding) keeps its own evidence: L2, L2.2, …
  let logDir = join(QA, "logs", name);
  for (let n = 2; existsSync(logDir); n++) logDir = join(QA, "logs", `${name}.${n}`);
  mkdirSync(logDir, { recursive: true });
  const child = spawn(RC.run, [logDir], {
    env: { ...env, MUSE_CODE_ACP_BACKEND: "sdk" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const updates = [];
  const permissions = [];
  let responder = () => ({ outcome: { outcome: "cancelled" } });
  let resolveCtx;
  const ready = new Promise((r) => (resolveCtx = r));
  acp
    .client({ name: "qa-bex-mimic" })
    .onNotification(acp.methods.client.session.update, (c) =>
      updates.push({ at: Date.now(), ...c.params }),
    )
    .onRequest(acp.methods.client.session.requestPermission, async (c) => {
      permissions.push({ at: Date.now(), ...c.params });
      return responder(c.params);
    })
    .onRequest(acp.methods.client.elicitation.create, async () => ({ action: "cancel" }))
    .onConnect((conn) => resolveCtx(conn.agent))
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const ctx = await withTimeout(ready, 20_000, `${name} connect`);
  const exited = new Promise((r) => child.once("exit", r));
  const agent = {
    ctx,
    updates,
    permissions,
    logDir,
    respond(fn) {
      responder = fn;
    },
    async initialize() {
      return ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: BEX_CAPABILITIES,
        clientInfo: BEX_CLIENT_INFO,
      });
    },
    async close() {
      // Like quitting Bex: close stdin, let the agent dispose, then reap the group.
      child.stdin.end();
      await Promise.race([exited, sleep(10_000)]);
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    },
  };
  await agent.initialize();
  return agent;
}

/** Bex's session/new: create, then immediately restore the last-used option. */
async function bexNewSession(agent, cwd, extra = {}) {
  const t0 = Date.now();
  const created = await agent.ctx.request(acp.methods.agent.session.new, {
    cwd,
    mcpServers: extra.mcpServers ?? [],
  });
  const newSessionMs = Date.now() - t0;
  await agent.ctx
    .request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: "nativeApprovalPolicy",
      value: extra.approvalPolicy ?? "promptUnmatched",
    })
    .catch(() => {});
  return { ...created, newSessionMs };
}

const agentText = (agent, sessionId, since = 0) =>
  agent.updates
    .filter(
      (u) =>
        u.sessionId === sessionId &&
        u.at >= since &&
        u.update.sessionUpdate === "agent_message_chunk",
    )
    .map((u) => u.update.content?.text ?? "")
    .join("");

async function prompt(agent, sessionId, text, { real = false, timeoutMs, cancelAfterMs } = {}) {
  if (real) {
    if (results.turnsUsed >= BUDGET) throw new BudgetExhausted();
    results.turnsUsed += 1;
  }
  const t0 = Date.now();
  const request = agent.ctx.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  if (cancelAfterMs)
    sleep(cancelAfterMs).then(() =>
      agent.ctx.notify(acp.methods.agent.session.cancel, { sessionId }),
    );
  let response;
  let error;
  try {
    response = await withTimeout(
      request,
      timeoutMs ?? (real ? 240_000 : 60_000),
      `prompt "${text}"`,
    );
  } catch (e) {
    error = e?.message ?? String(e);
  }
  const first = agent.updates.find(
    (u) =>
      u.sessionId === sessionId &&
      u.at >= t0 &&
      ["agent_message_chunk", "tool_call", "agent_thought_chunk"].includes(u.update.sessionUpdate),
  );
  return {
    stopReason: response?.stopReason,
    error,
    ms: Date.now() - t0,
    firstOutputMs: first ? first.at - t0 : undefined,
    text: agentText(agent, sessionId, t0),
  };
}

class BudgetExhausted extends Error {}

function scenario(id, title, kind, run) {
  return { id, title, kind, run };
}

/** Collects expectation failures as findings instead of throwing. */
function checker(record) {
  return (ok, title, detail = {}) => {
    if (!ok) record.findings.push({ title, ...detail });
    return ok;
  };
}

function workspace(name) {
  const dir = join(QA, "work", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function withLoopback(options, fn) {
  const p = await loopback.startLoopbackProvider({
    scriptedToolCallWhen: [],
    scriptedToolCallCommand: "",
    holdMs: 20,
    ...options,
  });
  const env = {
    PATH: process.env.PATH,
    MUSE_CODE_EXECUTABLE: MUSE,
    HOME: p.home,
    XDG_CONFIG_HOME: join(p.root, "config"),
    XDG_DATA_HOME: join(p.root, "data"),
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
  };
  try {
    return await fn(p, env);
  } finally {
    await p.close();
    rmSync(p.root, { recursive: true, force: true });
  }
}

const realEnv = () => ({ ...process.env, MUSE_CODE_EXECUTABLE: MUSE });

async function realSession(agent, cwd, extra) {
  const s = await bexNewSession(agent, cwd, extra);
  // Never spend the budget on the user's default model: wait for the catalog
  // (published by the prewarmed host) so the cheap model can be selected.
  for (let i = 0; i < 60; i++) {
    const offered = [s, ...agent.updates.map((u) => u.update)]
      .flatMap((x) => x.configOptions ?? [])
      .filter((o) => o.id === "model")
      .flatMap((o) => o.options ?? []);
    if (offered.some((o) => o.name === REAL_MODEL || String(o.value).includes(REAL_MODEL))) {
      s.configOptions = [{ id: "model", options: offered }];
      break;
    }
    await sleep(500);
  }
  for (const [configId, value] of [
    ["model", REAL_MODEL],
    ["reasoningEffort", "low"],
  ]) {
    const option = (s.configOptions ?? []).find((o) => o.id === configId);
    const match = option?.options?.find?.((o) => o.value === value || o.name === value);
    const applied = await agent.ctx
      .request(acp.methods.agent.session.setConfigOption, {
        sessionId: s.sessionId,
        configId,
        value: match?.value ?? value,
      })
      .catch((e) => ({ error: e.message }));
    const current = applied.configOptions?.find((o) => o.id === configId)?.currentValue;
    if (configId === "model" && !String(current ?? "").includes(REAL_MODEL))
      throw new Error(
        `could not select ${REAL_MODEL} (got ${current ?? applied.error}); refusing to spend real turns on another model`,
      );
  }
  return s;
}

// ---------------------------------------------------------------- scenarios
const scenarios = [
  scenario(
    "L1",
    "Handshake, commands and model catalog before the first prompt",
    "loopback",
    async (r) => {
      const check = checker(r);
      await withLoopback({ replyText: "qa-l1-reply" }, async (p, env) => {
        const a = await spawnAgent("L1", env);
        try {
          const s = await bexNewSession(a, workspace("L1"));
          r.metrics.newSessionMs = s.newSessionMs;
          check(s.newSessionMs < 5000, "session/new is slow", { actual: `${s.newSessionMs} ms` });
          // Wait for the prewarmed host rather than a fixed delay: the first
          // launch of a freshly updated Muse binary can take ~7 s to initialize.
          const catalogPublished = () =>
            a.updates.some((u) =>
              (u.update.configOptions ?? []).some(
                (o) => o.id === "model" && /Muse model catalog/.test(o.description ?? ""),
              ),
            );
          const commandsPublished = () =>
            a.updates.some((u) => u.update.sessionUpdate === "available_commands_update");
          const readyStart = Date.now();
          while (!(catalogPublished() && commandsPublished()) && Date.now() - readyStart < 15_000) {
            await sleep(250);
          }
          r.metrics.hostReadyMs = s.newSessionMs + (Date.now() - readyStart);
          const commands =
            a.updates.filter((u) => u.update.sessionUpdate === "available_commands_update").at(-1)
              ?.update.availableCommands ?? [];
          const names = commands.map((c) => c.name);
          check(names.length > 0, "no available_commands_update after session/new");
          check(new Set(names).size === names.length, "duplicate command names", {
            actual: names.filter((n, i) => names.indexOf(n) !== i),
          });
          // The loopback's bundled catalog has a single model, so check that the
          // prewarmed host published the catalog, not how many rows it has.
          check(catalogPublished(), "model catalog not published before the first prompt", {
            expected: "config_option_update from the prewarmed host's model/list",
          });
          const res = await prompt(a, s.sessionId, "hello qa");
          check(res.stopReason === "end_turn", "plain prompt did not end_turn", { actual: res });
          check(res.text.includes("qa-l1-reply"), "reply text missing", { actual: res.text });
        } finally {
          await a.close();
        }
      });
    },
  ),

  scenario(
    "L2",
    "Tool turn with a real approval: reject, then allow once",
    "loopback",
    async (r) => {
      const check = checker(r);
      const ws = workspace("L2");
      await withLoopback(
        {
          reviewerOutcome: "escalate",
          // Script the tool only for the user's new message, never after a tool
          // result; otherwise the fake model calls the tool again forever.
          scriptedToolCallForRequest: (req) => {
            const last = (req.input ?? []).at(-1);
            if (!last || last.role !== "user") return undefined;
            const text = JSON.stringify(last.content ?? last);
            for (const tag of ["qa-reject", "qa-allow"])
              if (text.includes(`run ${tag}`))
                return {
                  name: "bash",
                  arguments: { command: `printf qa > ${join(ws, tag)}.txt`, description: tag },
                };
            return undefined;
          },
        },
        async (p, env) => {
          const a = await spawnAgent("L2", env);
          try {
            const s = await bexNewSession(a, ws);
            for (const [tag, kind] of [
              ["qa-reject", "reject_once"],
              ["qa-allow", "allow_once"],
            ]) {
              const before = a.permissions.length;
              a.respond((req) => {
                const option = req.options.find((o) => o.kind === kind);
                return option
                  ? { outcome: { outcome: "selected", optionId: option.optionId } }
                  : { outcome: { outcome: "cancelled" } };
              });
              const res = await prompt(a, s.sessionId, `run ${tag}`);
              check(res.stopReason === "end_turn", `${tag}: prompt did not end_turn`, {
                actual: res,
              });
              const asked = a.permissions.slice(before);
              check(
                asked.length > 0,
                `${tag}: no ACP permission request for an escalated approval`,
              );
              for (const req of asked)
                check(
                  req.options.every((o) =>
                    ["allow_once", "allow_always", "reject_once", "reject_always"].includes(o.kind),
                  ),
                  `${tag}: unexpected permission option kind`,
                  { actual: req.options },
                );
              const wrote = existsSync(join(ws, `${tag}.txt`));
              check(
                wrote === (kind === "allow_once"),
                `${tag}: file ${wrote ? "written" : "missing"} after ${kind}`,
              );
            }
          } finally {
            await a.close();
          }
        },
      );
    },
  ),

  scenario("L3", "Cancel a running turn", "loopback", async (r) => {
    const check = checker(r);
    // Hold only the turn being cancelled, and script no tool call: on a cold host
    // the cancel can land before "long qa turn" reaches the model, and the
    // follow-up prompt must not inherit its 30 s hold or the one-shot bash call.
    await withLoopback(
      {
        scriptedToolCallWhen: ["\u0000never"],
        holdMsForRequest: (req) => (JSON.stringify(req).includes("after cancel") ? 20 : 30_000),
      },
      async (p, env) => {
        const a = await spawnAgent("L3", env);
        try {
          const s = await bexNewSession(a, workspace("L3"));
          const res = await prompt(a, s.sessionId, "long qa turn", {
            cancelAfterMs: 2000,
            timeoutMs: 20_000,
          });
          check(res.stopReason === "cancelled", "cancel did not settle as cancelled", {
            actual: res,
          });
          r.metrics.cancelSettleMs = res.ms - 2000;
          check(res.ms - 2000 < 5000, "cancel took more than 5 s to settle", {
            actual: `${res.ms - 2000} ms`,
          });
          const after = await prompt(a, s.sessionId, "after cancel");
          check(after.stopReason === "end_turn", "session unusable after cancel", {
            actual: after,
          });
        } finally {
          await a.close();
        }
      },
    );
  }),

  scenario("L4", "Mode and model changes while idle and during a turn", "loopback", async (r) => {
    const check = checker(r);
    await withLoopback(
      { holdMsForRequest: (req) => (JSON.stringify(req).includes("qa-hold") ? 4000 : 20) },
      async (p, env) => {
        const a = await spawnAgent("L4", env);
        try {
          const s = await bexNewSession(a, workspace("L4"));
          await a.ctx.request(acp.methods.agent.session.setMode, {
            sessionId: s.sessionId,
            modeId: "readOnly",
          });
          await a.ctx
            .request(acp.methods.agent.session.setConfigOption, {
              sessionId: s.sessionId,
              configId: "model",
              value:
                (
                  s.configOptions
                    .find((o) => o.id === "model")
                    .options.find((o) => String(o.value).includes(loopback.ALTERNATE_MODEL_ID)) ??
                  {}
                ).value ?? loopback.ALTERNATE_MODEL_ID,
            })
            .catch((e) => r.notes.push(`model select: ${e.message}`));
          const res = await prompt(a, s.sessionId, "after idle changes");
          check(res.stopReason === "end_turn", "prompt after idle mode/model change failed", {
            actual: res,
          });
          const held = prompt(a, s.sessionId, "qa-hold turn");
          await sleep(1000);
          const mid = await a.ctx
            .request(acp.methods.agent.session.setMode, {
              sessionId: s.sessionId,
              modeId: "default",
            })
            .then(
              () => "accepted",
              (e) => `rejected: ${e.message}`,
            );
          r.notes.push(`setMode during a turn: ${mid}`);
          const heldRes = await held;
          check(heldRes.stopReason === "end_turn", "turn broke after a mid-turn mode change", {
            actual: heldRes,
          });
          const next = await prompt(a, s.sessionId, "after mid-turn change");
          check(next.stopReason === "end_turn", "prompt after a mid-turn change failed", {
            actual: next,
          });
        } finally {
          await a.close();
        }
      },
    );
  }),

  scenario("L5", "Restart, load with replay, then prompt", "loopback", async (r) => {
    const check = checker(r);
    await withLoopback({ replyText: "qa-l5" }, async (p, env) => {
      const ws = workspace("L5");
      const a = await spawnAgent("L5-before", env);
      let sessionId;
      try {
        ({ sessionId } = await bexNewSession(a, ws));
        for (const t of ["first qa prompt", "second qa prompt"]) await prompt(a, sessionId, t);
      } finally {
        await a.close();
      }
      const b = await spawnAgent("L5-after", env);
      try {
        await b.ctx.request(acp.methods.agent.session.load, { sessionId, cwd: ws, mcpServers: [] });
        const replay = b.updates.filter((u) => u.sessionId === sessionId);
        const users = replay.filter((u) => u.update.sessionUpdate === "user_message_chunk");
        check(users.length >= 2, "load replayed fewer than the 2 prompts", {
          actual: users.length,
        });
        const ids = replay.map((u) => u.update.messageId).filter(Boolean);
        check(new Set(ids).size === ids.length, "replay messageIds repeat");
        const res = await prompt(b, sessionId, "after restart");
        check(res.stopReason === "end_turn", "prompt after restart failed", { actual: res });
      } finally {
        await b.close();
      }
    });
  }),

  scenario("L6", "Fork and continue both branches", "loopback", async (r) => {
    const check = checker(r);
    await withLoopback({}, async (p, env) => {
      const ws = workspace("L6");
      const a = await spawnAgent("L6", env);
      try {
        const s = await bexNewSession(a, ws);
        await prompt(a, s.sessionId, "before fork");
        const fork = await a.ctx
          .request(acp.methods.agent.session.fork, {
            sessionId: s.sessionId,
            cwd: ws,
            mcpServers: [],
          })
          .catch((e) => ({ error: e.message }));
        if (fork.error) {
          r.findings.push({
            title: "fork failed",
            actual: fork.error,
            known: /birth time/.test(fork.error) ? "#120" : undefined,
          });
          return;
        }
        for (const id of [fork.sessionId, s.sessionId]) {
          const res = await prompt(a, id, `branch ${id === s.sessionId ? "source" : "fork"}`);
          check(res.stopReason === "end_turn", "branch prompt failed after fork", { actual: res });
        }
      } finally {
        await a.close();
      }
    });
  }),

  scenario("L7", "Local and native slash commands", "loopback", async (r) => {
    const check = checker(r);
    await withLoopback({}, async (p, env) => {
      const a = await spawnAgent("L7", env);
      try {
        const s = await bexNewSession(a, workspace("L7"));
        await prompt(a, s.sessionId, "warm up");
        for (const cmd of [
          "/status",
          "/tasks",
          "/skills",
          "/mcp status",
          "/models",
          "/recap",
          "/compact",
          "/hooks",
          "/plugins",
        ]) {
          const res = await prompt(a, s.sessionId, cmd);
          check(res.stopReason === "end_turn" && !res.error, `${cmd} failed`, { actual: res });
          check(res.text.trim().length > 0, `${cmd} produced no reply text`);
          check(
            !/undefined|\[object Object\]|NaN/.test(res.text),
            `${cmd} reply contains a rendering artifact`,
            { actual: res.text.slice(0, 400) },
          );
        }
      } finally {
        await a.close();
      }
    });
  }),

  scenario("L8", "Two sessions prompting concurrently", "loopback", async (r) => {
    const check = checker(r);
    await withLoopback({ holdMs: 500 }, async (p, env) => {
      const a = await spawnAgent("L8", env);
      try {
        const [s1, s2] = await Promise.all([
          bexNewSession(a, workspace("L8a")),
          bexNewSession(a, workspace("L8b")),
        ]);
        const res = await Promise.all([
          prompt(a, s1.sessionId, "one"),
          prompt(a, s2.sessionId, "two"),
        ]);
        for (const x of res)
          check(x.stopReason === "end_turn", "concurrent session prompt failed", { actual: x });
      } finally {
        await a.close();
      }
    });
  }),

  scenario("L9", "Malformed and hostile inputs are refused cleanly", "loopback", async (r) => {
    const check = checker(r);
    await withLoopback({}, async (p, env) => {
      const a = await spawnAgent("L9", env);
      try {
        const refused = async (what, call) => {
          const out = await call().then(
            (v) => ({ ok: v }),
            (e) => ({ error: e }),
          );
          check(!!out.error, `${what} was accepted`, { actual: out.ok });
          check(
            !out.error || (out.error.code >= -32700 && out.error.code <= -32000),
            `${what}: not a JSON-RPC error`,
            { actual: String(out.error) },
          );
        };
        await refused("relative cwd", () =>
          a.ctx.request(acp.methods.agent.session.new, { cwd: "relative/dir", mcpServers: [] }),
        );
        const s = await bexNewSession(a, workspace("L9"));
        await refused("invalid option value", () =>
          a.ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: s.sessionId,
            configId: "reasoningEffort",
            value: "invented",
          }),
        );
        await refused("unknown mode", () =>
          a.ctx.request(acp.methods.agent.session.setMode, {
            sessionId: s.sessionId,
            modeId: "yolo-everything",
          }),
        );
        await refused("prompt to an unknown session", () =>
          a.ctx.request(acp.methods.agent.session.prompt, {
            sessionId: "00000000-0000-7000-8000-000000000000",
            prompt: [{ type: "text", text: "x" }],
          }),
        );
        const res = await prompt(a, s.sessionId, "/definitely-not-a-command please");
        check(res.stopReason === "end_turn", "unknown slash command is not plain text", {
          actual: res,
        });
        const after = await prompt(a, s.sessionId, "still alive?");
        check(after.stopReason === "end_turn", "agent unusable after malformed inputs", {
          actual: after,
        });
      } finally {
        await a.close();
      }
    });
  }),

  // ------------------------------------------------------------ real provider
  scenario("R1", "Real tool turn and reminder cards", "real", async (r) => {
    const check = checker(r);
    const ws = workspace("R1");
    const a = await spawnAgent("R1", realEnv());
    try {
      const s = await realSession(a, ws);
      const res = await prompt(
        a,
        s.sessionId,
        "Create a file r1.txt containing the word alpha, using your file write tool. Then reply done.",
        { real: true },
      );
      r.metrics.firstOutputMs = res.firstOutputMs;
      r.metrics.turnMs = res.ms;
      check(res.stopReason === "end_turn", "tool turn did not end_turn", { actual: res });
      check(existsSync(join(ws, "r1.txt")), "r1.txt not written");
    } finally {
      await a.close();
    }
  }),

  scenario("R2", "Sandbox-escaping write: Reject, then Allow once", "real", async (r) => {
    const check = checker(r);
    const ws = workspace("R2");
    const stamp = Date.now();
    const files = {
      reject: join(homedir(), `muse-acp-qa-${stamp}-reject.txt`),
      allow: join(homedir(), `muse-acp-qa-${stamp}-allow.txt`),
    };
    const a = await spawnAgent("R2", realEnv());
    try {
      const s = await realSession(a, ws);
      for (const [label, kind] of [
        ["reject", "reject_once"],
        ["allow", "allow_once"],
      ]) {
        const before = a.permissions.length;
        a.respond((req) => {
          const option = req.options.find((o) => o.kind === kind);
          return option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } };
        });
        const res = await prompt(
          a,
          s.sessionId,
          `Run this exact shell command: echo ${label} > ${files[label]}`,
          { real: true },
        );
        check(res.stopReason === "end_turn", `${label}: did not end_turn`, { actual: res });
        const asked = a.permissions.length > before;
        if (!asked) {
          // Muse's own policy or reviewer decided; that proves nothing about the
          // ACP round trip, so the scenario cannot pass on this attempt.
          r.inconclusive = true;
          r.notes.push(
            `${label}: Muse settled without an ACP permission request (host policy); file ${existsSync(files[label]) ? "written" : "not written"}`,
          );
        }
        if (asked)
          check(
            existsSync(files[label]) === (label === "allow"),
            `${label}: file state wrong after ${kind}`,
          );
      }
    } finally {
      for (const f of Object.values(files)) rmSync(f, { force: true });
      await a.close();
    }
  }),

  scenario(
    "R3-R4",
    "Compact, remember, restart, prompt and fork (#121 path)",
    "real",
    async (r) => {
      const check = checker(r);
      const ws = workspace("R3");
      const a = await spawnAgent("R3-before", realEnv());
      let sessionId;
      try {
        ({ sessionId } = await realSession(a, ws));
        await prompt(
          a,
          sessionId,
          "Create a file r3.txt containing beta with your file write tool, then reply done.",
          { real: true },
        );
        const compact = await prompt(a, sessionId, "/compact", { real: true });
        check(
          compact.stopReason === "end_turn" && /compacted|Nothing to compact/.test(compact.text),
          "/compact did not report an outcome",
          { actual: compact },
        );
        const memory = await prompt(
          a,
          sessionId,
          "Without using tools: which file did I ask you to create? One line.",
          { real: true },
        );
        check(/r3\.txt/.test(memory.text), "memory lost after /compact", {
          actual: memory.text.slice(0, 300),
        });
      } finally {
        await a.close();
      }
      const b = await spawnAgent("R4-after", realEnv());
      try {
        await b.ctx.request(acp.methods.agent.session.load, { sessionId, cwd: ws, mcpServers: [] });
        const res = await prompt(b, sessionId, "Reply with exactly: resumed", { real: true });
        check(res.stopReason === "end_turn", "prompt after compact + restart failed (#121 path)", {
          actual: res,
        });
        const fork = await b.ctx
          .request(acp.methods.agent.session.fork, { sessionId, cwd: ws, mcpServers: [] })
          .then(
            (v) => v,
            (e) => ({ error: e.message }),
          );
        if (fork.error)
          r.findings.push({
            title: "fork of a compacted session refused",
            actual: fork.error,
            // Forking a compacted session works (w3/016 disproved, 2026-10-27);
            // only the Linux birth-time failure is a known host limitation.
            known: /birth time/.test(fork.error) ? "#120" : undefined,
          });
      } finally {
        await b.close();
      }
    },
  ),

  scenario("R5", "MCP server survives compaction and resume (#112)", "real", async (r) => {
    const check = checker(r);
    const ws = workspace("R5");
    const server = join(QA, "work", "qa-mcp-server.cjs");
    writeFileSync(server, MCP_SERVER);
    const mcpServers = [{ name: "qa", command: process.execPath, args: [server], env: [] }];
    const ask = "Call the qa_echo tool with text ping and reply with exactly what it returned.";
    const a = await spawnAgent("R5-before", realEnv());
    let sessionId;
    try {
      ({ sessionId } = await realSession(a, ws, { mcpServers }));
      const first = await prompt(a, sessionId, ask, { real: true });
      check(/qa-pong/.test(first.text), "MCP tool not usable in a fresh session", {
        actual: first.text.slice(0, 300),
      });
      await prompt(a, sessionId, "/compact", { real: true });
    } finally {
      await a.close();
    }
    const b = await spawnAgent("R5-after", realEnv());
    try {
      await b.ctx.request(acp.methods.agent.session.load, { sessionId, cwd: ws, mcpServers });
      const again = await prompt(b, sessionId, ask, { real: true });
      if (!/qa-pong/.test(again.text))
        r.findings.push({
          title: "MCP tool unavailable after compact + resume",
          actual: again.text.slice(0, 300) || again.error,
          known: "#112",
        });
    } finally {
      await b.close();
    }
  }),

  scenario("R6", "Cancel a long real turn", "real", async (r) => {
    const check = checker(r);
    const a = await spawnAgent("R6", realEnv());
    try {
      const s = await realSession(a, workspace("R6"));
      const res = await prompt(
        a,
        s.sessionId,
        "Write a 1500 word essay about the history of the telescope. Do not use tools.",
        { real: true, cancelAfterMs: 8000 },
      );
      check(res.stopReason === "cancelled", "cancel did not settle as cancelled", {
        actual: { stopReason: res.stopReason, error: res.error, ms: res.ms },
      });
      check(res.ms - 8000 < 8000, "real cancel took more than 8 s", {
        actual: `${res.ms - 8000} ms`,
      });
    } finally {
      await a.close();
    }
  }),

  scenario("R7", "First-prompt latency with a prewarmed host", "real", async (r) => {
    const check = checker(r);
    const a = await spawnAgent("R7", realEnv());
    try {
      const s = await realSession(a, workspace("R7"));
      await sleep(20_000); // a user typing
      const res = await prompt(a, s.sessionId, "Reply with exactly: ok", { real: true });
      check(res.stopReason === "end_turn", "prompt failed", { actual: res });
      // Model time is Muse's and the provider's; what the adapter owns is the
      // wait before submission: with a prewarmed host, "preparing" is ~0 ms.
      const phases = readFileSync(join(a.logDir, "stderr.log"), "utf8").match(
        /phase preparing: (\d+)ms[^\n]*\n[^\n]*phase submitting: (\d+)ms/,
      );
      r.metrics.firstOutputMs = res.firstOutputMs;
      r.metrics.adapterWaitMs = phases ? Number(phases[1]) + Number(phases[2]) : undefined;
      check(
        r.metrics.adapterWaitMs !== undefined && r.metrics.adapterWaitMs < 2000,
        "first prompt waited for the Muse host to start (prewarm not used)",
        { actual: phases ? `${r.metrics.adapterWaitMs} ms before submission` : "no phase log" },
      );
    } finally {
      await a.close();
    }
  }),
];

/** A minimal MCP stdio server with one tool, for R5. */
const MCP_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "qa", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "qa_echo", description: "Echo text back with a qa- prefix", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "qa-" + (m.params?.arguments?.text === "ping" ? "pong" : m.params?.arguments?.text) }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`.replace(/^\n/, "");

// ----------------------------------------------------------------- runner
const selected = scenarios.filter(
  (s) =>
    (!ONLY || ONLY.has(s.id)) &&
    !(args["loopback-only"] && s.kind === "real") &&
    !(args["real-only"] && s.kind === "loopback"),
);
for (const s of selected) {
  const record = {
    id: s.id,
    title: s.title,
    kind: s.kind,
    status: "pass",
    findings: [],
    notes: [],
    metrics: {},
  };
  results.scenarios.push(record);
  const t0 = Date.now();
  process.stderr.write(`[qa] ${s.id} ${s.title} ...`);
  try {
    await s.run(record);
    if (record.findings.some((f) => !f.known)) record.status = "fail";
    else if (record.inconclusive) record.status = "inconclusive";
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      record.status = "skipped";
      record.notes.push(`real-turn budget (${BUDGET}) exhausted`);
    } else {
      record.status = "error";
      record.findings.push({ title: "scenario crashed", actual: error?.stack ?? String(error) });
    }
  }
  record.ms = Date.now() - t0;
  process.stderr.write(` ${record.status} (${Math.round(record.ms / 1000)} s)\n`);
  save();
}
results.finishedAt = new Date().toISOString();
save();
const failed = results.scenarios.filter((s) => s.status === "fail" || s.status === "error");
console.log(
  JSON.stringify({
    results: RESULTS_FILE,
    scenarios: results.scenarios.length,
    failed: failed.map((s) => s.id),
    turnsUsed: results.turnsUsed,
  }),
);
