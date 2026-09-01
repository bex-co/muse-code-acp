import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectTestClient, museAvailable } from "./helpers.js";
import { initialized } from "./helpers.js";
import { CAT_IMAGE_BASE64 } from "./fixtures/cat-image.js";

/**
 * The one real-model run in the suite (m2 definition of done). Gated behind
 * RUN_INTEGRATION_TESTS because it costs API quota; guardrails: low effort,
 * capped steps, temp workspace, isolated session store.
 */
const enabled = process.env.RUN_INTEGRATION_TESTS === "true" && museAvailable();

describe.skipIf(!enabled)("real provider integration", () => {
  it("runs a tool-using turn with streamed tool calls and diffs", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-integration-xdg-"));
    const testClient = connectTestClient({
      env: { ...process.env, XDG_DATA_HOME: xdg },
    });
    const ctx = await initialized(testClient);
    const cwd = mkdtempSync(join(tmpdir(), "muse-integration-cwd-"));
    const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "low",
    });

    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        {
          type: "text",
          text:
            "Create a file named marker.txt containing exactly the word beacon, " +
            "then run the shell command: cat marker.txt. Then stop.",
        },
      ],
    });

    expect(response.stopReason).toBe("end_turn");
    const updates = testClient.updates.map((u) => u.update);
    const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call");
    const toolUpdates = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolUpdates.some((u) => u.status === "completed")).toBe(true);
    // The write surfaced with a location and the cat output carried the content.
    expect(JSON.stringify(toolUpdates)).toContain("marker.txt");
    expect(JSON.stringify(toolUpdates)).toContain("beacon");
  }, 300_000);

  it("forwards an ACP image through Muse's native vision path", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "muse-image-integration-xdg-"));
    const testClient = connectTestClient({
      env: { ...process.env, XDG_DATA_HOME: xdg },
    });
    const ctx = await initialized(testClient);
    const cwd = mkdtempSync(join(tmpdir(), "muse-image-integration-cwd-"));
    const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "low",
    });

    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data: CAT_IMAGE_BASE64, mimeType: "image/png" },
        {
          type: "text",
          text: "Read the single uppercase word in the attached image. Reply with only that word.",
        },
      ],
    });

    expect(response.stopReason).toBe("end_turn");
    const text = testClient.updates
      .map((update) => update.update)
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.content.type === "text" ? update.content.text : ""))
      .join("");
    expect(text.toUpperCase()).toContain("CAT");
  }, 300_000);
});
