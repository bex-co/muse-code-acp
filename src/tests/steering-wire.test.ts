import { methods } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { STEER_METHOD } from "../steering-protocol.js";
import { createWireFixture } from "./acp-wire-helpers.js";

function activeId(updates: Awaited<ReturnType<typeof createWireFixture>>["updates"]) {
  return updates
    .map((n) => n.update._meta?.["muse/activeTurnId"])
    .findLast((id) => typeof id === "string");
}
it("negotiates steering, serializes corrections into captured turn and retains baseline busy rejection", async () => {
  const wire = await createWireFixture({
    fakeMspMode: "block",
    env: { FAKE_MSP_STEER: "delay" },
    clientCapabilities: { _meta: { "muse/steering": 1 } },
  });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const running = wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "initial" }],
    });
    await expect.poll(() => activeId(wire.updates)).toEqual(expect.any(String));
    const expectedTurnId = activeId(wire.updates) as string;
    const steer = (text: string) =>
      wire.ctx.request(STEER_METHOD, {
        sessionId,
        expectedTurnId,
        prompt: [{ type: "text", text }],
      });
    const [first, second] = await Promise.all([steer("first"), steer("second")]);
    expect(first).toMatchObject({ status: "accepted", turnId: expectedTurnId });
    expect(second).toEqual(first);
    await expect(
      wire.ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "baseline busy" }],
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await expect(
      wire.ctx.request(STEER_METHOD, {
        sessionId,
        expectedTurnId: "stale",
        prompt: [{ type: "text", text: "bad" }],
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await wire.ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    await expect(steer("after cancel")).rejects.toMatchObject({ code: -32600 });
    const requests = wire.getTranscript().mspRequests as {
      method: string;
      params: { input?: { text: string }[] };
    }[];
    expect(
      requests.filter((r) => r.method === "turn/steer").map((r) => r.params.input?.[0]!.text),
    ).toEqual(["first", "second"]);
    expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  } finally {
    await wire.dispose();
  }
});

it.each(["absent", "exec"])("does not allow steering for %s negotiation", async (mode) => {
  const wire = await createWireFixture({
    backend: mode === "exec" ? "exec" : "sdk",
    clientCapabilities: mode === "exec" ? { _meta: { "muse/steering": 1 } } : {},
  });
  try {
    const init = wire
      .getTranscript()
      .acpInbound.map((line) => JSON.parse(line))
      .find((row) => row.result?.agentCapabilities);
    expect(init?.result?._meta?.["muse/steering"]).toBeUndefined();
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    await expect(
      wire.ctx.request(STEER_METHOD, {
        sessionId,
        expectedTurnId: "no-turn",
        prompt: [{ type: "text", text: "no" }],
      }),
    ).rejects.toMatchObject({ code: -32600 });
  } finally {
    await wire.dispose();
  }
});

it("close settles an in-flight steering request and rejects its queued successor without replay", async () => {
  const wire = await createWireFixture({
    fakeMspMode: "block",
    env: { FAKE_MSP_STEER: "hang" },
    clientCapabilities: { _meta: { "muse/steering": 1 } },
  });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const running = wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "initial" }],
    });
    await expect.poll(() => activeId(wire.updates)).toEqual(expect.any(String));
    const expectedTurnId = activeId(wire.updates);
    const results = ["first", "queued"].map((text) =>
      wire.ctx
        .request(STEER_METHOD, { sessionId, expectedTurnId, prompt: [{ type: "text", text }] })
        .then(
          () => "accepted",
          () => "rejected",
        ),
    );
    await expect
      .poll(() =>
        wire
          .getTranscript()
          .mspRequests.some((r) => (r as { method: string }).method === "turn/steer"),
      )
      .toBe(true);
    await wire.ctx.request(methods.agent.session.close, { sessionId });
    expect(await Promise.all(results)).toEqual(["rejected", "rejected"]);
    expect(await running).toEqual({ stopReason: "cancelled" });
    expect(
      wire
        .getTranscript()
        .mspRequests.filter((r) => (r as { method: string }).method === "turn/steer"),
    ).toHaveLength(1);
  } finally {
    await wire.dispose();
  }
});

it("reports host steering rejection without restarting or replaying the prompt", async () => {
  const wire = await createWireFixture({
    fakeMspMode: "block",
    env: { FAKE_MSP_STEER: "fail" },
    clientCapabilities: { _meta: { "muse/steering": 1 } },
  });
  try {
    const { sessionId } = await wire.ctx.request(methods.agent.session.new, {
      cwd: wire.workspace,
      mcpServers: [],
    });
    const running = wire.ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "initial" }],
    });
    await expect.poll(() => activeId(wire.updates)).toEqual(expect.any(String));
    await expect(
      wire.ctx.request(STEER_METHOD, {
        sessionId,
        expectedTurnId: activeId(wire.updates),
        prompt: [{ type: "text", text: "rejected correction" }],
      }),
    ).rejects.toThrow();
    await wire.ctx.notify(methods.agent.session.cancel, { sessionId });
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    expect(
      wire
        .getTranscript()
        .mspRequests.filter((r) => (r as { method: string }).method === "turn/steer"),
    ).toHaveLength(1);
    expect(
      wire
        .getTranscript()
        .mspRequests.filter((r) => (r as { method: string }).method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await wire.dispose();
  }
});
