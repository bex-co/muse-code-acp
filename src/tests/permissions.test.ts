import { methods } from "@agentclientprotocol/sdk";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  choicesToPermissionOptions,
  PermissionLifecycle,
  resolvePermissionChoice,
} from "../muse-permissions.js";
import { connectTestClient, fixturesDir, newTestSession } from "./helpers.js";

function sdkClient(mode = "approval") {
  const binary = join(fixturesDir, "fake-msp.cjs");
  chmodSync(binary, 0o755);
  const capture = join(mkdtempSync(join(tmpdir(), "muse-perm-")), "requests.jsonl");
  const testClient = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: { ...process.env, FAKE_MSP_MODE: mode, FAKE_MSP_CAPTURE: capture },
  });
  return {
    ...testClient,
    requests: () =>
      readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

describe("permission mapping", () => {
  it("uses host choice IDs and only offers scopes the host listed", () => {
    const options = choicesToPermissionOptions([
      { choiceId: "a1", label: "Allow", decision: "approved", scope: "once" },
      { choiceId: "d1", label: "Deny", decision: "denied", scope: "once" },
      {
        choiceId: "a-session",
        label: "Allow for session",
        decision: "approvedForSession",
        scope: "session",
      },
    ]);
    expect(options.map((o) => o.optionId)).toEqual(["a1", "d1", "a-session"]);
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "reject_once", "allow_always"]);
  });

  it("maps cancellation to a deny choice and rejects unknown option IDs", () => {
    const request = {
      approvalId: "apr1",
      availableChoices: [
        { choiceId: "allow-once", label: "Allow", decision: "approved", scope: "once" },
        { choiceId: "deny-once", label: "Deny", decision: "denied", scope: "once" },
      ],
      currentRequirementId: { approvalId: "apr1", sourceIndex: 0 },
      itemId: "i",
      rawArgs: "{}",
      toolCallId: "c",
      toolName: "bash",
      turnId: "t",
    };
    expect(resolvePermissionChoice(request, { outcome: { outcome: "cancelled" } })).toBe(
      "deny-once",
    );
    expect(() =>
      resolvePermissionChoice(request, {
        outcome: { outcome: "selected", optionId: "fabricated" },
      }),
    ).toThrow(/unknown option/);
  });

  it("isolates concurrent and stale permission lifetimes", () => {
    const life = new PermissionLifecycle();
    const gen1 = life.beginTurn("t1");
    expect(life.track("a", "t1", "c1", gen1)).toBe(true);
    expect(life.track("b", "t1", "c2", gen1)).toBe(true);
    life.resolve("a");
    expect(life.isLive("a", "t1", gen1)).toBe(false);
    expect(life.isLive("b", "t1", gen1)).toBe(true);
    const gen2 = life.beginTurn("t2");
    expect(life.isLive("b", "t1", gen1)).toBe(false);
    expect(life.track("late", "t1", "c3", gen1)).toBe(false);
    expect(life.track("c", "t2", "c4", gen2)).toBe(true);
  });
});

describe("SDK approvals over ACP", () => {
  it("waits for a client allow decision before completing the tool", async () => {
    const client = sdkClient("approval");
    let release!: (value: RequestPermissionResponse) => void;
    const gate = new Promise<RequestPermissionResponse>((resolve) => {
      release = resolve;
    });
    client.setPermissionResponder(() => gate);
    const { ctx, sessionId } = await newTestSession(client);
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "need approval" }],
    });
    await expect.poll(() => client.permissionRequests.length).toBe(1);
    expect(client.requests().some((r) => r.method === "approval/decide")).toBe(false);
    const request = client.permissionRequests[0];
    expect(request.toolCall.toolCallId).toBe("call1");
    expect(request.options.map((o) => o.optionId)).toEqual(["allow-once", "deny-once"]);
    release({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    const decide = client.requests().find((r) => r.method === "approval/decide");
    expect(decide.params.choiceId).toBe("allow-once");
    expect(decide.params.approvalId).toBe("apr1");
    const tool = client.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
    expect(tool).toMatchObject({ toolCallId: "call1", status: "completed" });
  });

  it("denies through a host-offered choice and never fabricates allow", async () => {
    const client = sdkClient("approval");
    client.setPermissionResponder(() => ({
      outcome: { outcome: "selected", optionId: "deny-once" },
    }));
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "deny me" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(client.requests().find((r) => r.method === "approval/decide").params.choiceId).toBe(
      "deny-once",
    );
  });

  it("keeps concurrent approvals correlated by request id, not tool name", async () => {
    const client = sdkClient("concurrentApprovals");
    const seen: string[] = [];
    client.setPermissionResponder(async (params) => {
      seen.push(params.toolCall.toolCallId!);
      return {
        outcome: {
          outcome: "selected",
          optionId: params.toolCall.toolCallId === "call1" ? "allow-once" : "deny-once",
        },
      };
    });
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "two tools" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(seen.sort()).toEqual(["call1", "call2"]);
    const decides = client.requests().filter((r) => r.method === "approval/decide");
    expect(decides).toHaveLength(2);
    expect(decides.map((d) => d.params.approvalId).sort()).toEqual(["apr1", "apr2"]);
  });
});

type RequestPermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};
