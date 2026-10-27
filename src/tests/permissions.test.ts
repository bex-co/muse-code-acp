import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  choicesToPermissionOptions,
  approvalStageMetadata,
  approvalToPermissionRequest,
  type MuseApprovalRequest,
  PermissionLifecycle,
  resolvePermissionChoice,
} from "../muse-permissions.js";
import { connectTestClient, fixturesDir, newTestSession, ensureExecutable } from "./helpers.js";

function sdkClient(mode = "approval", script?: string) {
  const binary = join(fixturesDir, "fake-msp.cjs");
  ensureExecutable(binary);
  const capture = join(mkdtempSync(join(tmpdir(), "muse-perm-")), "requests.jsonl");
  const testClient = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: {
      ...process.env,
      FAKE_MSP_MODE: mode,
      FAKE_MSP_CAPTURE: capture,
      ...(script ? { FAKE_MSP_SCRIPT: script } : {}),
    },
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
  it("renders only matching host stage evidence and preserves single-stage and incomplete fallbacks", () => {
    const request: MuseApprovalRequest = {
      approvalId: "a",
      availableChoices: [{ choiceId: "yes", label: "Allow", decision: "approved", scope: "once" }],
      currentRequirementId: { approvalId: "a", sourceIndex: 42 },
      itemId: "i",
      toolCallId: "c",
      toolName: "bash",
      turnId: "t",
      rawArgs: JSON.stringify({
        command: "not parsed; even > here",
        description: "Original title",
      }),
    };
    const stage = {
      argv: ["echo", "two words", "", "semi;colon"],
      position: 2,
      totalStages: 3,
      requirementId: request.currentRequirementId,
      resolution: { kind: "futureReviewerState" },
    };
    const earlier = { ...stage, position: 1, requirementId: { approvalId: "a", sourceIndex: 7 } };
    const baseline = approvalToPermissionRequest("s", request);
    const staged = { ...request, subject: { kind: "shell", stages: [earlier, stage] } };
    const shown = approvalToPermissionRequest("s", staged);
    expect(shown).toEqual({
      ...baseline,
      toolCall: { ...baseline.toolCall, title: 'Stage 2 of 3: echo "two words" "" "semi;colon"' },
    });
    for (const stages of [
      [{ ...stage, position: 1, totalStages: 1 }],
      [{ ...earlier, resolution: { kind: "knownSafe" } }, stage],
      [{ ...earlier, resolution: { kind: "known_safe" } }, stage],
      [earlier, { ...stage, argv: undefined }],
      [earlier, { ...stage, argv: [] }],
      [earlier, { ...stage, position: 0 }],
      [earlier, { ...stage, requirementId: { approvalId: "other", sourceIndex: 42 } }],
    ]) {
      expect(
        approvalToPermissionRequest("s", { ...request, subject: { kind: "shell", stages } }),
      ).toEqual(baseline);
    }
  });

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
    expect(request!.toolCall.toolCallId).toBe("call1");
    expect(request!.toolCall.title).toBe("Show directory");
    expect(request!.options.map((o) => o.optionId)).toEqual(["allow-once", "deny-once"]);
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

describe("multi-stage SDK approvals", () => {
  /** One ACP request per unresolved stage, answered with the host's own choices. */
  function stagedResponder(client: ReturnType<typeof sdkClient>, pick: (stage: number) => string) {
    const seen: { stage: number; options: string[] }[] = [];
    client.setPermissionResponder((params) => {
      const stage = (params._meta?.museRequirementId as { sourceIndex: number }).sourceIndex;
      seen.push({ stage, options: params.options.map((o) => o.optionId) });
      return { outcome: { outcome: "selected", optionId: pick(stage) } };
    });
    return seen;
  }

  function decides(client: ReturnType<typeof sdkClient>) {
    return client.requests().filter((r) => r.method === "approval/decide");
  }

  it.each([false, true])(
    "renders each stage and preserves decisions (extended: %s)",
    async (extended) => {
      const client = sdkClient("complete", "two-stage");
      const seen = stagedResponder(client, () => "allow_once");
      const { ctx, sessionId } = await newTestSession(
        client,
        extended ? { _meta: { "muse/approval": 1 } } : {},
      );
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "compound command" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });

      expect(seen.map((s) => s.stage)).toEqual([0, 2]);
      expect(client.permissionRequests.map((r) => r.toolCall.title)).toEqual([
        "Stage 1 of 4: echo one",
        "Stage 3 of 4: echo two",
      ]);
      for (const request of client.permissionRequests) {
        expect(request.toolCall.rawInput).toEqual({
          command: "echo one > a.txt; ls .; echo two > b.txt; cat a.txt",
          description: "Run the compound command",
        });
        expect(request._meta?.["muse/approval"] !== undefined).toBe(extended);
      }
      if (extended) {
        expect(client.permissionRequests[1]!._meta?.["muse/approval"]).toEqual({
          judgeEscalated: false,
          protectedWrite: false,
          subjectKind: "shellCommand",
          stages: ["allow_once", "known_safe", "unresolved", "known_safe"].map(
            (resolutionKind, i) => ({
              position: i + 1,
              totalStages: 4,
              requirementId: { approvalId: "apr-staged", sourceIndex: i },
              resolutionKind,
            }),
          ),
        });
      }
      expect(decides(client).map((d) => d.params.requirementId.sourceIndex)).toEqual([0, 2]);
      expect(
        client.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call"),
      ).toMatchObject({ toolCallId: "call1" });
      const tool = client.updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
        .at(-1);
      expect(tool).toMatchObject({ status: "completed" });
    },
  );

  it("carries the refreshed stage evidence of the requirement being decided", async () => {
    const client = sdkClient("complete", "two-stage");
    const stages: string[][] = [];
    client.setPermissionResponder((params) => {
      const meta = params._meta?.["muse/approval"] as { stages?: { resolutionKind: string }[] };
      stages.push((meta.stages ?? []).map((s) => s.resolutionKind));
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });
    const { ctx, sessionId } = await newTestSession(client, { _meta: { "muse/approval": 1 } });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "compound command" }],
    });
    expect(stages[0]).toEqual(["unresolved", "known_safe", "unresolved", "known_safe"]);
    // The second ask reflects the first decision rather than the opening view.
    expect(stages[1]).toEqual(["allow_once", "known_safe", "unresolved", "known_safe"]);
  });

  it("handles more than two unresolved stages", async () => {
    const client = sdkClient("complete", "three-stage");
    const seen = stagedResponder(client, () => "allow_once");
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "three writes" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(seen.map((s) => s.stage)).toEqual([0, 2, 3]);
    expect(client.permissionRequests.map((r) => r.toolCall.title)).toEqual([
      "Stage 1 of 4: echo one",
      "Stage 3 of 4: echo two",
      "Stage 4 of 4: cat a.txt",
    ]);
    expect(new Set(client.permissionRequests.map((r) => r.toolCall.title)).size).toBe(3);
    expect(decides(client)).toHaveLength(3);
  });

  it("denies a later stage with a host-offered choice and runs nothing", async () => {
    const client = sdkClient("complete", "deny-at-stage-2");
    const seen = stagedResponder(client, (stage) => (stage === 0 ? "allow_once" : "abort"));
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "deny the second write" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(seen.map((s) => s.stage)).toEqual([0, 2]);
    expect(decides(client).map((d) => d.params.choiceId)).toEqual(["allow_once", "abort"]);
    const tool = client.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
      .at(-1);
    expect(tool).toMatchObject({ status: "failed" });
  });

  it("offers the refreshed choices when an update widens them before any decision", async () => {
    const client = sdkClient("complete", "choices-refresh");
    const seen = stagedResponder(client, () => "allow_session");
    const { ctx, sessionId } = await newTestSession(client);
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "refresh" }],
    });
    expect(seen[0]!.options).toEqual(["allow_once", "allow_session", "abort"]);
    expect(decides(client)[0].params.choiceId).toBe("allow_session");
  });

  it("re-reads the fold when a decision is rejected as stale instead of failing", async () => {
    const client = sdkClient("complete", "stale-then-progress");
    const seen = stagedResponder(client, () => "allow_once");
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "raced decision" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    // Stage 0 bounced with -32053; the refreshed requirement was decided next.
    expect(seen.map((s) => s.stage)).toEqual([0, 1]);
    expect(decides(client).map((d) => d.params.requirementId.sourceIndex)).toEqual([0, 1]);
  });

  it("never submits a choice the host did not offer for the current requirement", async () => {
    const client = sdkClient("complete", "two-stage");
    client.setPermissionResponder(() => ({
      outcome: { outcome: "selected", optionId: "allow_always" },
    }));
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "invented choice" }],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("unknown option") });
    expect(decides(client)).toHaveLength(0);
  });
});

type RequestPermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};

it("negotiates observed permission fields and final decisions without changing choices", async () => {
  const client = sdkClient();
  const { ctx, sessionId } = await newTestSession(client, { _meta: { "muse/approval": 1 } });
  client.setPermissionResponder((request) => ({
    outcome: {
      outcome: "selected",
      optionId: request.options.find((option) => option.kind === "allow_once")!.optionId,
    },
  }));
  await ctx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  expect(client.permissionRequests[0]!._meta?.["muse/approval"]).toMatchObject({
    judgeEscalated: false,
    protectedWrite: false,
    subjectKind: "toolCall",
  });
  const results = client.updates.flatMap((n) =>
    n.update.sessionUpdate === "session_info_update" && n.update._meta?.["muse/approval"]
      ? [n.update._meta["muse/approval"]]
      : [],
  );
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ decision: "approved", resolvedBy: "user" });
});

it("preserves unknown observed reviewer stage kinds without inventing a decision", () => {
  expect(
    approvalStageMetadata({
      position: 1,
      totalStages: 2,
      requirementId: { approvalId: "a", sourceIndex: 4 },
      resolution: { kind: "futureReviewerState" },
    }),
  ).toEqual({
    position: 1,
    totalStages: 2,
    requirementId: { approvalId: "a", sourceIndex: 4 },
    resolutionKind: "futureReviewerState",
  });
});

