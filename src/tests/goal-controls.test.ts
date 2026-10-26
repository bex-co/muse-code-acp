import { methods } from "@agentclientprotocol/sdk";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectTestClient, fixturesDir, initialized, ensureExecutable } from "./helpers.js";

const binary = join(fixturesDir, "fake-msp.cjs");

it("runs native goal controls and reports Muse's refusals", async () => {
  ensureExecutable(binary);
  const client = connectTestClient({
    backend: "sdk",
    museBinary: binary,
    skipSdkHostCheck: true,
    env: { ...process.env, FAKE_MSP_MODE: "complete" },
  });
  const ctx = await initialized(client, { _meta: { "muse/goal": 1 } });
  const { sessionId } = await ctx.request(methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const goal = (text: string) =>
    ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const lastText = () =>
    JSON.stringify(
      client.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk").at(-1),
    );
  const turnStarts = () =>
    client.updates.filter((n) => n.update.sessionUpdate === "tool_call").length;

  await expect(goal("/goal set ship the feature")).resolves.toEqual({ stopReason: "end_turn" });
  expect(lastText()).toContain("Goal set accepted");
  expect(lastText()).toContain("Goal: ship the feature");
  await goal("/goal edit ship it well");
  expect(lastText()).toContain("Goal: ship it well");
  await goal("/goal pause");
  expect(lastText()).toContain("Status: paused");
  await expect(goal("/goal pause")).rejects.toThrow(
    "Muse did not pause the goal: invalid_goal_state",
  );
  await goal("/goal resume");
  expect(lastText()).toContain("Status: active");
  await goal("/goal clear");
  expect(lastText()).toContain("No recorded goal");
  await expect(goal("/goal edit after clear")).rejects.toThrow("missing_goal");
  expect(turnStarts()).toBe(0);
  await client.agent.dispose();
});

it("advertises goal controls on SDK hosts that can run them", async () => {
  ensureExecutable(binary);
  const sdk = connectTestClient({ backend: "sdk", museBinary: binary, skipSdkHostCheck: true });
  const sdkInit = await (
    await sdk.connect()
  ).request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: { _meta: { "muse/goal": 1 } },
  });
  expect(sdkInit._meta?.["muse/goal"]).toMatchObject({
    controls: ["set", "edit", "pause", "resume", "clear"],
  });
  await sdk.agent.dispose();
});
