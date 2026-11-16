import {
  methods,
  type InitializeResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_HOLD, backgroundWork, wakeSettleMs } from "../background-hold.js";
import { connectTestClient, ensureExecutable, fixturesDir, initialized } from "./helpers.js";

const binary = join(fixturesDir, "fake-msp.cjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOLD = { _meta: { "muse/backgroundHold": 1, "muse/asyncTasks": 1 } };

async function held(
  wake: string,
  options: { negotiate?: boolean; env?: Record<string, string> } = {},
) {
  ensureExecutable(binary);
  const root = mkdtempSync(join(tmpdir(), "muse-hold-"));
  roots.push(root);
  const capture = join(root, "requests.jsonl");
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      FAKE_MSP_MODE: "backgroundWake",
      FAKE_MSP_WAKE: wake,
      FAKE_MSP_CAPTURE: capture,
      MUSE_CODE_ACP_WAKE_SETTLE_MS: "300",
      ...options.env,
    },
  });
  const ctx = await initialized(
    client,
    options.negotiate === false ? { _meta: { "muse/asyncTasks": 1 } } : HOLD,
  );
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: root,
    mcpServers: [],
  });
  let resolvedAt: number | undefined;
  let updatesAtResolve = 0;
  const prompt = (text = "launch the work") => {
    const pending = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    void pending.then(
      () => {
        resolvedAt = Date.now();
        updatesAtResolve = client.updates.length;
      },
      () => {},
    );
    return pending;
  };
  const text = (updates: SessionNotification[] = client.updates) =>
    updates
      .flatMap(({ update }) =>
        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
          ? [update.content.text]
          : [],
      )
      .join("");
  const cards = (kind: string) =>
    client.updates.flatMap(({ update }) =>
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      (update._meta?.["muse/asyncTasks"] as { kind?: string } | undefined)?.kind === kind
        ? [update]
        : [],
    );
  const requests = () =>
    readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
  return {
    client,
    ctx,
    sessionId,
    prompt,
    text,
    cards,
    requests,
    owner: () => client.agent.sessions.get(sessionId)?.sdkHost?.owner,
    resolved: () => resolvedAt !== undefined,
    beforeResolve: () => client.updates.slice(0, updatesAtResolve),
  };
}

describe("negotiation", () => {
  it("answers the capability only on the SDK backend, and only when the client asks", async () => {
    const sdk = connectTestClient({ backend: "sdk", skipSdkHostCheck: true, museBinary: binary });
    const answer = (await (
      await sdk.connect()
    ).request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: HOLD,
    })) as InitializeResponse;
    expect(answer._meta?.[BACKGROUND_HOLD]).toEqual({ version: 1, wakeSettleMs: 3000 });

    const plain = connectTestClient({ backend: "sdk", skipSdkHostCheck: true, museBinary: binary });
    const unasked = await (
      await plain.connect()
    ).request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    expect(unasked._meta?.[BACKGROUND_HOLD]).toBeUndefined();

    const exec = connectTestClient({ backend: "exec" });
    const execAnswer = (await (
      await exec.connect()
    ).request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: HOLD,
    })) as InitializeResponse;
    expect(execAnswer._meta?.[BACKGROUND_HOLD]).toBeUndefined();
  });

  it("validates the settle window and counts only unpaused background kinds", () => {
    expect(wakeSettleMs({})).toBe(3000);
    expect(wakeSettleMs({ MUSE_CODE_ACP_WAKE_SETTLE_MS: "0" })).toBe(0);
    for (const bad of ["-1", "1.5", "soon", "600001"])
      expect(() => wakeSettleMs({ MUSE_CODE_ACP_WAKE_SETTLE_MS: bad })).toThrow(/0\.\.600000/);
    const item = (kind: string, status = "inProgress", paused?: boolean, controlStatus?: string) =>
      ({ itemId: kind + status, kind, status, revision: 1, paused, controlStatus }) as never;
    expect(
      backgroundWork([
        item("workflow"),
        item("subagent"),
        item("subagent", "inProgress", false, "running"),
        // A workflow child that reported keeps an open, idle child session.
        item("subagent", "inProgress", false, "resultReady"),
        item("subagent", "inProgress", false, "closed"),
        item("toolCall"),
        item("userShell"),
        item("workflow", "inProgress", true),
        item("workflow", "completed"),
        item("reminderChild"),
        item("agentMessage"),
      ]).map((i) => i.kind),
    ).toEqual(["workflow", "subagent", "subagent", "toolCall", "userShell"]);
  });
});

