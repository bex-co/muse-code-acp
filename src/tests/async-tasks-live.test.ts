import { expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { museCliPath } from "../muse-cli.js";
import { connectTestClient, initialized } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";
const env = (p: Awaited<ReturnType<typeof startLoopbackProvider>>) => ({
  PATH: process.env.PATH,
  MUSE_CODE_EXECUTABLE: process.env.MUSE_CODE_EXECUTABLE,
  HOME: p.home,
  XDG_CONFIG_HOME: join(p.root, "config"),
  XDG_DATA_HOME: join(p.root, "data"),
  TBH_CREDENTIAL_BACKEND: "file",
  TBH_DISABLE_TELEMETRY: "1",
});

it("keeps background output alive past prompt completion and ends one original task card", async () => {
  const p = await startLoopbackProvider({
    scriptedToolCallWhen: ["background-contract-marker"],
    scriptedToolCallCommand: "",
    scriptedToolCall: {
      name: "bash",
      arguments: {
        command: "sleep 3; printf background-finished",
        description: "Verify background lifecycle",
        yield_time_ms: 1,
      },
    },
    holdMs: 20,
  });
  const client = connectTestClient({ backend: "sdk", env: env(p) });
  client.setPermissionResponder((r) => ({
    outcome: {
      outcome: "selected",
      optionId: r.options.find((c) => c.kind === "allow_once")!.optionId,
    },
  }));
  try {
    const ctx = await initialized(client);
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: p.root,
      mcpServers: [],
    });
    expect(
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "background-contract-marker" }],
      }),
    ).toMatchObject({ stopReason: "end_turn" });
    const cards = () =>
      client.updates.flatMap((n) =>
        (n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update") &&
        n.update.name === "bash"
          ? [n.update]
          : [],
      );
    expect(cards().at(-1)?.status).toBe("in_progress");
    await expect.poll(() => cards().at(-1)?.status, { timeout: 10000 }).toBe("completed");
    expect(JSON.stringify(cards().at(-1)?.content)).toContain("background-finished");
    expect(cards().filter((c) => c.status === "completed")).toHaveLength(1);
    expect(new Set(cards().map((c) => c.toolCallId)).size).toBe(1);
    await ctx.request(methods.agent.session.close, { sessionId });
    await ctx.request(methods.agent.session.load, { sessionId, cwd: p.root, mcpServers: [] });
    expect(client.updates.some((n) => JSON.stringify(n.update).includes("reminderChild"))).toBe(
      true,
    );
  } finally {
    await client.agent.dispose();
    await p.close();
    await rm(p.root, { recursive: true, force: true });
  }
}, 30000);

