/**
 * Fixture-level coverage for the replay scripts in `fixtures/fake-msp.cjs`.
 *
 * These assert the WIRE the fixture produces, independent of the adapter, so a
 * fixture that silently stops replaying the recorded Muse 1.2.1 multi-stage
 * shape fails here instead of quietly weakening the reconciler's tests.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixturesDir, ensureExecutable } from "./helpers.js";

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: { kind?: string } };
}

class FixtureHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (frame: Frame) => void; reject: (error: unknown) => void }
  >();
  readonly notifications: Frame[] = [];

  constructor(script?: string) {
    const binary = join(fixturesDir, "fake-msp.cjs");
    ensureExecutable(binary);
    this.child = spawn(process.execPath, [binary, "serve"], {
      env: { ...process.env, ...(script ? { FAKE_MSP_SCRIPT: script } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.ingest(chunk));
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      const frame = JSON.parse(line) as Frame;
      if (typeof frame.id === "number") {
        this.pending.get(frame.id)?.resolve(frame);
        this.pending.delete(frame.id);
      } else {
        this.notifications.push(frame);
      }
    }
  }

  /** Resolves with the raw frame so error replies can be asserted. */
  send(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params: { commandId: `cmd-${id}`, ...params } };
    return new Promise<Frame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  methods(): string[] {
    return this.notifications.map((n) => n.method ?? "");
  }

  last(method: string): Frame | undefined {
    return [...this.notifications].reverse().find((n) => n.method === method);
  }

  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  dispose(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

const hosts: FixtureHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

async function startTurn(script: string): Promise<FixtureHost> {
  const host = new FixtureHost(script);
  hosts.push(host);
  await host.send("initialize", { clientInfo: { name: "fixture_test", version: "0" } });
  await host.send("session/start", { sessionId: "s1", workspaceRoot: process.cwd() });
  await host.send("turn/start", { sessionId: "s1", input: [{ type: "text", text: "go" }] });
  await host.settle();
  return host;
}

function requirement(frame: Frame | undefined): number | undefined {
  return frame?.params?.currentRequirementId?.sourceIndex;
}

describe("fake MSP multi-stage approval scripts", () => {
  it("two-stage: a non-terminal decision is followed by an update naming the next stage", async () => {
    const host = await startTurn("two-stage");
    const requested = host.last("approval/requested");
    expect(requirement(requested)).toBe(0);
    expect(requested?.params?.subject.stages.map((s: any) => s.resolution.kind)).toEqual([
      "unresolved",
      "known_safe",
      "unresolved",
      "known_safe",
    ]);
    expect(requested?.params?.availableChoices.map((c: any) => c.choiceId)).toEqual([
      "allow_once",
      "abort",
    ]);

    const first = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_once",
      requirementId: { approvalId: "apr-staged", sourceIndex: 0 },
    });
    expect(first.result).toMatchObject({ status: "accepted", terminal: false });
    await host.settle();
    const update = host.last("approval/updated");
    expect(requirement(update)).toBe(2);
    expect(update?.params?.change).toMatchObject({ kind: "stageResolved", choiceId: "allow_once" });
    expect(host.methods()).not.toContain("turn/completed");

    const second = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_once",
      requirementId: { approvalId: "apr-staged", sourceIndex: 2 },
    });
    expect(second.result).toMatchObject({ terminal: true });
    await host.settle();
    expect(host.last("approval/resolved")?.params?.decision).toBe("approved");
    expect(host.last("turn/completed")?.params?.terminal).toBe("completed");
  });

  it("three-stage: each unresolved stage gets its own requirement", async () => {
    const host = await startTurn("three-stage");
    const seen: number[] = [];
    for (let stage = 0; stage < 3; stage++) {
      const current = requirement(host.last("approval/updated") ?? host.last("approval/requested"));
      expect(current).toBeDefined();
      seen.push(current!);
      const reply = await host.send("approval/decide", {
        sessionId: "s1",
        approvalId: "apr-staged",
        choiceId: "allow_once",
        requirementId: { approvalId: "apr-staged", sourceIndex: current },
      });
      expect(reply.result?.terminal).toBe(stage === 2);
      await host.settle();
    }
    expect(seen).toEqual([0, 2, 3]);
    expect(host.last("turn/completed")?.params?.terminal).toBe("completed");
  });

  it("deny-at-stage-2: aborting a later stage resolves the approval and runs nothing", async () => {
    const host = await startTurn("deny-at-stage-2");
    await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_once",
      requirementId: { approvalId: "apr-staged", sourceIndex: 0 },
    });
    await host.settle();
    const denied = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "abort",
      requirementId: { approvalId: "apr-staged", sourceIndex: 2 },
    });
    expect(denied.result).toMatchObject({ terminal: true });
    await host.settle();
    expect(host.last("approval/resolved")?.params).toMatchObject({
      decision: "abort",
      policyResult: "deny",
    });
    const tool = host.notifications
      .filter((n) => n.method === "item/completed")
      .map((n) => n.params?.item)
      .find((item) => item.kind === "toolCall");
    expect(tool.status).toBe("failed");
  });

  it("rejects a stale requirement and an unoffered choice with the documented codes", async () => {
    const host = await startTurn("two-stage");
    const stale = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_once",
      requirementId: { approvalId: "apr-staged", sourceIndex: 2 },
    });
    expect(stale.error).toMatchObject({ code: -32053, data: { kind: "approvalRequirementStale" } });
    const invented = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_always",
      requirementId: { approvalId: "apr-staged", sourceIndex: 0 },
    });
    expect(invented.error).toMatchObject({ code: -32052 });
  });

  it("choices-refresh: an update widens the offered choices without moving the requirement", async () => {
    const host = await startTurn("choices-refresh");
    const update = host.last("approval/updated");
    expect(requirement(update)).toBe(0);
    expect(update?.params?.availableChoices.map((c: any) => c.choiceId)).toEqual([
      "allow_once",
      "allow_session",
      "abort",
    ]);
    const reply = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_session",
      requirementId: { approvalId: "apr-staged", sourceIndex: 0 },
    });
    expect(reply.result).toMatchObject({ terminal: false });
  });

  it("decide-then-silence: a non-terminal decision is followed by no frame at all", async () => {
    const host = await startTurn("decide-then-silence");
    const reply = await host.send("approval/decide", {
      sessionId: "s1",
      approvalId: "apr-staged",
      choiceId: "allow_once",
      requirementId: { approvalId: "apr-staged", sourceIndex: 0 },
    });
    expect(reply.result).toMatchObject({ terminal: false });
    await host.settle();
    expect(host.methods()).not.toContain("approval/updated");
    expect(host.methods()).not.toContain("turn/completed");
  });

  it("userinput-settle-then-silence: the answer is accepted and never settled", async () => {
    const host = await startTurn("userinput-settle-then-silence");
    expect(host.methods()).toContain("userInput/requested");
    const reply = await host.send("userInput/answer", {
      sessionId: "s1",
      userInputId: "ui1",
      answers: [{ questionId: "q1", selected: ["red"] }],
    });
    expect(reply.result).toMatchObject({ status: "accepted" });
    await host.settle();
    expect(host.methods()).not.toContain("userInput/settled");
    expect(host.methods()).not.toContain("turn/completed");
  });

  it("unknown-method: an unrecognized notification precedes a normal terminal", async () => {
    const host = await startTurn("unknown-method");
    expect(host.methods()).toContain("session/futureFrame");
    expect(host.last("turn/completed")?.params?.terminal).toBe("completed");
  });
});
