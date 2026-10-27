import { expect, it } from "vitest";
import { nativePolicyAvailability, requireAvailable, unavailable } from "../availability.js";
import { availableModes, MODES, modeAvailability } from "../modes.js";
import { safetyConfigOptions } from "../safety-settings.js";

it("uses the same mode decision for advertisement and selection across guards/backends", () => {
  for (const backend of ["sdk", "exec"] as const)
    for (const isRoot of [false, true])
      for (const optIn of [undefined, "1"]) {
        const guard = { isRoot, env: { MUSE_CODE_ACP_ALLOW_YOLO: optIn } };
        const advertised = new Set(availableModes(guard, backend).map((m) => m.id));
        for (const id of Object.keys(MODES)) {
          const decision = modeAvailability(id, guard, backend);
          expect(advertised.has(id as keyof typeof MODES)).toBe(decision.available);
          if (decision.available) expect(() => requireAvailable(decision)).not.toThrow();
          else expect(() => requireAvailable(decision)).toThrow();
        }
      }
  expect(modeAvailability("unknown", { isRoot: false, env: {} }, "sdk")).toMatchObject({
    kind: "unknown",
  });
  expect(modeAvailability("yolo", { isRoot: false, env: {} }, "sdk")).toMatchObject({
    kind: "backend",
  });
  expect(modeAvailability("bypassApprovals", { isRoot: true, env: {} }, "sdk")).toMatchObject({
    kind: "guard",
  });
});
it("does not advertise native policies rejected on 1.1.1 or unverified hosts", () => {
  for (const host of [null, "1.1.1", "1.2.1"]) {
    const option = safetyConfigOptions(undefined, { env: {}, isRoot: false }, host).find(
      (o) => o.id === "nativeApprovalPolicy",
    )!;
    expect(option.type).toBe("select");
    if (option.type !== "select") throw Error("wrong type");
    const values = option.options.flatMap((o) => ("value" in o ? [o.value] : []));
    expect(values).toEqual(
      host === "1.2.1"
        ? ["onRequest", "promptUnmatched", "denyUnmatched", "allowAll"]
        : ["onRequest"],
    );
    for (const policy of values)
      expect(nativePolicyAvailability(policy, host).available).toBe(true);
  }
  expect(nativePolicyAvailability("allowAll", null)).toMatchObject({ kind: "unverified" });
  expect(nativePolicyAvailability("allowAll", "1.1.1")).toMatchObject({ kind: "version" });
  // Native limitations must not suppress the independent adapter once-choice path.
  expect(availableModes({ env: {}, isRoot: false }, "sdk").map((m) => m.id)).toContain(
    "bypassApprovals",
  );
});
it("reports temporary busy state separately without changing configuration", () => {
  expect(() => requireAvailable(unavailable("busy", "Wait for the active turn"))).toThrow(/Wait/);
  try {
    requireAvailable(unavailable("busy", "Wait"));
  } catch (error) {
    expect(error).toMatchObject({ code: -32600, data: { availability: "busy" } });
  }
});

it("rejects extra roots at every session entry before provider or filesystem work where Muse cannot enforce them", async () => {
  const { connectTestClient, initialized } = await import("./helpers.js");
  const { methods } = await import("@agentclientprotocol/sdk");
  // The exec backend has no workspaceRoots; SDK hosts before 1.4.13 likewise.
  const client = connectTestClient({ backend: "exec" });
  const ctx = await initialized(client);
  for (const method of [
    methods.agent.session.new,
    methods.agent.session.load,
    methods.agent.session.resume,
  ]) {
    await expect(
      ctx.request(method, {
        sessionId: "nonexistent",
        cwd: "/nonexistent",
        mcpServers: [],
        additionalDirectories: ["/also-nonexistent"],
      } as never),
    ).rejects.toMatchObject({ code: -32602, data: { availability: "unsupported" } });
  }
  // Fork itself is unsupported on exec and is refused before roots are considered.
  await expect(
    ctx.request(methods.agent.session.fork, {
      sessionId: "nonexistent",
      cwd: "/nonexistent",
      mcpServers: [],
      additionalDirectories: ["/also-nonexistent"],
    } as never),
  ).rejects.toMatchObject({ code: -32600 });
  expect(client.agent.sessions.size).toBe(0);
  expect(client.updates).toHaveLength(0);
});
