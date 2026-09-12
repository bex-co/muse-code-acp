import { methods } from "@agentclientprotocol/sdk";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, fixturesDir, newTestSession } from "./helpers.js";

function sdkClient(mode: string) {
  const binary = join(fixturesDir, "fake-msp.cjs");
  chmodSync(binary, 0o755);
  const capture = join(mkdtempSync(join(tmpdir(), "muse-gap-")), "requests.jsonl");
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

describe("SDK view gap recovery", () => {
  it("recovers a pageable gap without an extra turn/start", async () => {
    const client = sdkClient("gapRecoverable");
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "gap" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    const text = client.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(text).toBe("hello world");
    expect(client.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(client.requests().some((r) => r.method === "view/page")).toBe(true);
  });

  it("fails deterministically when gap fill pages error", async () => {
    const client = sdkClient("gapFail");
    const { ctx, sessionId } = await newTestSession(client);
    await expect(
      ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "gap" }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/gap fill failed|reload the session/),
    });
    expect(client.agent.sessions.get(sessionId)?.activeTurn).toBeNull();
  });
});
