import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { startLoopbackProvider } from "./loopback-provider.js";

it("settles reminder and reviewer requests without spending the scripted tool call", async () => {
  const provider = await startLoopbackProvider({
    scriptedToolCallWhen: ["marker"],
    scriptedToolCallCommand: "printf marker",
    holdMs: 1,
  });
  try {
    const post = async (name: string) =>
      (
        await fetch(`${provider.baseUrl}/responses`, {
          method: "POST",
          body: JSON.stringify({
            input: "marker",
            tools: [{ type: "namespace", name: "muse", tools: [{ type: "function", name }] }],
          }),
        })
      ).text();
    const reminder = await post("submit_reminder_decision");
    expect(reminder).toContain('"name":"submit_reminder_decision"');
    expect(reminder).toContain('\\"decision\\":\\"none\\"');
    const review = await post("submit_approval_assessment");
    expect(review).toContain('"name":"submit_approval_assessment"');
    expect(review).toContain('\\"outcome\\":\\"approve\\"');
    expect(provider.scriptedToolCalls()).toBe(0);
    expect(await post("bash")).toContain("function_call_arguments.done");
    expect(provider.scriptedToolCalls()).toBe(1);
  } finally {
    await provider.close();
    rmSync(provider.root, { recursive: true, force: true });
  }
});
