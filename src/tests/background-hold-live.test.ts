import { methods, type SessionNotification } from "@agentclientprotocol/sdk";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectTestClient, hostSupports, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const available = museAvailable();
if (!available && process.env.MUSE_CODE_ACP_REQUIRE_MUSE === "1")
  throw new Error("Muse required for the held-prompt acceptance");

const REPORT = "wake-report-marker";

type Provider = Awaited<ReturnType<typeof startLoopbackProvider>>;
const env = (p: Provider) => ({
  PATH: process.env.PATH,
  MUSE_CODE_EXECUTABLE: process.env.MUSE_CODE_EXECUTABLE,
  HOME: p.home,
  XDG_CONFIG_HOME: join(p.root, "config"),
  XDG_DATA_HOME: join(p.root, "data"),
  TBH_CREDENTIAL_BACKEND: "file",
  TBH_DISABLE_TELEMETRY: "1",
});

/**
 * One prompt whose model call starts background work and ends its turn. The
 * held prompt must resolve only after that work finished and Muse's own
 * reporting turn streamed its answer into it.
 */
async function heldPrompt(p: Provider, marker: string, card: (u: SessionNotification) => boolean) {
  const client = connectTestClient({ backend: "sdk", env: env(p) });
  client.setPermissionResponder((r) => ({
    outcome: {
      outcome: "selected",
      optionId: r.options.find((c) => c.kind === "allow_once")!.optionId,
    },
  }));
  try {
    const ctx = await initialized(client, {
      _meta: { "muse/backgroundHold": 1, "muse/asyncTasks": 1 },
    });
    const { sessionId } = await ctx.request(methods.agent.session.new, {
      cwd: p.root,
      mcpServers: [],
    });
    // Muse refuses workflow children on the loopback default effort (`none`).
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoningEffort",
      value: "medium",
    });
    let resolvedAt = -1;
    const response = await ctx
      .request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: marker }],
      })
      .finally(() => (resolvedAt = client.updates.length));
    const updates = client.updates.slice(0, resolvedAt);
    const cards = updates.flatMap((n, index) => (card(n) ? [{ index, update: n.update }] : []));
    const status = (u: SessionNotification["update"]) =>
      "status" in u ? (u.status ?? undefined) : undefined;
    const running = cards.find((c) => status(c.update) === "in_progress");
    const finished = cards.find((c) => status(c.update) === "completed");
    // The foreground turn may answer with the same text; the report follows the work.
    const report = updates.findIndex(
      ({ update }, index) =>
        index > (finished?.index ?? updates.length) &&
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text" &&
        update.content.text.includes(REPORT),
    );
    return {
      response,
      running: running?.index ?? -1,
      finished: finished?.index ?? -1,
      report,
      unknown: JSON.stringify(client.updates).includes("outcome is unknown"),
      hostOpen: client.agent.sessions.get(sessionId)?.sdkHost?.owner.closed === false,
    };
  } finally {
    await client.agent.dispose();
  }
}

describe.skipIf(!available || !hostSupports("background-wakes"))(
  "real Muse held prompt (muse/backgroundHold)",
  () => {
    it("holds the prompt across a workflow until Muse's reporting turn has answered", async () => {
      const fired = new Set<string>();
      const p = await startLoopbackProvider({
        scriptedToolCallWhen: [],
        scriptedToolCallCommand: "",
        replyText: REPORT,
        scriptedToolCallForRequest: (r) => {
          const last = JSON.stringify((r.input as unknown[]).at(-1));
          if (!last.includes("held-workflow-marker") || fired.has("workflow")) return;
          fired.add("workflow");
          return {
            name: "workflow",
            arguments: {
              name: "held",
              script:
                'export default async function workflow(host) { return await host.agent({input:"held-child-marker"}); }',
            },
          };
        },
        // Hold only the workflow child's own model requests, so the workflow is
        // still running when the foreground turn ends. The reporting turn's
        // history quotes the launch result; the child's input does not.
        holdMsForRequest: (r) => {
          const body = JSON.stringify(r.input);
          const tools = JSON.stringify(r.tools ?? []);
          return body.includes("held-child-marker") &&
            !body.includes("Workflow launched") &&
            !tools.includes("submit_reminder_decision") &&
            !tools.includes("submit_approval_assessment")
            ? 1500
            : 20;
        },
      });
      try {
        const run = await heldPrompt(
          p,
          "held-workflow-marker go",
          ({ update }) =>
            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
            (update._meta?.["muse/asyncTasks"] as { kind?: string } | undefined)?.kind ===
              "workflow",
        );
        expect(run.response).toEqual({ stopReason: "end_turn" });
        // Running, then finished, then reported: all before the prompt resolved.
        expect(run.running).toBeGreaterThanOrEqual(0);
        expect(run.finished).toBeGreaterThan(run.running);
        expect(run.report).toBeGreaterThan(run.finished);
        expect(run.unknown).toBe(false);
        expect(run.hostOpen).toBe(true);
      } finally {
        await p.close();
        await rm(p.root, { recursive: true, force: true });
      }
    }, 90_000);

    it("holds the prompt across a command Muse sent to the background", async () => {
      const p = await startLoopbackProvider({
        scriptedToolCallWhen: ["held-bash-marker"],
        scriptedToolCallCommand: "",
        replyText: REPORT,
        scriptedToolCall: {
          name: "bash",
          arguments: {
            command: "sleep 3; printf held-background-finished",
            description: "Run past the yield",
            yield_time_ms: 1,
          },
        },
        holdMs: 20,
      });
      try {
        const run = await heldPrompt(
          p,
          "held-bash-marker",
          ({ update }) =>
            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
            JSON.stringify(update).includes("sleep 3"),
        );
        expect(run.response).toEqual({ stopReason: "end_turn" });
        expect(run.running).toBeGreaterThanOrEqual(0);
        expect(run.finished).toBeGreaterThan(run.running);
        expect(run.report).toBeGreaterThan(run.finished);
        expect(run.unknown).toBe(false);
        expect(run.hostOpen).toBe(true);
      } finally {
        await p.close();
        await rm(p.root, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
