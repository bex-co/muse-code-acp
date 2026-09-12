#!/usr/bin/env node
/**
 * Pack the adapter, install into a clean temp directory, and run a prompt over stdio.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import assert from "node:assert/strict";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "muse-acp-pack-"));
const installDir = join(work, "install");
mkdirSync(installDir);

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
  return result;
}

try {
  run("npm", ["run", "build"]);
  const pack = run("npm", ["pack", "--pack-destination", work]);
  const tarballName = pack.stdout.trim().split("\n").filter(Boolean).at(-1);
  const tarball = join(work, tarballName);
  run("npm", ["install", tarball], { cwd: installDir });

  const pkg = JSON.parse(
    readFileSync(join(installDir, "node_modules/@bex-co/muse-code-acp/package.json"), "utf8"),
  );
  if (!pkg.dependencies?.["@muse-code/sdk"]) {
    throw new Error("packed package is missing @muse-code/sdk dependency");
  }
  const bin = join(installDir, "node_modules/@bex-co/muse-code-acp/dist/index.js");
  const fakeMsp = join(work, "fake-msp.cjs");
  copyFileSync(join(repoRoot, "src/tests/fixtures/fake-msp.cjs"), fakeMsp);
  chmodSync(fakeMsp, 0o755);
  const capture = join(work, "requests.jsonl");
  const child = spawn(process.execPath, [bin], {
    cwd: installDir,
    env: {
      ...process.env,
      MUSE_CODE_ACP_BACKEND: "sdk",
      MUSE_CODE_EXECUTABLE: fakeMsp,
      FAKE_MSP_MODE: "complete",
      FAKE_MSP_CAPTURE: capture,
      HOME: work,
      XDG_CONFIG_HOME: join(work, "config"),
      XDG_DATA_HOME: join(work, "data"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  void exited.catch(() => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const updates = [];
  let resolveContext;
  const context = new Promise((resolve) => {
    resolveContext = resolve;
  });
  const connection = client({ name: "pack-smoke" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
    })
    .onConnect((conn) => {
      resolveContext(conn.agent);
    })
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  let timer;
  try {
    await Promise.race([
      (async () => {
        const ctx = await context;
        const init = await ctx.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        assert.equal(init.protocolVersion, 1);
        const { sessionId } = await ctx.request(methods.agent.session.new, {
          cwd: installDir,
          mcpServers: [],
        });
        const result = await ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "packed prompt" }],
        });
        assert.deepEqual(result, { stopReason: "end_turn" });
        assert.equal(
          updates
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => u.content.text)
            .join(""),
          "hello world",
        );
        const requests = readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const turns = requests.filter((r) => r.method === "turn/start");
        assert.equal(turns.length, 1);
        assert.deepEqual(turns[0].params.input, [{ type: "text", text: "packed prompt" }]);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Packed prompt timed out: ${stderr}`)), 20_000);
      }),
      exited.then(() => {
        throw new Error(`Packed agent exited prematurely: ${stderr}`);
      }),
    ]);
    console.log(`pack-smoke ok: ${tarballName} initialize/new/prompt/stream/end_turn`);
  } finally {
    clearTimeout(timer);
    connection.close();
    if (child.exitCode === null && child.signalCode === null) {
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM");
      await exited.catch(() => {});
      clearTimeout(killTimer);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