describe("held prompt", () => {
  it("stays pending while a workflow runs and resolves after the reporting turn", async () => {
    const f = await held("workflow", { env: { FAKE_MSP_WAKE_MS: "600" } });
    const prompt = f.prompt();
    await expect.poll(() => f.cards("workflow").at(-1)?.status).toBe("in_progress");
    // The foreground turn has ended; the prompt has not.
    await expect.poll(() => f.text()).toContain("hello world");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.resolved()).toBe(false);
    expect(f.owner()?.closed).toBe(false);
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    // The workflow's result and the reporting turn reached the client first.
    expect(f.text(f.beforeResolve())).toContain("reported workflow completed");
    const before = f.beforeResolve();
    expect(
      before.some(
        ({ update }) =>
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === "workflow-call-" + firstTurn(f.requests()) &&
          update.status === "completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(f.client.updates)).not.toContain("outcome is unknown");
    expect(f.owner()?.closed).toBe(false);
  });

  it("holds across a backgrounded command the same way", async () => {
    const f = await held("bash");
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    expect(f.text(f.beforeResolve())).toContain("reported toolCall completed");
    expect(JSON.stringify(f.client.updates)).not.toContain("outcome is unknown");
  });

  it("follows chained wakes: a reporting turn that launches new work", async () => {
    const f = await held("chain");
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    const text = f.text(f.beforeResolve());
    expect(text.match(/reported workflow completed/g)).toHaveLength(2);
    expect(f.cards("workflow").filter((c) => c.status === "completed")).toHaveLength(2);
  });

  it("covers the wake gap: a reporting turn that starts late inside the settle window", async () => {
    const f = await held("workflow", {
      env: { FAKE_MSP_WAKE_GAP_MS: "200", MUSE_CODE_ACP_WAKE_SETTLE_MS: "1000" },
    });
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    expect(f.text(f.beforeResolve())).toContain("reported workflow completed");
  });

  it("adopts a reporting turn that starts the moment the foreground turn ends", async () => {
    const f = await held("workflow", { env: { FAKE_MSP_WAKE_MS: "0", FAKE_MSP_WAKE_GAP_MS: "0" } });
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    expect(f.text(f.beforeResolve())).toContain("reported workflow completed");
  });

  it("resolves after the settle window when finished work wakes no turn", async () => {
    const f = await held("silent", { env: { MUSE_CODE_ACP_WAKE_SETTLE_MS: "400" } });
    const started = Date.now();
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    // 300 ms of work, then the settle window.
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    expect(f.cards("workflow").at(-1)?.status).toBe("completed");
    expect(f.text()).not.toContain("reported");
  });

  it("refuses a second ordinary prompt while the first is held", async () => {
    const f = await held("workflow", { env: { FAKE_MSP_WAKE_MS: "600" } });
    const first = f.prompt();
    await expect.poll(() => f.cards("workflow").at(-1)?.status).toBe("in_progress");
    await expect(f.prompt("another task")).rejects.toMatchObject({ code: -32600 });
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("without the capability, resolves when the foreground turn ends (0.11.0)", async () => {
    const f = await held("workflow", { negotiate: false, env: { FAKE_MSP_WAKE_MS: "600" } });
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    expect(f.text(f.beforeResolve())).not.toContain("reported");
    expect(f.cards("workflow").at(-1)?.status).toBe("in_progress");
    // The retained host still reports the workflow's terminal, after the prompt.
    await expect.poll(() => f.cards("workflow").at(-1)?.status).toBe("completed");
    expect(f.text()).not.toContain("reported");
  });
});

describe("the reporting turn's approvals and cancellation", () => {
  it("asks the client for the reporting turn's approval and allows it only when chosen", async () => {
    const f = await held("approval");
    f.client.setPermissionResponder((request) => ({
      outcome: {
        outcome: "selected",
        optionId: request.options.find((o) => o.kind === "allow_once")!.optionId,
      },
    }));
    await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
    expect(f.client.permissionRequests).toHaveLength(1);
    expect(f.requests().filter((r) => r.method === "approval/decide")).toMatchObject([
      { params: { approvalId: "apr-wake", choiceId: "allow-once" } },
    ]);
    expect(f.text(f.beforeResolve())).toContain("reported workflow completed");
  });

  it("never grants a reporting turn's approval the client denied or dismissed", async () => {
    for (const outcome of ["deny", "dismiss"] as const) {
      const f = await held("approval");
      f.client.setPermissionResponder((request) =>
        outcome === "deny"
          ? {
              outcome: {
                outcome: "selected",
                optionId: request.options.find((o) => o.kind === "reject_once")!.optionId,
              },
            }
          : { outcome: { outcome: "cancelled" } },
      );
      await expect(f.prompt()).resolves.toEqual({ stopReason: "end_turn" });
      const decisions = f.requests().filter((r) => r.method === "approval/decide");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.params?.choiceId).toBe("deny-once");
    }
  });

  it("cancel during the hold stops the workflow and resolves cancelled", async () => {
    const f = await held("never", { env: { FAKE_MSP_SERVER_VERSION: "1.4.14" } });
    const prompt = f.prompt();
    await expect.poll(() => f.cards("workflow").at(-1)?.status).toBe("in_progress");
    await f.ctx.notify(methods.agent.session.cancel, { sessionId: f.sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(f.requests().filter((r) => r.method === "workflow/cancel")).toHaveLength(1);
    await expect.poll(() => f.cards("workflow").at(-1)?.status).toBe("failed");
    expect(JSON.stringify(f.cards("workflow").at(-1))).toContain("cancelled");
  });

  it("cancel during the reporting turn interrupts it and never answers its approval", async () => {
    const f = await held("approval");
    let asked!: () => void;
    const waiting = new Promise<void>((resolve) => (asked = resolve));
    f.client.setPermissionResponder(() => {
      asked();
      return new Promise(() => {});
    });
    const prompt = f.prompt();
    await waiting;
    await f.ctx.notify(methods.agent.session.cancel, { sessionId: f.sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(f.requests()).toContainEqual(
      expect.objectContaining({
        method: "turn/cancel",
        params: expect.objectContaining({ turnId: "wake-1" }),
      }),
    );
    expect(f.requests().some((r) => r.method === "approval/decide")).toBe(false);
  });
});

function firstTurn(requests: { method: string; params?: Record<string, unknown> }[]): string {
  return String(requests.find((r) => r.method === "turn/start")?.params?.commandId);
}
