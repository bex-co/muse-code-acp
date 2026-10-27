import {
  methods,
  type RequestPermissionResponse,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../session-store.js";
import { connectTestClient, fixturesDir, newTestSession } from "./helpers.js";

describe.each(["approval", "userInput"] as const)("close during %s", (mode) => {
  it.each(["closed", "resumed"] as const)("ignores replies arriving when %s", async (lateAt) => {
    const root = mkdtempSync(join(tmpdir(), "muse-close-input-"));
    const capture = join(root, "requests");
    const client = connectTestClient({
      backend: "sdk",
      museBinary: join(fixturesDir, "fake-msp.cjs"),
      skipSdkHostCheck: true,
      env: { ...process.env, XDG_DATA_HOME: root, FAKE_MSP_MODE: mode, FAKE_MSP_CAPTURE: capture },
    });
    const permissionGates = Array.from({ length: 3 }, () =>
      Promise.withResolvers<RequestPermissionResponse>(),
    );
    const inputGates = Array.from({ length: 3 }, () =>
      Promise.withResolvers<CreateElicitationResponse>(),
    );
    let permissionIndex = 0,
      inputIndex = 0;
    const oldReturned = Promise.withResolvers<void>();
    client.setPermissionResponder(async () => {
      const index = permissionIndex++;
      const response = await permissionGates[index]!.promise;
      if (index === 0) oldReturned.resolve();
      return response;
    });
    client.setElicitationResponder(async () => {
      const index = inputIndex++;
      const response = await inputGates[index]!.promise;
      if (index === 0) oldReturned.resolve();
      return response;
    });
    const count = () => (mode === "approval" ? permissionIndex : inputIndex);
    const release = (index: number, stale: boolean) => {
      if (mode === "approval")
        permissionGates[index]!.resolve({
          outcome: { outcome: "selected", optionId: stale ? "allow-once" : "deny-once" },
        });
      else
        inputGates[index]!.resolve({ action: "accept", content: { q1: stale ? "red" : "blue" } });
    };
    const { ctx, sessionId, cwd } = await newTestSession(client, { elicitation: { form: {} } });
    const list = vi
      .spyOn(store, "listStoredSessions")
      .mockReturnValue([{ sessionId, cwd, title: "", updatedAt: "", logPath: "unused" }]);
    const prompt = (id: string) =>
      ctx.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "need interaction" }],
      });
    try {
      const first = prompt(sessionId);
      await expect.poll(count).toBe(1);
      await expect(ctx.request(methods.agent.session.close, { sessionId })).resolves.toEqual({});
      await expect(first).resolves.toEqual({ stopReason: "cancelled" });
      if (lateAt === "closed") {
        release(0, true);
        await oldReturned.promise;
      }
      await ctx.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
      const other = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      let resumedSettled = false;
      const resumed = prompt(sessionId).then((r) => {
        resumedSettled = true;
        return r;
      });
      await expect.poll(count).toBe(2);
      const unrelated = prompt(other.sessionId);
      await expect.poll(count).toBe(3);
      if (lateAt === "resumed") {
        release(0, true);
        await oldReturned.promise;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resumedSettled).toBe(false);
      release(1, false);
      release(2, false);
      await expect(resumed).resolves.toEqual({ stopReason: "end_turn" });
      await expect(unrelated).resolves.toEqual({ stopReason: "end_turn" });
      const requests = readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (mode === "approval") {
        const decisions = requests.filter((r) => r.method === "approval/decide");
        expect(decisions).toHaveLength(2);
        expect(decisions.every((r) => r.params.choiceId === "deny-once")).toBe(true);
      } else {
        const answers = requests.filter((r) => r.method === "userInput/answer");
        expect(answers).toHaveLength(2);
        expect(answers.map((r) => r.params.answers)).toEqual([
          [{ questionId: "q1", selectedLabel: "blue" }],
          [{ questionId: "q1", selectedLabel: "blue" }],
        ]);
      }
    } finally {
      for (let i = 0; i < 3; i++) release(i, false);
      await client.agent.dispose();
      list.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
