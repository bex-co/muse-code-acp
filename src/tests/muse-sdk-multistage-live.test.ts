/**
 * Real-host proof for w2/m1: a compound shell command whose approval has more
 * than one unresolved stage must ask once per stage and then actually run.
 *
 * This is the case that hung on Muse 1.2.1 (see the milestone's "Issue cause").
 * Every assertion is bounded, so a regression fails here instead of waiting.
 */
import { methods, type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { museCliPath } from "../muse-cli.js";
import { connectTestClient, initialized, museAvailable } from "./helpers.js";
import { startLoopbackProvider } from "./loopback-provider.js";

const serveHelp =
  museAvailable() && spawnSync(museCliPath(), ["serve", "--help"], { encoding: "utf8" });
const museReady = Boolean(serveHelp && serveHelp.status === 0);

function liveEnv(provider: { home: string; root: string }) {
  return {
    HOME: provider.home,
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: join(provider.root, "config"),
    XDG_DATA_HOME: join(provider.root, "data"),
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
    MUSE_CODE_ACP_BACKEND: "sdk",
  };
}

/** Stage index of the requirement an ACP permission request is asking about. */
function stageOf(request: RequestPermissionRequest): number {
  const requirement = request._meta?.museRequirementId as { sourceIndex: number } | undefined;
  expect(requirement, `no museRequirementId on ${JSON.stringify(request._meta)}`).toBeTruthy();
  return requirement!.sourceIndex;
}

function optionOfKind(request: RequestPermissionRequest, kind: string): string {
  const option = request.options.find((candidate) => candidate.kind === kind);
  expect(option, `no ${kind} among ${JSON.stringify(request.options)}`).toBeTruthy();
  return option!.optionId;
}

interface Scenario {
  /** Files the command writes, in stage order. */
  markers: string[];
  command: (cwd: string) => string;
}

const SCENARIOS: Record<"two" | "three", Scenario> = {
  // `ls` and `cat` resolve as known-safe, so only the redirects need decisions.
  two: {
    markers: ["a.txt", "b.txt"],
    command: (cwd) =>
      `echo one > ${cwd}/a.txt; ls ${cwd}; echo two > ${cwd}/b.txt; cat ${cwd}/a.txt`,
  },
  three: {
    markers: ["a.txt", "b.txt", "c.txt"],
    command: (cwd) => `echo one > ${cwd}/a.txt; echo two > ${cwd}/b.txt; echo three > ${cwd}/c.txt`,
  },
};

async function runScenario(
  scenario: Scenario,
  decide: (request: RequestPermissionRequest, index: number) => string,
  extended = false,
) {
  const provider = await startLoopbackProvider({
    scriptedToolCallWhen: ["a.txt", `"bash"`],
    scriptedToolCallCommand: "unused",
    replyText: "done",
    holdMs: 1_500,
    scriptedToolCallForRequest: (request) => {
      const body = JSON.stringify(request);
      // Script the compound call once: after it lands, its id is in the history.
      if (!body.includes("a.txt") || body.includes("call_1")) return undefined;
      return {
        name: "bash",
        arguments: { command, description: "Run the compound command" },
      };
    },
  });
  const cwd = join(provider.root, "workspace");
  mkdirSync(cwd);
  const command = scenario.command(cwd);
  const client = connectTestClient({ env: liveEnv(provider) });
  const asked: number[] = [];
  try {
    client.setPermissionResponder((request) => {
      const index = asked.length;
      asked.push(stageOf(request));
      return { outcome: { outcome: "selected", optionId: decide(request, index) } };
    });
    const ctx = await initialized(client, extended ? { _meta: { "muse/approval": 1 } } : {});
    const { sessionId } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: `Create ${cwd}/a.txt and its siblings` }],
    });
    return {
      response,
      asked,
      exists: scenario.markers.map((marker) => existsSync(join(cwd, marker))),
      requests: client.permissionRequests,
      toolCalls: provider.scriptedToolCalls(),
    };
  } finally {
    await client.agent.dispose();
    await provider.close();
    await rm(provider.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("SDK live multi-stage approvals (real Muse host)", () => {
  it("requires a local muse serve host; skipping is not evidence", () => {
    expect(
      museReady,
      "muse serve must be installed; w2/m1 forbids treating a missing host as success",
    ).toBe(true);
  });

  it("allows both stages of a two-stage command and writes both files", async () => {
    expect(museReady).toBe(true);
    const result = await runScenario(SCENARIOS.two, (request) =>
      optionOfKind(request, "allow_once"),
    );
    expect(result.response).toEqual({ stopReason: "end_turn" });
    expect(result.asked).toHaveLength(2);
    // Distinct requirements, in source order: never the same stage twice.
    expect(result.asked[0]).toBeLessThan(result.asked[1]!);
    expect(result.exists).toEqual([true, true]);
    expect(result.requests.map((r) => r.toolCall.title)).toEqual([
      "Stage 1 of 4: echo one",
      "Stage 3 of 4: echo two",
    ]);
    expect(result.requests.every((r) => r._meta?.["muse/approval"] === undefined)).toBe(true);
    expect(result.toolCalls).toBe(1);
  }, 120_000);

  it("allows all three stages of a three-stage command", async () => {
    expect(museReady).toBe(true);
    const result = await runScenario(SCENARIOS.three, (request) =>
      optionOfKind(request, "allow_once"),
    );
    expect(result.response).toEqual({ stopReason: "end_turn" });
    expect(result.asked).toHaveLength(3);
    expect([...result.asked].sort((a, b) => a - b)).toEqual(result.asked);
    expect(new Set(result.asked).size).toBe(3);
    expect(result.exists).toEqual([true, true, true]);
    expect(result.requests.map((r) => r.toolCall.title)).toEqual([
      "Stage 1 of 3: echo one",
      "Stage 2 of 3: echo two",
      "Stage 3 of 3: echo three",
    ]);
    expect(new Set(result.requests.map((r) => r.toolCall.title)).size).toBe(3);
  }, 120_000);

  it("denies a later stage through a host-offered choice and writes nothing", async () => {
    expect(museReady).toBe(true);
    const result = await runScenario(SCENARIOS.two, (request, index) =>
      index === 0 ? optionOfKind(request, "allow_once") : optionOfKind(request, "reject_once"),
    );
    expect(result.response).toEqual({ stopReason: "end_turn" });
    expect(result.asked).toHaveLength(2);
    // The host aborts the whole pending action, so the allowed stage never runs.
    expect(result.exists).toEqual([false, false]);
  }, 120_000);

  it("reports each stage's refreshed evidence to a negotiating client", async () => {
    expect(museReady).toBe(true);
    const result = await runScenario(
      SCENARIOS.two,
      (request) => optionOfKind(request, "allow_once"),
      true,
    );
    const stages = result.requests.map(
      (request) =>
        (request._meta?.["muse/approval"] as { stages?: { resolutionKind: string }[] }).stages ??
        [],
    );
    expect(stages[0]!.some((stage) => stage.resolutionKind === "unresolved")).toBe(true);
    // The second ask reflects the first decision rather than the opening view.
    expect(stages[1]!.filter((stage) => stage.resolutionKind === "unresolved").length).toBeLessThan(
      stages[0]!.filter((stage) => stage.resolutionKind === "unresolved").length,
    );
  }, 120_000);
});