it("reports rejected approval MSP codes without exposing arbitrary host details", async () => {
  const client = sdkClient("approvalSubmitFailure");
  const { ctx, sessionId } = await newTestSession(client);
  try {
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "approval rejected by host" }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Muse approval decision rejected (MSP -32051)"),
    });
    expect(client.requests().filter((r) => r.method === "approval/decide")).toHaveLength(1);
    expect(client.updates.some((n) => JSON.stringify(n).includes("sensitive host detail"))).toBe(
      false,
    );
  } finally {
    await client.agent.dispose();
  }
});

it.each([
  ["bypassApprovals", "two-stage", ["allow_once", "allow_once"]],
  ["bypassApprovals", "choices-refresh", ["allow_once", "allow_once"]],
  ["bypassApprovals", "stale-then-progress", ["allow_once", "allow_once"]],
  ["rejectApprovals", "two-stage", ["abort"]],
] as const)("automatic %s uses only host once choices (%s)", async (mode, script, expected) => {
  const client = sdkClient("complete", script);
  const { ctx, sessionId } = await newTestSession(client);
  try {
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "mode",
      value: mode,
    });
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "automatic stages" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(client.permissionRequests).toHaveLength(0);
    expect(
      client
        .requests()
        .filter((r) => r.method === "approval/decide")
        .map((r) => r.params.choiceId),
    ).toEqual(expected);
  } finally {
    await client.agent.dispose();
  }
});

it("fails closed without an eligible automatic once choice", async () => {
  const client = sdkClient("approvalNoOnce");
  const { ctx, sessionId } = await newTestSession(client);
  try {
    await ctx.request(methods.agent.session.setMode, { sessionId, modeId: "bypassApprovals" });
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "no eligible choice" }],
      }),
    ).rejects.toThrow(/no eligible once choice/);
    expect(client.permissionRequests).toHaveLength(0);
    expect(client.requests().filter((r) => r.method === "approval/decide")).toHaveLength(0);
  } finally {
    await client.agent.dispose();
  }
});