it("cancels only an observed workflow and rejects stale host targets", async () => {
  const fired = new Set<string>();
  const p = await startLoopbackProvider({
    scriptedToolCallWhen: ["workflow-control-marker"],
    scriptedToolCallCommand: "",
    scriptedToolCallForRequest: (r) => {
      const last = (r.input as { role?: string; content?: unknown }[])
        ?.filter((i) => i.role === "user")
        .at(-1)?.content;
      if (
        typeof last !== "string" ||
        !last.startsWith("workflow-control-marker") ||
        fired.has(last)
      )
        return;
      fired.add(last);
      return {
        name: "workflow",
        arguments: {
          script:
            'export default async function workflow(host) { return await host.agent({input:"slow-child-control-marker"}); }',
        },
      };
    },
    holdMsForRequest: (r) => {
      const last = (r.input as { role?: string; content?: unknown }[])
        ?.filter((i) => i.role === "user")
        .at(-1)?.content;
      return typeof last === "string" &&
        last.includes("slow-child-control-marker") &&
        !last.startsWith("You are a reminder observer")
        ? 12000
        : 20;
    },
  });
  const client = connectTestClient({ backend: "sdk", env: env(p) });
  try {
    const ctx = await initialized(client, { _meta: { "muse/asyncTasks": 1 } });
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: p.root,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "workflow-control-marker one" }],
    });
    const cards = () =>
      client.updates.flatMap((n) =>
        (n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update") &&
        (n.update._meta?.["muse/asyncTasks"] as { kind?: string } | undefined)?.kind === "workflow"
          ? [n.update]
          : [],
      );
    // Workflow cancellation is verified on 1.2.1 and 1.3.0 (WORKFLOW_CANCEL_HOSTS).
    if (
      !/\b1\.(2\.1|3\.0)\b/.test(
        spawnSync(museCliPath(), ["--version"], { encoding: "utf8" }).stdout,
      )
    ) {
      expect(
        client.updates.some(
          (n) =>
            (n.update.sessionUpdate === "tool_call" ||
              n.update.sessionUpdate === "tool_call_update") &&
            n.update.name === "workflow",
        ),
      ).toBe(true);
      expect(cards()).toEqual([]);
      return;
    }
    await expect
      .poll(() => cards().some((c) => c.status === "in_progress"), { timeout: 10000 })
      .toBe(true);
    const card = cards().find((c) => c.status === "in_progress")!;
    const meta = card._meta?.["muse/asyncTasks"] as { target: string; actions: string[] };
    expect(meta.actions).toContain("cancel");
    const other = await ctx.request(methods.agent.session.new, { cwd: p.root, mcpServers: [] });
    await ctx.request(methods.agent.session.prompt, {
      sessionId: other.sessionId,
      prompt: [{ type: "text", text: "workflow-control-marker two" }],
    });
    const siblingId = cards().find((c) => c.toolCallId !== card.toolCallId)?.toolCallId;
    expect(siblingId).toBeTruthy();
    await expect(
      ctx.request("_muse/task", {
        sessionId: other.sessionId,
        target: meta.target,
        action: "cancel",
      }),
    ).rejects.toMatchObject({ code: -32600 });
    expect(
      await ctx.request("_muse/task", { sessionId, target: meta.target, action: "cancel" }),
    ).toMatchObject({ status: "accepted" });
    await expect
      .poll(
        () =>
          cards()
            .filter((c) => c.toolCallId === card.toolCallId)
            .at(-1)?.status,
        { timeout: 10000 },
      )
      .toBe("failed");
    expect(
      JSON.stringify(
        cards()
          .filter((c) => c.toolCallId === card.toolCallId)
          .at(-1)?._meta,
      ),
    ).toContain("cancelled");
    expect(
      JSON.stringify(
        cards()
          .filter((c) => c.toolCallId === siblingId)
          .at(-1)?._meta,
      ),
    ).not.toContain("cancelled");
    await ctx.request(methods.agent.session.close, { sessionId });
    await ctx.request(methods.agent.session.load, { sessionId, cwd: p.root, mcpServers: [] });
    await expect(
      ctx.request("_muse/task", { sessionId, target: meta.target, action: "cancel" }),
    ).rejects.toMatchObject({ code: -32600 });
  } finally {
    await client.agent.dispose();
    await p.close();
    await rm(p.root, { recursive: true, force: true });
  }
}, 40000);

it("reports unresolved background work as unknown when its host closes", async () => {
  const p = await startLoopbackProvider({
    scriptedToolCallWhen: ["lost-background-marker"],
    scriptedToolCallCommand: "",
    scriptedToolCall: {
      name: "bash",
      arguments: {
        command: "sleep 10; printf later",
        description: "Verify lost observation",
        yield_time_ms: 1,
      },
    },
    holdMs: 20,
  });
  const client = connectTestClient({ backend: "sdk", env: env(p) });
  client.setPermissionResponder((r) => ({
    outcome: {
      outcome: "selected",
      optionId: r.options.find((c) => c.kind === "allow_once")!.optionId,
    },
  }));
  try {
    const ctx = await initialized(client, { _meta: { "muse/asyncTasks": 1 } });
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: p.root,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "lost-background-marker" }],
    });
    await client.agent.sessions.get(sessionId)!.sdkHost!.owner.close();
    await ctx.request(methods.agent.session.close, { sessionId });
    expect(
      client.updates.some(
        (n) =>
          n.update._meta?.["muse/asyncTasks"] &&
          JSON.stringify(n.update).includes('"outcome":"unknown"'),
      ),
    ).toBe(true);
    const count = client.updates.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(client.updates).toHaveLength(count);
  } finally {
    await client.agent.dispose();
    await p.close();
    await rm(p.root, { recursive: true, force: true });
  }
}, 30000);
