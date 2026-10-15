import { methods } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMuseSdkTurn, type MuseSdkHost } from "../muse-sdk.js";
import { discoverSessions } from "../session-discovery.js";
import { connectTestClient, initialized, fixturesDir, silentLogger } from "./helpers.js";
const alive = (pid: number) => {
  for (const target of process.platform === "win32" ? [pid] : [pid, -pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch {
      /* No process with this owned PID/group remains. */
    }
  }
  return false;
};
function fixture(extra: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "muse-startup-"));
  const capture = join(cwd, "requests");
  const pidPath = join(cwd, "pid");
  const env = { ...process.env, FAKE_MSP_CAPTURE: capture, FAKE_MSP_PID: pidPath, ...extra };
  const options = {
    sessionId: "startup-session",
    cwd,
    env,
    museBinary: join(fixturesDir, "fake-msp.cjs"),
    checkHost: false,
    logger: silentLogger(),
  };
  return {
    ...options,
    requests: () =>
      existsSync(capture)
        ? readFileSync(capture, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((s) => JSON.parse(s))
        : [],
    turn: (hostOwner?: MuseSdkHost) =>
      spawnMuseSdkTurn({
        hostOwner,
        ...options,
        input: [{ type: "text", text: "hello" }],
        model: "test-model",
        reasoningEffort: "medium",
        readOnly: false,
        acpClient: {
          sessionUpdate: async () => {},
          requestPermission: async () => {
            throw new Error("unexpected approval");
          },
          createElicitation: async () => {
            throw new Error("unexpected input");
          },
        },
      }),
    clean: async () => {
      if (existsSync(pidPath))
        await expect
          .poll(() => alive(Number(readFileSync(pidPath, "utf8"))), { timeout: 5000 })
          .toBe(false);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
for (const method of ["initialize", "session/resume"])
  it(`preserves ${method} timeout across EOF and prevents submission`, async () => {
    // The startup deadline applies to each phase, so delaying session/resume
    // also needs spawn + initialize to finish within it. Give that phase
    // headroom under suite load, or the failure lands in "initializing".
    const deadlineMs = method === "initialize" ? 200 : 3000;
    const f = fixture({
      FAKE_MSP_DELAY_METHOD: method,
      FAKE_MSP_DELAY_MS: String(deadlineMs * 5),
      MUSE_CODE_ACP_STARTUP_TIMEOUT_MS: String(deadlineMs),
    });
    try {
      const turn = f.turn();
      await expect(turn.done).rejects.toMatchObject({
        data: {
          failure: {
            kind: "deadlineExceeded",
            execution: "notSubmitted",
            phase: method === "initialize" ? "initializing" : "preparing",
          },
        },
      });
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
    } finally {
      await f.clean();
    }
  });
for (const method of ["initialize", "session/resume"])
  it(`cancels ${method} and reaps the owned process`, async () => {
    const f = fixture({ FAKE_MSP_DELAY_METHOD: method, FAKE_MSP_DELAY_MS: "1000" });
    try {
      const turn = f.turn();
      await expect.poll(() => f.requests().some((r) => r.method === method)).toBe(true);
      turn.kill();
      await expect(turn.done).resolves.toEqual({ stopReason: "cancelled" });
      expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
    } finally {
      await f.clean();
    }
  });
it("keeps a dropped submission acknowledgement ambiguous without another submission", async () => {
  const f = fixture({ FAKE_MSP_BARRIER: "ack", MUSE_CODE_ACP_SUBMIT_TIMEOUT_MS: "200" });
  try {
    const turn = f.turn();
    await expect(turn.done).rejects.toMatchObject({
      data: {
        failure: {
          kind: "deadlineExceeded",
          phase: "submitting",
          execution: "possiblySubmitted",
          outcome: "unknown",
        },
      },
    });
    expect(f.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
  } finally {
    await f.clean();
  }
});
it("reports independently failed initialization without claiming execution", async () => {
  const f = fixture({ FAKE_MSP_EXIT_METHOD: "initialize" });
  try {
    await expect(f.turn().done).rejects.toMatchObject({
      data: { failure: { execution: "notSubmitted", phase: "initializing" } },
    });
  } finally {
    await f.clean();
  }
});
it("preserves read-host timeout cause and caller abort", async () => {
  const f = fixture({
    FAKE_MSP_DELAY_METHOD: "initialize",
    FAKE_MSP_DELAY_MS: "1000",
    MUSE_CODE_ACP_STARTUP_TIMEOUT_MS: "200",
  });
  try {
    await expect(discoverSessions({ ...f, backend: "sdk" })).rejects.toMatchObject({
      data: { failure: { kind: "deadlineExceeded", execution: "notSubmitted" } },
    });
  } finally {
    await f.clean();
  }
  const c = fixture({ FAKE_MSP_DELAY_METHOD: "initialize", FAKE_MSP_DELAY_MS: "1000" });
  const abort = new AbortController();
  try {
    const pending = discoverSessions({ ...c, backend: "sdk", signal: abort.signal });
    const checked = expect(pending).rejects.toThrow("cancelled");
    await expect.poll(() => c.requests().length > 0).toBe(true);
    abort.abort();
    await checked;
  } finally {
    await c.clean();
  }
});
it("adapter disposal aborts and awaits its read hosts", async () => {
  const f = fixture({ FAKE_MSP_DELAY_METHOD: "initialize", FAKE_MSP_DELAY_MS: "1000" });
  const client = connectTestClient({
    backend: "sdk",
    env: f.env,
    museBinary: f.museBinary,
    skipSdkHostCheck: true,
  });
  try {
    const c = await initialized(client, { _meta: { "muse/output": 1 } });
    const { sessionId } = await c.request(methods.agent.session.new, {
      cwd: f.cwd,
      mcpServers: [],
    });
    const before = f.requests().filter((r) => r.method === "initialize").length;
    const pending = c.request("_muse/readOutput", {
      sessionId,
      itemId: "missing",
      outputRef: "missing",
    });
    const failure = expect(pending).rejects.toMatchObject({
      data: { failure: { execution: "notSubmitted", kind: "cancelled" } },
    });
    await expect
      .poll(() => f.requests().filter((r) => r.method === "initialize").length)
      .toBeGreaterThan(before);
    await client.agent.dispose();
    await failure;
    expect(f.requests().some((r) => r.method === "turn/start")).toBe(false);
  } finally {
    await client.agent.dispose();
    await f.clean();
  }
});
it("a rejected cleanup cannot replace the initiating startup failure", async () => {
  const f = fixture();
  const owner = {
    reusable: true,
    stderr: "",
    acquire: async () => {
      throw new Error("original startup failure");
    },
    close: async () => {
      throw new Error("secondary cleanup failure");
    },
  } as unknown as MuseSdkHost;
  try {
    await expect(f.turn(owner).done).rejects.toMatchObject({
      message: expect.stringContaining("original startup failure"),
      data: { failure: { execution: "notSubmitted" } },
    });
  } finally {
    await f.clean();
  }
});
