import { expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { connectTestClient, initialized } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

it("reports root usage, public summaries and restored status without another model call", async () => {
  const provider = await startLoopbackProvider({
    scriptedToolCallWhen: ["unused"],
    scriptedToolCallCommand: "",
    holdMs: 20,
    publicSummary: "Public summary marker",
  });
  const client = connectTestClient({
    backend: "sdk",
    env: {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    },
  });
  try {
    const ctx = await initialized(client, { _meta: { "muse/usage": 1 } });
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: provider.root,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/status" }],
    });
    expect(provider.requests()).toHaveLength(0);
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "progress root marker" }],
    });
    const usage = () =>
      client.updates.flatMap((n) =>
        n.update.sessionUpdate === "session_info_update" && n.update._meta?.["muse/usage"]
          ? [n.update._meta["muse/usage"]]
          : [],
      );
    expect(usage().length).toBeGreaterThan(0);
    const lastUsage = usage().at(-1);
    const summaries = client.updates
      .flatMap((n) =>
        n.update.sessionUpdate === "agent_thought_chunk" && n.update.content.type === "text"
          ? [n.update.content.text]
          : [],
      )
      .join("");
    expect(summaries).toBe("Public summary marker");
    const before = provider.requests().length;
    await ctx.request(methods.agent.session.close, { sessionId });
    await ctx.request(methods.agent.session.load, {
      sessionId,
      cwd: provider.root,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/status" }],
    });
    expect(provider.requests()).toHaveLength(before);
    expect(usage().at(-1)).toEqual(lastUsage);
    expect(JSON.stringify(client.updates.at(-1))).not.toContain("total unknown");
  } finally {
    await client.agent.dispose();
    await provider.close();
    await rm(provider.root, { recursive: true, force: true });
  }
}, 60_000);

it("renders native todo create/modify/complete/clear and restores the latest snapshot", async () => {
  const fired = new Set<string>();
  const provider = await startLoopbackProvider({
    scriptedToolCallWhen: ["todo-live-marker"],
    scriptedToolCallCommand: "",
    holdMs: 20,
    scriptedToolCallForRequest: (r) => {
      const input = r.input as { role?: string; content?: unknown }[] | undefined;
      const marker = input
        ?.filter(
          (i) =>
            i.role === "user" &&
            typeof i.content === "string" &&
            i.content.startsWith("todo-live-marker:"),
        )
        .at(-1)?.content as string | undefined;
      if (!marker || fired.has(marker)) return;
      fired.add(marker);
      const state = marker.split(":")[1];
      return {
        name: "write_todos",
        arguments: {
          todos: state === "clear" ? [] : [{ text: "Observed todo marker", status: state }],
        },
      };
    },
  });
  const client = connectTestClient({
    backend: "sdk",
    env: {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    },
  });
  try {
    const ctx = await initialized(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: provider.root,
      mcpServers: [],
    });
    const plans = () =>
      client.updates.flatMap((n) => (n.update.sessionUpdate === "plan" ? [n.update.entries] : []));
    for (const state of ["pending", "in_progress", "completed", "clear"]) {
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: `todo-live-marker:${state}` }],
      });
      expect(plans().at(-1)).toEqual(
        state === "clear"
          ? []
          : [{ content: "Observed todo marker", priority: "medium", status: state }],
      );
      if (state === "in_progress") {
        const count = provider.requests().length;
        await ctx.request(methods.agent.session.close, { sessionId });
        await ctx.request(methods.agent.session.load, {
          sessionId,
          cwd: provider.root,
          mcpServers: [],
        });
        expect(plans().at(-1)?.[0]!.status).toBe("in_progress");
        expect(provider.requests()).toHaveLength(count);
      }
    }
  } finally {
    await client.agent.dispose();
    await provider.close();
    await rm(provider.root, { recursive: true, force: true });
  }
}, 60_000);

it("streams correlated shell output before completion with a bounded final snapshot", async () => {
  const provider = await startLoopbackProvider({
    scriptedToolCallWhen: ["stream-output-marker"],
    scriptedToolCallCommand: "printf first-output; sleep 2; printf second-output",
    holdMs: 20,
  });
  const client = connectTestClient({
    backend: "sdk",
    env: {
      PATH: process.env.PATH,
      HOME: provider.home,
      XDG_CONFIG_HOME: join(provider.root, "config"),
      XDG_DATA_HOME: join(provider.root, "data"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    },
  });
  client.setPermissionResponder((params) => ({
    outcome: {
      outcome: "selected",
      optionId: params.options.find((o) => o.kind === "allow_once")!.optionId,
    },
  }));
  try {
    const ctx = await initialized(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: provider.root,
      mcpServers: [],
    });
    const prompt = ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "stream-output-marker" }],
    });
    const done = expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect
      .poll(
        () =>
          client.updates.some(
            (n) =>
              (n.update.sessionUpdate === "tool_call" ||
                n.update.sessionUpdate === "tool_call_update") &&
              n.update.status === "in_progress" &&
              JSON.stringify(n.update.content).includes("first-output"),
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await done;
    const tools = client.updates.flatMap((n) =>
      n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update"
        ? n.update.name === "bash"
          ? [n.update]
          : []
        : [],
    );
    expect(new Set(tools.map((t) => t.toolCallId)).size).toBe(1);
    expect(JSON.stringify(tools.at(-1)?.content)).toContain("second-output");
  } finally {
    await client.agent.dispose();
    await provider.close();
    await rm(provider.root, { recursive: true, force: true });
  }
}, 30000);
